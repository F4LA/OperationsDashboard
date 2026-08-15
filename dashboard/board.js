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
 *   metrics → diffAndRepaint() (Part C, Phase 5). liveMode's reprojection is
 *   global — a cross-Rock dependency can move a task in a DIFFERENT Rock than
 *   the one just marked — so this compares every task/milestone/Rock's
 *   signature before vs. after and patches only what actually changed,
 *   instead of the Phase 4 version's "just this task's own Rock" shortcut
 *   (which left every downstream row showing a stale plannedFinish until the
 *   next Refresh — that was the Phase 5 bug report). A row whose deliverable
 *   box is open for editing is skipped so a patch can never clobber an
 *   in-progress paste; both burn-up charts always repaint (the sprint-wide
 *   one always, per-Rock ones only when that Rock's own signature moved).
 *
 * Refresh flow: full Events refetch → refold → liveMode + metrics → full
 * render() — deliberately NOT the diff path. Refresh is an explicit user
 * action re-syncing everything (not just liveResult but deliverables/People
 * too), and unlike a background mark there's no in-progress edit to protect
 * against — the person just clicked a button that says "Refresh".
 *
 * The frozen plan-mode baseline (for §5.2's planned curve) is computed exactly
 * once by app.js and never touched here — see metrics.js's header.
 *
 * Second view (Phase 8 part 2B, D-081e): the topbar segmented control's other
 * segment is "To-dos" (§11), an entirely independent module — dashboard/
 * todos.js, mounted separately by app.js. This module only decides WHICH
 * segment is active (state.view, persisted per D-062) and, when it is
 * "todos", hands #main to OpsDashTodos.render() instead of rendering the
 * Sprint Board itself. The old "This Week" view that used to live here
 * (Phase 7, §6.3) is retired, not ported — §11 supersedes it outright.
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
    pins: {},              // {taskId: isoMonday} — current pin per task (§3, §6.3)
    people: [],            // [{name, active}]
    actor: null,
    band: 1,
    onlyMine: false,
    liveResult: null,
    metrics: null,
    view: "board"           // "board" | "todos" (D-062, D-081e)
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
   * Diff-based repaint after a mark (Part C) — recompute() updates every
   * date in memory, but liveMode's reprojection is global (a cross-Rock
   * dependency can shift a task in a DIFFERENT Rock than the one just
   * marked), so "patch just the marked task's own Rock" understates what
   * actually changed. This walks every task/milestone/Rock, compares its
   * signature before vs. after, and patches only the ones that moved —
   * cheap because building a signature string is cheap, and it's still far
   * less work than a full innerHTML rebuild of the whole board.
   * ------------------------------------------------------------------ */

  function taskSig(t) {
    return t ? t.plannedFinish + "|" + !!t.clamped + "|" + t.status : null;
  }

  function milestoneSig(m) {
    return m ? m.plannedFinish + "|" + !!m.red : null;
  }

  function rockSig(rockMetrics, liveRock) {
    if (!rockMetrics) return null;
    var o = rockMetrics.onTrack;
    var p = rockMetrics.progress;
    return [
      p.done, p.total, o.planned, o.actual, o.gap, o.color,
      liveRock ? liveRock.plannedFinish : null, liveRock ? !!liveRock.red : null
    ].join("|");
  }

  function unionKeys(a, b) {
    var seen = {};
    var out = [];
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k) && !seen[k]) { seen[k] = true; out.push(k); }
    for (var k2 in b) if (Object.prototype.hasOwnProperty.call(b, k2) && !seen[k2]) { seen[k2] = true; out.push(k2); }
    return out;
  }

  /**
   * @param prevLiveResult  state.liveResult as it was BEFORE this mark's recompute()
   * @param prevMetrics     state.metrics as it was BEFORE this mark's recompute()
   */
  function diffAndRepaint(prevLiveResult, prevMetrics) {
    var taskIds = unionKeys(prevLiveResult.tasks, state.liveResult.tasks);
    for (var i = 0; i < taskIds.length; i++) {
      var id = taskIds[i];
      if (taskSig(prevLiveResult.tasks[id]) !== taskSig(state.liveResult.tasks[id])) {
        patchTaskRowSafely(id);
      }
    }

    var msIds = unionKeys(prevLiveResult.milestones, state.liveResult.milestones);
    for (var j = 0; j < msIds.length; j++) {
      var mid = msIds[j];
      if (milestoneSig(prevLiveResult.milestones[mid]) !== milestoneSig(state.liveResult.milestones[mid])) {
        patchMilestoneHeader(mid);
      }
    }

    var rockIds = getRockIndex().rockOrder;
    for (var k = 0; k < rockIds.length; k++) {
      var rid = rockIds[k];
      var before = rockSig(prevMetrics.rocks[rid], prevLiveResult.rocks[rid]);
      var after = rockSig(state.metrics.rocks[rid], state.liveResult.rocks[rid]);
      if (before !== after) patchRockMetrics(rid); // regenerates that Rock's burn-up chart too
    }

    // Sprint-wide always — the marked task always affects the sprint aggregate.
    renderSummaryBar();
    renderSprintBurnup();
  }

  /* ------------------------------------------------------------------ *
   * Rendering — topbar (actor / refresh) and summary bar (sprint progress)
   * ------------------------------------------------------------------ */

  /** Two-segment view toggle (D-062) — "the chosen option IS the write" in
   *  spirit, just for view state instead of a Sheet write: click sets state
   *  + localStorage, then a plain render() with no refetch (§6.3, D-062). */
  function viewSwitchHtml() {
    function btn(view, label) {
      var active = state.view === view;
      return '<button type="button" class="view-switch-btn' + (active ? " is-active" : "") +
        '" data-view="' + view + '" aria-pressed="' + active + '">' + escapeHtml(label) + "</button>";
    }
    return (
      '<div class="view-switch" role="group" aria-label="View">' +
        btn("board", "Sprint board") +
        btn("todos", "To-dos") +
      "</div>"
    );
  }

  function onViewSwitchClick(e) {
    var next = e.currentTarget.getAttribute("data-view");
    if (next === state.view) return;
    state.view = next;
    localStorage.setItem(CFG().VIEW_STORAGE_KEY, next);
    render(); // same in-memory state either way — no refetch (D-062)
  }

  function renderTopbarRight() {
    var options = ['<option value="">— Select —</option>'];
    for (var i = 0; i < state.people.length; i++) {
      var p = state.people[i];
      var selected = state.actor === p.name ? " selected" : "";
      options.push('<option value="' + escapeAttr(p.name) + '"' + selected + '>' +
        escapeHtml(p.name) + "</option>");
    }

    dom.topbarRight.innerHTML =
      viewSwitchHtml() +
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

    var viewBtns = dom.topbarRight.querySelectorAll(".view-switch-btn");
    for (var vi = 0; vi < viewBtns.length; vi++) {
      viewBtns[vi].addEventListener("click", onViewSwitchClick);
    }
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

  /* ------------------------------------------------------------------ *
   * Burn-up chart (§5.2, Phase 5) — one pure render function, used for
   * both the sprint-wide panel and every per-Rock block.
   *
   * Text (axis start/end/total/zero/today labels, the legend, the footer)
   * is plain HTML laid out with flexbox — NOT SVG <text> — deliberately.
   * The SVG stretches non-uniformly (preserveAspectRatio="none") to fill
   * whatever width its container has, which is exactly what a responsive
   * inline chart needs for the LINES (their relative crossing point is the
   * signal, not a "true" fixed aspect ratio) but would visibly distort any
   * <text> caught inside that same scaled coordinate system. Splitting text
   * out to HTML sidesteps that without needing to measure the rendered
   * SVG's actual pixel size (which would mean a DOM read during render).
   *
   * `onTrack` is the exact object metrics.onTrack() already returns for this
   * scope (the same one driving the chip) — the footer reads its numbers
   * directly rather than re-deriving them from `series`, so the footer can
   * never disagree with the chip, and it stays correct even in the (very
   * overdue-sprint) edge case where "today" falls outside the plotted axis
   * entirely and `series` has no point for it.
   */
  function burnupFooterText(onTrack) {
    var gap = onTrack.gap;
    var gapAbs = Math.abs(gap).toFixed(1);
    var status = gap === 0 ? "on track" : (gap > 0 ? gapAbs + " ahead" : gapAbs + " behind");
    return "Actual " + onTrack.actual.toFixed(1) + " of " + onTrack.planned.toFixed(1) +
      " planned work-days — " + status;
  }

  function renderBurnupChart(series, onTrack) {
    var n = series.points.length;
    var total = series.total > 0 ? series.total : 1;

    function xPct(i) { return n <= 1 ? 0 : (i / (n - 1)) * 100; }
    function yUnit(v) { return 40 - (v / total) * 40; } // SVG coordinate space is 0–100 (x) by 0–40 (y)

    function buildPath(key) {
      var d = "";
      for (var i = 0; i < n; i++) {
        var v = series.points[i][key];
        if (v === null || v === undefined) continue;
        d += (d === "" ? "M " : " L ") + xPct(i).toFixed(2) + "," + yUnit(v).toFixed(2);
      }
      return d;
    }

    var plannedPath = buildPath("planned");
    var actualPath = buildPath("actual");

    var todayIdx = -1;
    for (var i = 0; i < n; i++) {
      if (series.points[i].date === series.today) { todayIdx = i; break; }
    }
    var todayPct = todayIdx >= 0 ? xPct(todayIdx) : null;

    var footerText = burnupFooterText(onTrack);
    var totalLabel = (Math.round(total * 10) / 10).toString();

    var todaySvg = todayPct !== null
      ? '<line x1="' + todayPct.toFixed(2) + '" y1="0" x2="' + todayPct.toFixed(2) +
        '" y2="40" class="burnup-today-line" vector-effect="non-scaling-stroke" />'
      : "";
    var todayHtmlLabel = todayPct !== null
      ? '<span class="burnup-today-label" style="left:' + todayPct.toFixed(2) + '%">Today</span>'
      : "";

    return (
      '<div class="burnup-chart">' +
        '<div class="burnup-row">' +
          '<div class="burnup-yaxis"><span>' + escapeHtml(totalLabel) + "</span><span>0</span></div>" +
          '<div class="burnup-plot">' +
            '<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="burnup-svg" ' +
              'role="img" aria-label="' + escapeAttr(footerText) + '">' +
              todaySvg +
              (plannedPath ? '<path d="' + plannedPath + '" class="burnup-line-planned" fill="none" vector-effect="non-scaling-stroke" />' : "") +
              (actualPath ? '<path d="' + actualPath + '" class="burnup-line-actual" fill="none" vector-effect="non-scaling-stroke" />' : "") +
            "</svg>" +
            todayHtmlLabel +
          "</div>" +
        "</div>" +
        '<div class="burnup-xaxis">' +
          "<span>" + escapeHtml(series.axisStart) + "</span>" +
          '<span class="burnup-legend" aria-hidden="true">- - Planned&nbsp;&nbsp;— Actual</span>' +
          "<span>" + escapeHtml(series.axisEnd) + "</span>" +
        "</div>" +
        '<p class="burnup-footer">' + escapeHtml(footerText) + "</p>" +
      "</div>"
    );
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

    var rockIds = getRockIndex().rockTaskIds[rockId] || [];
    var series = computeBurnup(rockIds);

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
      "</div>" +
      renderBurnupChart(series, m.onTrack)
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

  /**
   * True if this row's deliverable input holds something worth protecting:
   * it currently has focus, or it has typed (unsaved) text in it. Every task
   * without a saved deliverable shows an EMPTY input by default — patching
   * that away loses nothing, so an untouched empty box is deliberately NOT
   * treated as "open" here, or the diff-patch would skip almost every row on
   * a plan where most tasks have no deliverable yet. It's specifically an
   * in-progress edit (focused, or holding unsaved text) that a patch must
   * not clobber (§7 in spirit: don't silently destroy what the person is in
   * the middle of). Reused by the diff-patch below to skip exactly that row.
   */
  function taskRowHasOpenDeliverableInput(taskId) {
    var wrap = dom.mainEl.querySelector('.task-deliverable[data-task-id="' + cssEscape(taskId) + '"]');
    if (!wrap) return false;
    var input = wrap.querySelector(".deliverable-input");
    if (!input) return false;
    return document.activeElement === input || input.value.trim() !== "";
  }

  function patchTaskRowSafely(taskId) {
    if (taskRowHasOpenDeliverableInput(taskId)) return;
    patchTaskRow(taskId);
  }

  /* ------------------------------------------------------------------ *
   * Rendering — milestone group + Rock section
   * ------------------------------------------------------------------ */

  function milestoneIsDeferred(milestoneId) {
    var m = state.index.milestones[milestoneId];
    return !!(m && m.deferred === true);
  }

  /** The milestone-header's inner markup only — shared by the full render and
   *  the targeted patch below, same split as renderRockMetrics/patchRockMetrics. */
  function renderMilestoneHeaderInner(milestoneId) {
    var milestone = state.index.milestones[milestoneId];
    var deferred = milestoneIsDeferred(milestoneId);
    var live = state.liveResult.milestones[milestoneId];
    var finishHtml = "";
    if (!deferred && live && live.plannedFinish) {
      finishHtml = '<span class="milestone-finish">→ ' + escapeHtml(live.plannedFinish) + "</span>";
      if (live.red) finishHtml += " " + overshootFlagHtml(live.plannedFinish, state.plan.sprint.end);
    }
    return (
      '<span class="milestone-name">' + escapeHtml(milestoneId) + " · " + escapeHtml(milestone.name) + "</span>" +
      (deferred ? '<span class="deferred-badge">DEFERRED</span>' : finishHtml)
    );
  }

  function patchMilestoneHeader(milestoneId) {
    var header = dom.mainEl.querySelector(
      '.milestone-group[data-milestone-id="' + cssEscape(milestoneId) + '"] .milestone-header'
    );
    if (header) header.innerHTML = renderMilestoneHeaderInner(milestoneId);
  }

  function renderMilestone(milestoneId) {
    var taskIds = state.index.tasksOfMilestone[milestoneId] || [];
    var visibleIds = taskIds.filter(taskPassesFilter);

    if (!visibleIds.length) return ""; // only-mine filter emptied this milestone

    var deferred = milestoneIsDeferred(milestoneId);
    var rowsHtml = visibleIds.map(function (taskId) {
      return renderTaskRow(taskId, state.index.tasks[taskId], milestoneId);
    }).join("");

    return (
      '<div class="milestone-group' + (deferred ? " is-deferred" : "") + '" data-milestone-id="' +
        escapeAttr(milestoneId) + '">' +
        '<div class="milestone-header">' + renderMilestoneHeaderInner(milestoneId) + "</div>" +
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

    if (state.view === "todos") {
      // Sprint-wide progress/burn-up belong to the Sprint Board (§6 View 1);
      // To-dos has its own header (the ops-week window) instead (§11).
      dom.summaryBar.classList.add("hidden");
      dom.burnupPanel.classList.add("hidden");
      if (root.OpsDashTodos) root.OpsDashTodos.render();
      return;
    }

    dom.summaryBar.classList.remove("hidden");
    dom.burnupPanel.classList.remove("hidden");
    renderSummaryBar();
    renderSprintBurnup();

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
        state.pins = root.OpsDashEvents.pins(folded);
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
        var prevLiveResult = state.liveResult;
        var prevMetrics = state.metrics;
        state.currentState[taskId] = { status: next, statusChangedAt: when };
        recompute();
        diffAndRepaint(prevLiveResult, prevMetrics);
      })
      .catch(function (err) {
        toast("Could not mark that task: " + err.message, "error");
        selectEl.disabled = false;
        selectEl.className = "status-ctrl status-" + previous;
        selectEl.value = previous;
      });
  }

  function getRockIndex() {
    if (!state._rockIndex) {
      state._rockIndex = root.OpsDashMetrics.buildRockIndex(state.plan);
    }
    return state._rockIndex;
  }

  /**
   * axisEnd per the burn-up spec: max(sprint.end, latest frozen plannedFinish
   * IN SCOPE) — computed per-scope (a Rock's own tasks), not globally, so one
   * Rock's overshoot never stretches a different Rock's chart. Plain string
   * comparison is safe and correct for ISO YYYY-MM-DD dates.
   */
  function computeAxisEnd(taskIds) {
    var frozenTasks = state.frozenPlan.tasks;
    var latest = state.plan.sprint.end;
    for (var i = 0; i < taskIds.length; i++) {
      var t = frozenTasks[taskIds[i]];
      if (t && t.plannedFinish && t.plannedFinish > latest) latest = t.plannedFinish;
    }
    return latest;
  }

  function computeBurnup(taskIds) {
    return root.OpsDashMetrics.burnupSeries(
      state.frozenPlan.tasks, state.currentState, taskIds,
      state.plan.sprint.start, computeAxisEnd(taskIds), CFG().todayISO()
    );
  }

  function renderSprintBurnup() {
    if (!dom.burnupPanel) return;
    var allIds = Object.keys(state.frozenPlan.tasks);
    var series = computeBurnup(allIds);
    dom.burnupPanel.innerHTML = renderBurnupChart(series, state.metrics.sprint.onTrack);
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
    if (!el) return;
    var action = el.getAttribute("data-action");
    if (action === "set-status") onSetStatus(el.getAttribute("data-task-id"), el.value, el);
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
   * @param initial { plan, frozenPlan, currentState, deliverables, pins, people, band }
   */
  function mount(initial) {
    state.plan = initial.plan;
    state.index = root.OpsDashValidate.buildIndex(initial.plan);
    state.frozenPlan = initial.frozenPlan;
    state.currentState = initial.currentState || {};
    state.deliverables = initial.deliverables || {};
    state.pins = initial.pins || {};
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

    var storedView = localStorage.getItem(cfg.VIEW_STORAGE_KEY);
    state.view = (storedView === "board" || storedView === "todos") ? storedView : "board"; // D-062 default

    dom.topbarRight = document.getElementById("board-topbar-right");
    dom.summaryBar = document.getElementById("board-summary-bar");
    dom.burnupPanel = document.getElementById("board-burnup-panel");
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
