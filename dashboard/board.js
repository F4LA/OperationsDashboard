/**
 * Operations Dashboard — Sprint Board (View 1 + 3, spec §6)
 *
 * Owns the whole visible board after app.js's bootstrap hands it the initial
 * ingredients via mount(). From then on this module is the one place that
 * decides when liveMode/metrics get recomputed and what gets repainted.
 *
 * Mark-a-task flow (the hot path):
 *   pick a status in the dropdown → postEvent("setStatus", …) → on success,
 *   patch currentState for JUST that task (no refetch) → re-run liveMode +
 *   metrics → repaint that one task row + its Rock's progress bar/chip + the
 *   sprint-wide summary. Every other row keeps its last-rendered dates until
 *   the next mark or Refresh — a deliberate scope limit (not a full
 *   re-render), see the Phase 4 report.
 *
 * Refresh flow: full Events refetch → refold → liveMode + metrics → re-render
 * everything. People is NOT re-fetched on Refresh (only at initial mount) —
 * per the literal Phase 4 instructions; flagged in the report.
 *
 * The frozen plan-mode baseline (for §5.2's planned curve) is computed exactly
 * once by app.js and never touched here — see metrics.js's header.
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Module state
   * ------------------------------------------------------------------ */

  var state = {
    plan: null,
    index: null,          // OpsDashValidate.buildIndex(plan)
    frozenPlan: null,      // planMode() result — computed ONCE by app.js, never here
    currentState: {},      // D-027 map, patched incrementally after each mark
    deliverables: {},      // {taskId: url}
    people: [],            // [{name, active}]
    actor: null,
    band: 1,
    onlyMine: false,
    liveResult: null,
    metrics: null
  };

  var dom = {};            // cached DOM refs, filled in mount()
  var STATUS_ORDER = ["open", "in_progress", "done"];
  var STATUS_LABEL = { open: "Open", in_progress: "In progress", done: "Done" };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function pct(n) {
    return Math.round(n * 1000) / 10; // one decimal, e.g. 4.9
  }

  function isLikelyUrl(v) {
    return /^https?:\/\/[^\s]+$/i.test(String(v || "").trim());
  }

  function CFG() {
    var cfg = root.OpsDashConfig;
    if (!cfg) throw new Error("OpsDashBoard requires OpsDashConfig to be loaded first.");
    return cfg;
  }

  /* ------------------------------------------------------------------ *
   * Toasts (reuses the .toast-container / .toast classes)
   * ------------------------------------------------------------------ */

  function toast(message, kind) {
    if (!dom.toastContainer) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " toast-" + kind : "");
    el.textContent = message;
    dom.toastContainer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, kind === "error" ? 6000 : 3500);
  }

  function describeWriteError(result) {
    if (!result) return "Unknown error.";
    if (result.code && result.message) return result.message; // server's own readable message
    switch (result.error) {
      case "VERIFY_TIMEOUT":
        return "The write did not show up after checking — it may not have saved. Try again.";
      case "VERIFY_READ_FAILED":
        return "Could not confirm the write (read failed: " + (result.detail || "") + "). Try again.";
      case "POST_FAILED":
        return "Could not reach the server (" + (result.detail || "") + "). Try again.";
      default:
        return result.message || result.error || "Unknown error.";
    }
  }

  /* ------------------------------------------------------------------ *
   * Recompute (liveMode + metrics) — the one place both get re-run
   * ------------------------------------------------------------------ */

  function recompute() {
    state.liveResult = root.OpsDashEngine.liveMode(state.plan, state.currentState, CFG().todayISO());
    state.metrics = root.OpsDashMetrics.computeAll(
      state.plan, state.frozenPlan, state.currentState, CFG().todayISO(), state.band
    );
  }

  /* ------------------------------------------------------------------ *
   * Rendering — topbar (actor / refresh) and summary bar (sprint progress)
   * ------------------------------------------------------------------ */

  function renderTopbarRight() {
    var options = ['<option value="">— Select —</option>'];
    for (var i = 0; i < state.people.length; i++) {
      var p = state.people[i];
      var selected = state.actor === p.name ? " selected" : "";
      options.push('<option value="' + escapeAttr(p.name) + '"' + selected + '>' +
        escapeHtml(p.name) + "</option>");
    }

    dom.topbarRight.innerHTML =
      '<div class="actor-select-wrap">' +
        '<label for="actor-select">Acting as</label>' +
        '<select id="actor-select" class="actor-select">' + options.join("") + "</select>" +
      "</div>" +
      '<label class="only-mine-toggle">' +
        '<input type="checkbox" id="only-mine-checkbox"' + (state.onlyMine ? " checked" : "") + " />" +
        " Only my tasks" +
      "</label>" +
      '<button type="button" class="btn btn-secondary" id="refresh-btn">⟳ Refresh</button>';

    document.getElementById("actor-select").addEventListener("change", onActorChange);
    document.getElementById("only-mine-checkbox").addEventListener("change", onOnlyMineToggle);
    document.getElementById("refresh-btn").addEventListener("click", onRefreshClick);
  }

  function chipHtml(color, label) {
    return '<span class="chip chip-' + color + '">' + escapeHtml(label) + "</span>";
  }

  /**
   * Shared overshoot indicator (redesign pass) — a small focusable flag with a
   * custom popover (dark-navy, matching the toast style), replacing the old
   * native title="" tooltip on both the Rock-level and milestone-level
   * overshoot markers so the two read as one consistent pattern. Day count is
   * a calendar-date diff for display only — same parseISO the engine and
   * metrics.js already use, no new date semantics.
   */
  var overshootIdSeq = 0;

  function overshootFlagHtml(plannedFinish, sprintEnd) {
    var parseISO = root.OpsDashEngine._internals.parseISO;
    var days = Math.round((parseISO(plannedFinish) - parseISO(sprintEnd)) / 86400000);
    var message = "Projected to finish " + plannedFinish + " — " + days +
      (days === 1 ? " day" : " days") + " past sprint end (" + sprintEnd +
      "). The engine reports reality; it doesn’t adjust to hide overshoot.";
    var popId = "overshoot-pop-" + (++overshootIdSeq);
    return (
      '<span class="overshoot-wrap">' +
        '<span class="overshoot-flag" tabindex="0" aria-label="Projected past sprint end" ' +
          'aria-describedby="' + popId + '">⚠</span>' +
        '<span class="overshoot-popover" id="' + popId + '" role="tooltip">' +
          escapeHtml(message) + "</span>" +
      "</span>"
    );
  }

  function onTrackLabel(color) {
    if (color === "green") return "On track";
    if (color === "amber") return "Slightly behind";
    return "Behind";
  }

  function renderSummaryBar() {
    var sprint = state.plan.sprint;
    var m = state.metrics.sprint;
    dom.summaryBar.innerHTML =
      '<div class="summary-left">' +
        '<span class="sprint-name">' + escapeHtml(sprint.name || sprint.id) + "</span>" +
        '<span class="sprint-dates">' + escapeHtml(sprint.start) + " – " + escapeHtml(sprint.end) + "</span>" +
        '<span class="overshoot-legend">⚠ = projected past sprint end</span>' +
      "</div>" +
      '<div class="summary-right">' +
        '<div class="progress-bar-wrap">' +
          '<div class="progress-bar-fill" style="width:' + pct(m.progress.pct) + '%"></div>' +
        "</div>" +
        '<span class="progress-pct">' + pct(m.progress.pct) + "%</span>" +
        chipHtml(m.onTrack.color, onTrackLabel(m.onTrack.color)) +
      "</div>";
  }

  /* ------------------------------------------------------------------ *
   * Rendering — Rock metrics sub-block (also used for the targeted patch
   * after a mark, so it must not depend on anything the mark handler lacks)
   * ------------------------------------------------------------------ */

  function renderRockMetrics(rockId) {
    var rock = index_findRock(rockId);
    var m = state.metrics.rocks[rockId];
    var live = state.liveResult.rocks[rockId];

    var finishHtml = "";
    if (live && live.plannedFinish) {
      finishHtml = '<span class="rock-finish">Projected finish: <strong>' +
        escapeHtml(live.plannedFinish) + "</strong></span>";
      if (live.red) {
        finishHtml += " " + overshootFlagHtml(live.plannedFinish, state.plan.sprint.end);
      }
    }

    var cuttableBadge = rock.cuttable
      ? '<span class="cuttable-badge" title="Informational only — cutting means regenerating the JSON without this Rock/Project (§7)">CUTTABLE</span>'
      : "";

    return (
      '<div class="rock-title">' +
        "<h2>" + escapeHtml(rock.id) + " · " + escapeHtml(rock.name) + "</h2>" +
        cuttableBadge +
      "</div>" +
      '<div class="rock-metrics">' +
        '<div class="progress-bar-wrap">' +
          '<div class="progress-bar-fill" style="width:' + pct(m.progress.pct) + '%"></div>' +
        "</div>" +
        '<span class="progress-pct">' + pct(m.progress.pct) + "%</span>" +
        chipHtml(m.onTrack.color, onTrackLabel(m.onTrack.color)) +
        finishHtml +
      "</div>"
    );
  }

  function patchRockMetrics(rockId) {
    var header = dom.mainEl.querySelector('.rock-section[data-rock-id="' + cssEscape(rockId) + '"] .rock-header');
    if (header) header.innerHTML = renderRockMetrics(rockId);
  }

  /* ------------------------------------------------------------------ *
   * Rendering — task row
   * ------------------------------------------------------------------ */

  function ownerLabel(task) {
    return task.owner; // "Brent" | "Bernardo" | "Both" — shown verbatim
  }

  function durationLabel(task) {
    var s = (task.workDays === 1 ? "1 day" : task.workDays + " days");
    if (task.waitDays > 0) {
      s += " + wait " + (task.waitDays === 1 ? "1 day" : task.waitDays + " days");
    }
    return s;
  }

  function typeBadgeHtml(task) {
    if (task.type === "meeting") return '<span class="type-badge type-meeting">MEETING</span>';
    if (task.type === "approval") return '<span class="type-badge type-approval">APPROVAL</span>';
    return "";
  }

  function crossBadgeHtml(task) {
    if (!task.crossDependsOn || !task.crossDependsOn.length) return "";
    var title = "Cross-dependency: " + task.crossDependsOn.join(", ");
    return '<span class="cross-badge" title="' + escapeAttr(title) + '">⇄</span>';
  }

  function taskDatesHtml(taskId, task) {
    if (task.deferred) {
      return '<span class="deferred-badge" title="Deferred: excluded from scheduling and progress (§4.2, §5.1)">DEFERRED</span>';
    }
    var live = state.liveResult.tasks[taskId];
    if (!live) {
      // Not scheduled (e.g. a dependency deadlock elsewhere) — say so plainly rather
      // than showing a blank date, per §7 ("do not silently proceed").
      return '<span class="finish-date finish-date-error" title="Engine could not schedule this task — see the board-level error banner">— no date —</span>';
    }
    var html = '<span class="finish-date">→ ' + escapeHtml(live.plannedFinish) + "</span>";
    if (live.clamped) {
      html += ' <span class="clamped-flag" title="This task\u2019s original ETA already passed; it is clamped to today because it is still in progress (D-029)">overdue</span>';
    }
    return html;
  }

  function statusCtrlHtml(taskId, task) {
    if (task.deferred) return ""; // deferred tasks are not scheduled — nothing to set
    var live = state.liveResult.tasks[taskId];
    var status = live ? live.status : "open";
    var options = STATUS_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" +
        escapeHtml(STATUS_LABEL[s]) + "</option>";
    }).join("");
    return '<select class="status-ctrl status-' + status +
      '" data-action="set-status" data-task-id="' + escapeAttr(taskId) +
      '" aria-label="Status for ' + escapeAttr(task.desc) + '">' +
      options + "</select>";
  }

  function deliverableHtml(taskId) {
    var url = state.deliverables[taskId];
    if (url) {
      return (
        '<div class="task-deliverable" data-task-id="' + escapeAttr(taskId) + '">' +
          '<a class="deliverable-link" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">Deliverable ↗</a>' +
          '<button type="button" class="deliverable-edit-btn" data-action="edit-deliverable" data-task-id="' +
            escapeAttr(taskId) + '" aria-label="Change the deliverable link" title="Change the link">✎</button>' +
        "</div>"
      );
    }
    return (
      '<div class="task-deliverable" data-task-id="' + escapeAttr(taskId) + '">' +
        '<input type="url" class="deliverable-input" data-task-id="' + escapeAttr(taskId) +
          '" aria-label="Deliverable link" placeholder="Paste Drive/GHL/PDF link…" />' +
        '<button type="button" class="deliverable-save-btn" data-action="save-deliverable" data-task-id="' +
          escapeAttr(taskId) + '">Save</button>' +
      "</div>"
    );
  }

  function renderTaskRow(taskId, task, milestoneId) {
    var rowClass = "task-row" + (task.deferred ? " is-deferred" : "");
    return (
      '<div class="' + rowClass + '" data-task-id="' + escapeAttr(taskId) +
        '" data-owner="' + escapeAttr(task.owner) + '" data-milestone-id="' + escapeAttr(milestoneId) + '">' +
        '<div class="task-status-cell">' + statusCtrlHtml(taskId, task) + "</div>" +
        '<div class="task-main">' +
          '<div class="task-desc">' + escapeHtml(task.desc) + "</div>" +
          '<div class="task-meta">' +
            '<span class="owner-pill">' + escapeHtml(ownerLabel(task)) + "</span>" +
            typeBadgeHtml(task) +
            crossBadgeHtml(task) +
            '<span class="duration">' + escapeHtml(durationLabel(task)) + "</span>" +
            taskDatesHtml(taskId, task) +
          "</div>" +
        "</div>" +
        deliverableHtml(taskId) +
      "</div>"
    );
  }

  function patchTaskRow(taskId) {
    var task = state.index.tasks[taskId];
    var milestoneId = state.index.milestoneOfTask[taskId];
    var old = dom.mainEl.querySelector('.task-row[data-task-id="' + cssEscape(taskId) + '"]');
    if (!old) return;
    var wrap = document.createElement("div");
    wrap.innerHTML = renderTaskRow(taskId, task, milestoneId);
    old.replaceWith(wrap.firstElementChild);
  }

  /* ------------------------------------------------------------------ *
   * Rendering — milestone group + Rock section
   * ------------------------------------------------------------------ */

  function milestoneIsDeferred(milestoneId) {
    var m = state.index.milestones[milestoneId];
    return !!(m && m.deferred === true);
  }

  function renderMilestone(milestoneId) {
    var milestone = state.index.milestones[milestoneId];
    var taskIds = state.index.tasksOfMilestone[milestoneId] || [];
    var visibleIds = taskIds.filter(taskPassesFilter);

    if (!visibleIds.length) return ""; // only-mine filter emptied this milestone

    var deferred = milestoneIsDeferred(milestoneId);
    var rowsHtml = visibleIds.map(function (taskId) {
      return renderTaskRow(taskId, state.index.tasks[taskId], milestoneId);
    }).join("");

    var live = state.liveResult.milestones[milestoneId];
    var finishHtml = "";
    if (!deferred && live && live.plannedFinish) {
      finishHtml = '<span class="milestone-finish">→ ' + escapeHtml(live.plannedFinish) + "</span>";
      if (live.red) finishHtml += " " + overshootFlagHtml(live.plannedFinish, state.plan.sprint.end);
    }

    return (
      '<div class="milestone-group' + (deferred ? " is-deferred" : "") + '" data-milestone-id="' +
        escapeAttr(milestoneId) + '">' +
        '<div class="milestone-header">' +
          '<span class="milestone-name">' + escapeHtml(milestoneId) + " · " + escapeHtml(milestone.name) + "</span>" +
          (deferred ? '<span class="deferred-badge">DEFERRED</span>' : finishHtml) +
        "</div>" +
        '<div class="milestone-tasks">' + rowsHtml + "</div>" +
      "</div>"
    );
  }

  /**
   * A light divider before each project's first milestone — NOT a collapsible
   * section, since §6 puts milestones directly inside a Rock ("Inside a Rock:
   * milestones as groups"), no Project level in the view. But §7 requires a
   * cuttable PROJECT to carry its own informational badge (Rock 3's P5 is
   * cuttable:true while its Rock, R3, is not) — this is the one place to put it.
   */
  function renderProjectDivider(project) {
    var badge = project.cuttable
      ? '<span class="cuttable-badge" title="Informational only — cutting means regenerating the JSON without this Rock/Project (§7)">CUTTABLE</span>'
      : "";
    return (
      '<div class="project-divider">' +
        '<span class="project-name">' + escapeHtml(project.id) + " · " + escapeHtml(project.name) + "</span>" +
        badge +
      "</div>"
    );
  }

  function renderRock(rockId) {
    var rock = index_findRock(rockId);
    var milestonesHtml = [];
    var anyVisible = false;

    for (var pi = 0; pi < rock.projects.length; pi++) {
      var project = rock.projects[pi];
      var projectMilestonesHtml = [];
      for (var mi = 0; mi < project.milestones.length; mi++) {
        var html = renderMilestone(project.milestones[mi].id);
        if (html) { anyVisible = true; projectMilestonesHtml.push(html); }
      }
      if (projectMilestonesHtml.length) {
        milestonesHtml.push(renderProjectDivider(project));
        milestonesHtml = milestonesHtml.concat(projectMilestonesHtml);
      }
    }

    var body = anyVisible
      ? milestonesHtml.join("")
      : '<p class="board-empty">No tasks for the selected filter in this Rock.</p>';

    return (
      '<section class="rock-section" data-rock-id="' + escapeAttr(rockId) + '">' +
        '<div class="rock-header">' + renderRockMetrics(rockId) + "</div>" +
        '<div class="rock-body">' + body + "</div>" +
      "</section>"
    );
  }

  function index_findRock(rockId) {
    for (var i = 0; i < state.plan.rocks.length; i++) {
      if (state.plan.rocks[i].id === rockId) return state.plan.rocks[i];
    }
    return null;
  }

  function taskPassesFilter(taskId) {
    if (!state.onlyMine || !state.actor) return true;
    var task = state.index.tasks[taskId];
    return task.owner === state.actor || task.owner === "Both";
  }

  /* ------------------------------------------------------------------ *
   * Full render
   * ------------------------------------------------------------------ */

  function render() {
    renderTopbarRight();
    renderSummaryBar();

    if (!state.liveResult.ok) {
      dom.mainEl.innerHTML =
        '<div class="error-state">' +
          "<h2>The engine could not schedule the plan</h2>" +
          "<p>" + state.liveResult.errors.map(function (e) { return escapeHtml(e.message); }).join("<br/>") + "</p>" +
        "</div>";
      return;
    }

    var html = [];
    for (var i = 0; i < state.plan.rocks.length; i++) {
      html.push(renderRock(state.plan.rocks[i].id));
    }
    dom.mainEl.innerHTML = html.join("");
  }

  /* ------------------------------------------------------------------ *
   * Event handlers
   * ------------------------------------------------------------------ */

  function requireActor() {
    if (state.actor) return true;
    toast("Select who you are (\u201cActing as\u201d) before marking tasks.", "error");
    return false;
  }

  function onActorChange(e) {
    var name = e.target.value || null;
    state.actor = name;
    if (name) localStorage.setItem(CFG().ACTOR_STORAGE_KEY, name);
    else localStorage.removeItem(CFG().ACTOR_STORAGE_KEY);
    render();
  }

  function onOnlyMineToggle(e) {
    state.onlyMine = !!e.target.checked;
    render();
  }

  function onRefreshClick() {
    var btn = document.getElementById("refresh-btn");
    if (btn) { btn.disabled = true; btn.textContent = "⟳ Refreshing…"; }

    root.OpsDashEvents.fetchEvents()
      .then(function (events) {
        var folded = root.OpsDashEvents.fold(events);
        state.currentState = root.OpsDashEvents.toCurrentState(folded);
        state.deliverables = root.OpsDashEvents.deliverables(folded);
        recompute();
        render();
        toast("Refreshed.", "success");
      })
      .catch(function (err) {
        toast("Refresh failed: " + err.message, "error");
      })
      .then(function () {
        var b = document.getElementById("refresh-btn");
        if (b) { b.disabled = false; b.textContent = "⟳ Refresh"; }
      });
  }

  /**
   * Direct-select control (redesign pass) \u2014 the chosen option IS the write,
   * no intermediate cycle state. `selectEl` is passed in because, unlike the
   * old button, a native <select> already shows the user's newly-picked
   * option the instant they pick it \u2014 so on any failure we must explicitly
   * revert both its value AND its status-* color class back to the
   * pre-change status, or the dropdown would keep showing an unsaved value
   * as if it had saved. The write itself (postEvent call + args) is
   * unchanged from the old click handler.
   */
  function onSetStatus(taskId, next, selectEl) {
    var task = state.index.tasks[taskId];
    var live = state.liveResult.tasks[taskId];
    var previous = live ? live.status : "open";

    if (!requireActor()) {
      selectEl.value = previous;
      return;
    }
    if (!task || task.deferred) { selectEl.value = previous; return; }

    selectEl.disabled = true;
    selectEl.className = "status-ctrl status-saving status-" + next;

    root.OpsDashEvents.postEvent("setStatus", taskId, next, state.actor, "")
      .then(function (result) {
        if (!result.ok) {
          toast("Could not mark \u201c" + task.desc + "\u201d as " + STATUS_LABEL[next] + ": " +
            describeWriteError(result), "error");
          selectEl.disabled = false;
          selectEl.className = "status-ctrl status-" + previous;
          selectEl.value = previous;
          return;
        }

        var when = (result.event && result.event.timestamp) || new Date().toISOString();
        state.currentState[taskId] = { status: next, statusChangedAt: when };
        recompute();

        var rockId = findRockOfTask(taskId);
        patchTaskRow(taskId);
        if (rockId) patchRockMetrics(rockId);
        renderSummaryBar();
      })
      .catch(function (err) {
        toast("Could not mark that task: " + err.message, "error");
        selectEl.disabled = false;
        selectEl.className = "status-ctrl status-" + previous;
        selectEl.value = previous;
      });
  }

  function findRockOfTask(taskId) {
    if (!state._rockOfTask) {
      state._rockOfTask = root.OpsDashMetrics.buildRockIndex(state.plan).taskRock;
    }
    return state._rockOfTask[taskId];
  }

  function onEditDeliverable(taskId) {
    var wrap = dom.mainEl.querySelector('.task-deliverable[data-task-id="' + cssEscape(taskId) + '"]');
    if (!wrap) return;
    var current = state.deliverables[taskId] || "";
    wrap.innerHTML =
      '<input type="url" class="deliverable-input" data-task-id="' + escapeAttr(taskId) +
        '" aria-label="Deliverable link" value="' + escapeAttr(current) + '" />' +
      '<button type="button" class="deliverable-save-btn" data-action="save-deliverable" data-task-id="' +
        escapeAttr(taskId) + '">Save</button>';
    var input = wrap.querySelector(".deliverable-input");
    input.focus();
    input.select();
  }

  function onSaveDeliverable(taskId) {
    if (!requireActor()) return;
    var wrap = dom.mainEl.querySelector('.task-deliverable[data-task-id="' + cssEscape(taskId) + '"]');
    if (!wrap) return;
    var input = wrap.querySelector(".deliverable-input");
    var url = (input.value || "").trim();

    if (!isLikelyUrl(url)) {
      toast("That doesn\u2019t look like an http(s) link.", "error");
      return;
    }

    var btn = wrap.querySelector(".deliverable-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

    root.OpsDashEvents.postEvent("setDeliverable", taskId, url, state.actor, "")
      .then(function (result) {
        if (!result.ok) {
          toast("Could not save the link: " + describeWriteError(result), "error");
          if (btn) { btn.disabled = false; btn.textContent = "Save"; }
          return;
        }
        state.deliverables[taskId] = url;
        wrap.outerHTML = deliverableHtml(taskId);
      })
      .catch(function (err) {
        toast("Could not save the link: " + err.message, "error");
        if (btn) { btn.disabled = false; btn.textContent = "Save"; }
      });
  }

  function cssEscape(s) {
    // Task/milestone ids are plan-controlled (alphanumeric + hyphen), but this
    // keeps the attribute selectors correct even if that ever changes.
    return String(s).replace(/(["\\])/g, "\\$1");
  }

  function onMainClick(e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var taskId = el.getAttribute("data-task-id");

    if (action === "edit-deliverable") onEditDeliverable(taskId);
    else if (action === "save-deliverable") onSaveDeliverable(taskId);
  }

  function onMainChange(e) {
    var el = e.target;
    if (!el || el.getAttribute("data-action") !== "set-status") return;
    onSetStatus(el.getAttribute("data-task-id"), el.value, el);
  }

  function onMainKeydown(e) {
    if (e.key !== "Enter") return;
    var el = e.target;
    if (el && el.classList && el.classList.contains("deliverable-input")) {
      e.preventDefault();
      onSaveDeliverable(el.getAttribute("data-task-id"));
    }
  }

  /* ------------------------------------------------------------------ *
   * mount — called once by app.js after bootstrap
   * ------------------------------------------------------------------ */

  /**
   * @param initial {
   *   plan, frozenPlan, currentState, deliverables, people, band
   * }
   */
  function mount(initial) {
    state.plan = initial.plan;
    state.index = root.OpsDashValidate.buildIndex(initial.plan);
    state.frozenPlan = initial.frozenPlan;
    state.currentState = initial.currentState || {};
    state.deliverables = initial.deliverables || {};
    state.people = initial.people || [];
    state.band = typeof initial.band === "number" ? initial.band : 1;
    state.onlyMine = false;

    var cfg = CFG();
    var stored = localStorage.getItem(cfg.ACTOR_STORAGE_KEY);
    var params = new URLSearchParams(window.location.search);
    var urlActor = params.get("actor");
    var candidate = urlActor || stored;
    var isKnownActive = state.people.some(function (p) { return p.name === candidate && p.active; });
    state.actor = isKnownActive ? candidate : null; // §7: stale/removed actor → unset, not an error
    if (urlActor && isKnownActive) localStorage.setItem(cfg.ACTOR_STORAGE_KEY, urlActor);

    dom.topbarRight = document.getElementById("board-topbar-right");
    dom.summaryBar = document.getElementById("board-summary-bar");
    dom.mainEl = document.getElementById("main");
    dom.toastContainer = document.getElementById("toast-container");

    dom.mainEl.addEventListener("click", onMainClick);
    dom.mainEl.addEventListener("change", onMainChange);
    dom.mainEl.addEventListener("keydown", onMainKeydown);

    recompute();
    render();
  }

  root.OpsDashBoard = {
    mount: mount,
    refresh: onRefreshClick,
    // exposed for tests / debugging — not part of the app's own control flow
    _internals: {
      getState: function () { return state; },
      recompute: recompute,
      render: render
    }
  };
})(typeof window !== "undefined" ? window : this);
