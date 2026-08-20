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
    view: "board",           // "board" | "todos" (D-062, D-081e)
    // Collapsible hierarchy (§6, revised). {id: true} = expanded; absent = collapsed.
    // Lives here, not localStorage: it survives a re-render, a filter change, a
    // mark, and a view switch and back — but NOT a page reload (§6.7), which is
    // deliberate: a reload is how the L10 starts, and it starts collapsed.
    expandedRocks: {},
    expandedProjects: {}
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

  /** Same shape as CFG(). Used for the shared owner resolver/format (D-107). */
  function getValidate() {
    var v = root.OpsDashValidate;
    if (!v) throw new Error("OpsDashBoard requires OpsDashValidate to be loaded first.");
    return v;
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
    var projectsTouched = {};
    for (var j = 0; j < msIds.length; j++) {
      var mid = msIds[j];
      if (milestoneSig(prevLiveResult.milestones[mid]) !== milestoneSig(state.liveResult.milestones[mid])) {
        patchMilestoneHeader(mid);
        // The project row shows an AGGREGATE across its milestones (the
        // latest finish, the missed-deadline flag) — a moved milestone can
        // move that aggregate, so the owning project's header needs the
        // same patch a moved task already gets at the Rock level.
        var owningProject = index_findProjectOfMilestone(mid);
        if (owningProject) projectsTouched[owningProject.id] = true;
      }
    }
    for (var pid in projectsTouched) {
      if (Object.prototype.hasOwnProperty.call(projectsTouched, pid)) patchProjectHeader(pid);
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

  /** Three-segment view toggle (D-062; Issues added by D-096a) — "the chosen
   *  option IS the write" in spirit, just for view state instead of a Sheet
   *  write: click sets state + localStorage, then a plain render() with no
   *  refetch (§6.3, D-062).
   *
   *  Issues is a SEGMENT, not a panel inside To-dos: §13 says issues are
   *  raised during the week and not only in the meeting, so the view has to
   *  stand on its own, and the L10's IDS step is a different step from the
   *  to-dos one (D-096a). */
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
        btn("issues", "Issues") +
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
   *
   * A real <button>, not a span with tabindex: the Rock/Project rows this
   * sits inside are themselves a div[role="button"] (see renderRockSection /
   * renderProject), and a bare tabindex="0" span is excluded from the
   * default Tab order in Safari without Full Keyboard Access — a real
   * button is not. Also fixes the invalid HTML this used to produce: it
   * used to sit inside a <button> (a button may not contain interactive
   * content), which is why the popover CSS's :focus-within could pass here
   * synthetically but real keyboard Tab never reached it.
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
        '<button type="button" class="overshoot-flag" aria-label="Projected past sprint end" ' +
          'aria-describedby="' + popId + '">⚠</button>' +
        '<span class="overshoot-popover" id="' + popId + '" role="tooltip">' +
          escapeHtml(message) + "</span>" +
      "</span>"
    );
  }

  /**
   * D-087 (§5.3): a milestone's hard `deadline` compared against its CURRENT
   * live projection — independent of the on-track chip and the burn-up,
   * which measure advance against the frozen plan (D-087d, D-053). Returns
   * "" when there is no deadline, no scheduled finish (deferred, or a
   * deadlock elsewhere), or the projection still lands on/before it — a
   * milestone that will make its deadline shows nothing, per D-087(c)/the
   * build brief: only the problem is visible.
   */
  function deadlineChipHtml(milestoneId) {
    var live = state.liveResult.milestones[milestoneId];
    if (!live || !live.deadline || !live.plannedFinish) return "";

    var parseISO = root.OpsDashEngine._internals.parseISO;
    var deadlineMs = parseISO(live.deadline);
    var finishMs = parseISO(live.plannedFinish);
    if (finishMs <= deadlineMs) return "";

    // Calendar days, per the build brief — not working days.
    var days = Math.round((finishMs - deadlineMs) / 86400000);
    var unit = days === 1 ? " day" : " days";
    var title = "Deadline " + live.deadline + "; projected to finish " + live.plannedFinish +
      " — " + days + unit + " late.";
    return '<span class="deadline-chip" title="' + escapeAttr(title) + '">' +
      days + unit + " past deadline</span>";
  }

  /** The Rock header's own "delator" (D-087c): true the moment ANY milestone
   *  in the Rock is past its deadline, so it is visible without expanding.
   *  Reuses deadlineChipHtml's own miss test rather than recomputing the
   *  date diff a second time. */
  function rockHasMissedDeadline(rockId) {
    var rock = index_findRock(rockId);
    if (!rock) return false;
    for (var pi = 0; pi < rock.projects.length; pi++) {
      var milestones = rock.projects[pi].milestones || [];
      for (var mi = 0; mi < milestones.length; mi++) {
        if (deadlineChipHtml(milestones[mi].id) !== "") return true;
      }
    }
    return false;
  }

  /** §5.2, three states, symmetric band: ahead of plan by more than the band
   *  reads "Ahead" (blue); within the band either direction reads "On pace"
   *  (green); behind by more than the band reads "Behind" (red). Replaces
   *  the old asymmetric green/amber/red, where anything at or ahead of plan
   *  was always green and the band only ever softened the behind side. */
  function onTrackLabel(color) {
    if (color === "blue") return "Ahead";
    if (color === "red") return "Behind";
    return "On pace";
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

  /**
   * §6.2/§6.6 collapsible-hierarchy counts. Pure lengths + a filter test over
   * the id index the board already holds — per D-053, anything needing more
   * than that belongs in metrics.js, and this doesn't.
   */
  function projectCounts(project) {
    var milestonesTotal = project.milestones.length;
    var milestonesVisible = 0;
    var tasksTotal = 0;
    var tasksVisible = 0;
    for (var mi = 0; mi < project.milestones.length; mi++) {
      var ids = state.index.tasksOfMilestone[project.milestones[mi].id] || [];
      var vis = ids.filter(taskPassesFilter);
      tasksTotal += ids.length;
      tasksVisible += vis.length;
      if (vis.length > 0) milestonesVisible++;
    }
    return {
      milestonesTotal: milestonesTotal, milestonesVisible: milestonesVisible,
      tasksTotal: tasksTotal, tasksVisible: tasksVisible
    };
  }

  function rockCounts(rock) {
    var projectsVisible = 0;
    var milestonesTotal = 0, milestonesVisible = 0;
    var tasksTotal = 0, tasksVisible = 0;
    for (var pi = 0; pi < rock.projects.length; pi++) {
      var pc = projectCounts(rock.projects[pi]);
      milestonesTotal += pc.milestonesTotal;
      milestonesVisible += pc.milestonesVisible;
      tasksTotal += pc.tasksTotal;
      tasksVisible += pc.tasksVisible;
      if (pc.tasksVisible > 0) projectsVisible++;
    }
    return {
      projectsTotal: rock.projects.length, projectsVisible: projectsVisible,
      milestonesTotal: milestonesTotal, milestonesVisible: milestonesVisible,
      tasksTotal: tasksTotal, tasksVisible: tasksVisible
    };
  }

  /** §6.6: unfiltered, plain counts. Filtered, the task count reads "X of Y"
   *  and the project/milestone counts are reduced to only what still has a
   *  visible task — not paired with the original, since §6.6 only asks the
   *  task count to show what the filter removed. */
  function onlyMineActive() {
    return state.onlyMine && !!state.actor;
  }

  function rockContentsLabel(counts) {
    var filtered = onlyMineActive();
    var projects = (filtered ? counts.projectsVisible : counts.projectsTotal) + " projects";
    var milestones = (filtered ? counts.milestonesVisible : counts.milestonesTotal) + " milestones";
    var tasks = filtered
      ? (counts.tasksVisible + " of " + counts.tasksTotal + " tasks")
      : (counts.tasksTotal + " tasks");
    return projects + " \u00b7 " + milestones + " \u00b7 " + tasks;
  }

  function projectContentsLabel(counts) {
    var filtered = onlyMineActive();
    var milestones = (filtered ? counts.milestonesVisible : counts.milestonesTotal) + " milestones";
    var tasks = filtered
      ? (counts.tasksVisible + " of " + counts.tasksTotal + " tasks")
      : (counts.tasksTotal + " tasks");
    return milestones + " \u00b7 " + tasks;
  }

  /** The disclosure arrow. Content, not an attribute — it has to be part of
   *  the regenerated innerHTML on every patch, or a patch that forgets it
   *  would silently reset a row's arrow (§6.8). Always derived fresh from
   *  the SAME state a caller already has, never cached. */
  function caretHtml(expanded) {
    return '<span class="caret" aria-hidden="true">' + (expanded ? "\u25be" : "\u25b8") + "</span>";
  }

  /**
   * Rock row (level 1, §6.4) — everything the header shows, in the spec's
   * own order: caret, title, contents count, progress bar + on-track chip,
   * projected finish, CUTTABLE, missed-deadline. The burn-up is NOT here —
   * it moved to the body (renderRockBurnupHtml), because a collapsed Rock
   * has to be one row and a chart is not one row.
   *
   * Shared by the full render and patchRockHeader (same split as before),
   * and it is what makes the "patch can't silently reset the arrow" rule
   * hold: this always reads state.expandedRocks fresh rather than being
   * handed a value that could go stale between render and patch.
   */
  function renderRockHeaderInner(rockId) {
    var rock = index_findRock(rockId);
    var expanded = !!state.expandedRocks[rockId];
    var counts = rockCounts(rock);
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
      ? '<span class="cuttable-badge" title="Informational only — cutting means regenerating the plan without this Rock/Project">CUTTABLE</span>'
      : "";

    // D-087(c): surfaced at the Rock header so a missed deadline is visible
    // without expanding — which milestone it is shows once you do.
    var deadlineMissedBadge = rockHasMissedDeadline(rockId)
      ? '<span class="deadline-chip" title="At least one milestone in this Rock is past its deadline — expand to see which.">⚠ Deadline missed</span>'
      : "";

    return (
      caretHtml(expanded) +
      '<h2 class="rock-title-text">' + escapeHtml(rock.id) + " · " + escapeHtml(rock.name) + "</h2>" +
      '<span class="contents-count">' + escapeHtml(rockContentsLabel(counts)) + "</span>" +
      '<div class="progress-bar-wrap">' +
        '<div class="progress-bar-fill" style="width:' + pct(m.progress.pct) + '%"></div>' +
      "</div>" +
      '<span class="progress-pct">' + pct(m.progress.pct) + "%</span>" +
      chipHtml(m.onTrack.color, onTrackLabel(m.onTrack.color)) +
      finishHtml +
      cuttableBadge +
      deadlineMissedBadge
    );
  }

  /** Just the chart — extracted so it can be rendered ONLY when the Rock is
   *  expanded (§6.4) and patched as its own node (§6.8), independent of the
   *  header patch. */
  function renderRockBurnupHtml(rockId) {
    var m = state.metrics.rocks[rockId];
    var rockIds = getRockIndex().rockTaskIds[rockId] || [];
    var series = computeBurnup(rockIds);
    return renderBurnupChart(series, m.onTrack);
  }

  function patchRockHeader(rockId) {
    var header = dom.mainEl.querySelector('.rock-section[data-rock-id="' + cssEscape(rockId) + '"] .rock-header');
    if (!header) return;
    header.innerHTML = renderRockHeaderInner(rockId);
    // Re-derived explicitly, defensively (§6.8): nothing a mark-patch does
    // today changes a Rock's expanded state, but the attribute lives on the
    // OUTER button and innerHTML alone would never touch it if that ever
    // stopped being true — this keeps the guarantee true by construction,
    // not by nobody happening to break it later.
    header.setAttribute("aria-expanded", String(!!state.expandedRocks[rockId]));
  }

  /** Only touches the DOM when the Rock is actually expanded — the existing
   *  "patch helpers return early when the node is absent" guard (§6.8),
   *  which a collapsed Rock now makes the NORMAL case rather than a rare one. */
  function patchRockBurnup(rockId) {
    var node = dom.mainEl.querySelector('.rock-section[data-rock-id="' + cssEscape(rockId) + '"] .rock-burnup');
    if (!node) return;
    node.innerHTML = renderRockBurnupHtml(rockId);
  }

  function patchRockMetrics(rockId) {
    patchRockHeader(rockId);
    patchRockBurnup(rockId); // no-ops when collapsed
  }
  /* ------------------------------------------------------------------ *
   * Rendering — task row
   * ------------------------------------------------------------------ */

  /** The one owner format, from the one definition (D-107): a single owner
   *  renders as its name, a joint task as "Brent + Bernardo". */
  function ownerLabel(task) {
    return getValidate().ownerLabel(task);
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
      return '<span class="deferred-badge" title="Deferred: excluded from scheduling and progress">DEFERRED</span>';
    }
    var live = state.liveResult.tasks[taskId];
    if (!live) {
      // Not scheduled (e.g. a dependency deadlock elsewhere) — say so plainly rather
      // than showing a blank date, per §7 ("do not silently proceed").
      return '<span class="finish-date finish-date-error" title="Engine could not schedule this task — see the board-level error banner">— no date —</span>';
    }
    var html = '<span class="finish-date">→ ' + escapeHtml(live.plannedFinish) + "</span>";
    if (live.clamped) {
      html += ' <span class="clamped-flag" title="This task\u2019s original ETA already passed; it is clamped to today because it is still in progress">overdue</span>';
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
        '" data-owner="' + escapeAttr(ownerLabel(task)) + '" data-milestone-id="' + escapeAttr(milestoneId) + '">' +
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
      // Independent of live.red on purpose (D-087d): sprint-end overshoot and
      // a missed external deadline are two different facts and can disagree
      // in either direction.
      finishHtml += deadlineChipHtml(milestoneId);
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

  /** The project's own overall finish (§6.4: "the project's latest milestone
   *  finish"): the LATEST live plannedFinish among its non-deferred
   *  milestones. There is no per-project entry in liveResult (only tasks,
   *  milestones, rocks), so this is computed here, the same way the Rock row
   *  already gets a single finish out of many milestones underneath it. */
  function projectLatestFinish(project) {
    var best = null;
    for (var mi = 0; mi < project.milestones.length; mi++) {
      var mid = project.milestones[mi].id;
      if (milestoneIsDeferred(mid)) continue;
      var live = state.liveResult.milestones[mid];
      if (!live || !live.plannedFinish) continue;
      if (!best || live.plannedFinish > best.plannedFinish) best = live;
    }
    return best;
  }

  /** Project-level mirror of rockHasMissedDeadline (§6.4: new at this level).
   *  §5.3 put the badge on the Rock header so a miss was visible without
   *  expanding; with a level in between, the same rule applies one step
   *  down, or expanding a Rock would say a deadline is missed and then hide
   *  which project owns it. */
  function projectHasMissedDeadline(project) {
    var milestones = project.milestones || [];
    for (var mi = 0; mi < milestones.length; mi++) {
      if (deadlineChipHtml(milestones[mi].id) !== "") return true;
    }
    return false;
  }

  /**
   * Project row (level 2, §6.4) — caret, id · name, contents count, the
   * project's own finish, CUTTABLE, missed-deadline. NO progress bar and NO
   * on-track chip: both are defined per Rock and sprint-wide (§5.1, §5.2),
   * and inventing a project-level number here would be new math nothing
   * asks for.
   */
  function renderProjectHeaderInner(project) {
    var expanded = !!state.expandedProjects[project.id];
    var counts = projectCounts(project);

    var finishHtml = "";
    var best = projectLatestFinish(project);
    if (best && best.plannedFinish) {
      finishHtml = '<span class="project-finish">→ ' + escapeHtml(best.plannedFinish) + "</span>";
      if (best.red) finishHtml += " " + overshootFlagHtml(best.plannedFinish, state.plan.sprint.end);
    }

    var cuttableBadge = project.cuttable
      ? '<span class="cuttable-badge" title="Informational only — cutting means regenerating the plan without this Rock/Project">CUTTABLE</span>'
      : "";
    var deadlineMissedBadge = projectHasMissedDeadline(project)
      ? '<span class="deadline-chip" title="At least one milestone in this project is past its deadline — expand to see which.">⚠ Deadline missed</span>'
      : "";

    return (
      caretHtml(expanded) +
      '<h3 class="project-name">' + escapeHtml(project.id) + " · " + escapeHtml(project.name) + "</h3>" +
      '<span class="contents-count">' + escapeHtml(projectContentsLabel(counts)) + "</span>" +
      finishHtml +
      cuttableBadge +
      deadlineMissedBadge
    );
  }

  function patchProjectHeader(projectId) {
    var header = dom.mainEl.querySelector('.project-section[data-project-id="' + cssEscape(projectId) + '"] .project-header');
    if (!header) return; // collapsed Rock hides this too — normal, no-op (§6.8)
    header.innerHTML = renderProjectHeaderInner(index_findProject(projectId));
    header.setAttribute("aria-expanded", String(!!state.expandedProjects[projectId]));
  }

  /**
   * Project section (level 2). Always renders its row, even at zero visible
   * tasks under the filter — same honesty rule §6.6 states explicitly for a
   * Rock the filter empties completely, applied one level down: a collapsed
   * row states what it hides, it does not disappear because the count is
   * zero. Body renders only when expanded, and is empty (no milestones
   * rendered at all) rather than merely hidden, so a mark inside a
   * collapsed project changes no DOM (§6.8).
   */
  function renderProject(project) {
    var expanded = !!state.expandedProjects[project.id];
    var counts = projectCounts(project);

    var bodyHtml = "";
    if (expanded) {
      if (counts.tasksVisible === 0) {
        bodyHtml = '<p class="board-empty">No tasks for the selected filter in this project.</p>';
      } else {
        var pieces = [];
        for (var mi = 0; mi < project.milestones.length; mi++) {
          var html = renderMilestone(project.milestones[mi].id);
          if (html) pieces.push(html);
        }
        bodyHtml = pieces.join("");
      }
    }

    return (
      '<div class="project-section" data-project-id="' + escapeAttr(project.id) + '">' +
        '<div role="button" tabindex="0" class="project-header" data-action="toggle-project" ' +
          'data-project-id="' + escapeAttr(project.id) + '" aria-expanded="' + expanded + '">' +
          renderProjectHeaderInner(project) +
        "</div>" +
        '<div class="project-body">' + bodyHtml + "</div>" +
      "</div>"
    );
  }

  /**
   * Rock section (level 1). Always renders its row (§6.3: the default and
   * only state that matters is "one row per Rock"). Body — burn-up first,
   * then every project row — renders only when expanded, and only the
   * burn-up when the filter empties the Rock (the burn-up is unaffected by
   * "only my tasks", same as the Rock's own progress/on-track numbers).
   */
  function renderRock(rockId) {
    var rock = index_findRock(rockId);
    var expanded = !!state.expandedRocks[rockId];
    var counts = rockCounts(rock);

    var bodyHtml = "";
    if (expanded) {
      var burnupHtml = '<div class="rock-burnup">' + renderRockBurnupHtml(rockId) + "</div>";
      var innerBody;
      if (counts.tasksVisible === 0) {
        innerBody = '<p class="board-empty">No tasks for the selected filter in this Rock.</p>';
      } else {
        var pieces = [];
        for (var pi = 0; pi < rock.projects.length; pi++) {
          pieces.push(renderProject(rock.projects[pi]));
        }
        innerBody = pieces.join("");
      }
      bodyHtml = burnupHtml + innerBody;
    }

    return (
      '<section class="rock-section" data-rock-id="' + escapeAttr(rockId) + '">' +
        '<div role="button" tabindex="0" class="rock-header" data-action="toggle-rock" ' +
          'data-rock-id="' + escapeAttr(rockId) + '" aria-expanded="' + expanded + '">' +
          renderRockHeaderInner(rockId) +
        "</div>" +
        '<div class="rock-body">' + bodyHtml + "</div>" +
      "</section>"
    );
  }

  function index_findRock(rockId) {
    for (var i = 0; i < state.plan.rocks.length; i++) {
      if (state.plan.rocks[i].id === rockId) return state.plan.rocks[i];
    }
    return null;
  }

  /** Project ids are unique across the whole sprint (§2), so this needs no
   *  rockId — used by patchProjectHeader, which only has the id a click or a
   *  diff-repaint handed it. */
  function index_findProject(projectId) {
    for (var i = 0; i < state.plan.rocks.length; i++) {
      var projects = state.plan.rocks[i].projects;
      for (var j = 0; j < projects.length; j++) {
        if (projects[j].id === projectId) return projects[j];
      }
    }
    return null;
  }

  /** validate.js's index maps a task to its milestone but not a milestone to
   *  its project — nothing else needed one until now. Used only by
   *  diffAndRepaint, which is not a hot path, so a scan is fine. */
  function index_findProjectOfMilestone(milestoneId) {
    for (var i = 0; i < state.plan.rocks.length; i++) {
      var projects = state.plan.rocks[i].projects;
      for (var j = 0; j < projects.length; j++) {
        var milestones = projects[j].milestones;
        for (var k = 0; k < milestones.length; k++) {
          if (milestones[k].id === milestoneId) return projects[j];
        }
      }
    }
    return null;
  }

  /** "Only my tasks": a joint task is mine if I am one of its owners. Reads
   *  the owner list rather than testing for the old "Both" literal (D-107) —
   *  that test also happened to be why a joint task showed for everyone. */
  function taskPassesFilter(taskId) {
    if (!state.onlyMine || !state.actor) return true;
    var task = state.index.tasks[taskId];
    return getValidate().ownersOf(task).indexOf(state.actor) !== -1;
  }

  /* ------------------------------------------------------------------ *
   * Full render
   * ------------------------------------------------------------------ */

  /** This module's own #main listeners, on the same terms it imposes on the
   *  other two views. Remove-before-add, so calling it repeatedly (render()
   *  does) can never stack duplicates. */
  function setBoardMainListeners(active) {
    if (!dom.mainEl) return;
    dom.mainEl.removeEventListener("click", onMainClick);
    dom.mainEl.removeEventListener("change", onMainChange);
    dom.mainEl.removeEventListener("keydown", onMainKeydown);
    if (active) {
      dom.mainEl.addEventListener("click", onMainClick);
      dom.mainEl.addEventListener("change", onMainChange);
      dom.mainEl.addEventListener("keydown", onMainKeydown);
    }
  }

  /**
   * THE INVARIANT: #main has exactly one view listening to it — the visible
   * one. Enforced in one place, structurally, rather than by every handler
   * checking whether its view happens to be on screen.
   *
   * That distinction is the whole point. A per-branch "is my view active?"
   * test would fix the action that broke and leave the next shared action
   * to break the same way — and there WILL be a next one, because issues.js
   * deliberately reuses §11.5's ad-hoc form, and reusing markup means
   * reusing its data-action. Here, a view that is not visible cannot
   * respond to anything, whatever it is named.
   *
   * Called from render(), which already runs on every view switch and every
   * refresh; the setters are idempotent so the repetition is free and also
   * self-healing if anything ever attaches out of band.
   */
  function setActiveViewListeners() {
    setBoardMainListeners(state.view === "board");
    if (root.OpsDashTodos && root.OpsDashTodos.setActive) {
      root.OpsDashTodos.setActive(state.view === "todos");
    }
    if (root.OpsDashIssues && root.OpsDashIssues.setActive) {
      root.OpsDashIssues.setActive(state.view === "issues");
    }
  }

  function render() {
    renderTopbarRight();
    setActiveViewListeners();

    if (state.view === "todos") {
      // Sprint-wide progress/burn-up belong to the Sprint Board (§6 View 1);
      // To-dos has its own header (the ops-week window) instead (§11).
      dom.summaryBar.classList.add("hidden");
      dom.burnupPanel.classList.add("hidden");
      if (root.OpsDashTodos) root.OpsDashTodos.render();
      return;
    }

    if (state.view === "issues") {
      // Same reasoning as To-dos: the sprint burn-up is the Sprint Board's.
      // An issue never enters the engine at all (§13.5), so there is nothing
      // sprint-shaped to show above this one.
      dom.summaryBar.classList.add("hidden");
      dom.burnupPanel.classList.add("hidden");
      if (root.OpsDashIssues) root.OpsDashIssues.render();
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

    // §6.5: one "Collapse all" control, no "expand all" — expanding
    // everything reproduces exactly the state the collapsible hierarchy
    // exists to remove. Lives INSIDE #main so the click routes through the
    // one listener this module already owns (setBoardMainListeners), rather
    // than adding a second (D-098's own lesson).
    var controlsHtml =
      '<div class="board-controls">' +
        // .btn-primary, NOT .btn-secondary: this renders on #main's light
        // body, and .btn-secondary is white-on-translucent-white — invisible
        // there (that exact bug shipped once already, commit ef72e33).
        '<button type="button" class="btn btn-primary" data-action="collapse-all">Collapse all</button>' +
      "</div>";

    var html = [controlsHtml];
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
    // The overshoot flag has its own hover/focus popover (CSS-only, no click
    // behaviour of its own) and now sits inside the Rock/project header row
    // (§6.5). A click on it would otherwise bubble up and be read as a click
    // on the row itself — since data-action lives on that row, not on the
    // flag — toggling the row when someone only meant to read the warning.
    // Confirmed in the browser before this guard existed: a plain click on
    // the flag flipped state.expandedRocks with nothing else clicked. Every
    // other badge in the row (CUTTABLE, missed-deadline, the finish text) has
    // no interactive affordance of its own, so a click there toggling the row
    // is correct — "the whole header row is the toggle" (§6.5) — this is the
    // one exception, not a second one to widen.
    if (e.target.closest(".overshoot-wrap")) return;

    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var taskId = el.getAttribute("data-task-id");

    if (action === "edit-deliverable") onEditDeliverable(taskId);
    else if (action === "save-deliverable") onSaveDeliverable(taskId);
    else if (action === "toggle-rock") onToggleRock(el.getAttribute("data-rock-id"));
    else if (action === "toggle-project") onToggleProject(el.getAttribute("data-project-id"));
    else if (action === "collapse-all") onCollapseAll();
  }

  /**
   * §6.5: the whole header row is the toggle — reached here because the
   * click lands on the <button data-action="toggle-rock">, not on the caret
   * alone. Full render() rather than a targeted patch: this is a display
   * toggle over data already in memory, cheap either way, and there is no
   * write to protect an in-progress edit from (§6.8's guards are for the
   * mark-patch path, not this one).
   */
  function onToggleRock(rockId) {
    state.expandedRocks[rockId] = !state.expandedRocks[rockId];
    render();
  }

  function onToggleProject(projectId) {
    state.expandedProjects[projectId] = !state.expandedProjects[projectId];
    render();
  }

  /** §6.5: the only bulk control — deliberately no "expand all" beside it. */
  function onCollapseAll() {
    state.expandedRocks = {};
    state.expandedProjects = {};
    render();
  }

  function onMainChange(e) {
    var el = e.target;
    if (!el) return;
    var action = el.getAttribute("data-action");
    if (action === "set-status") onSetStatus(el.getAttribute("data-task-id"), el.value, el);
  }

  function onMainKeydown(e) {
    var el = e.target;
    if (e.key === "Enter" && el && el.classList && el.classList.contains("deliverable-input")) {
      e.preventDefault();
      onSaveDeliverable(el.getAttribute("data-task-id"));
      return;
    }
    // §6.5's row toggle is a div[role="button"], not a real <button> — the
    // overshoot flag it can contain has to be a real <button> of its own (a
    // <button> may not contain another <button>), so the row gives up native
    // button semantics and this restores just the one native behaviour that
    // matters: Enter/Space activates it. Reads e.target directly, not
    // closest("[data-action]") — pressing Enter/Space while the nested flag
    // button has focus should act on the flag (nothing, today), not bubble
    // up and toggle the row it sits in.
    if (e.key === "Enter" || e.key === " ") {
      var action = el && el.getAttribute && el.getAttribute("data-action");
      if (action === "toggle-rock" || action === "toggle-project") {
        e.preventDefault();
        el.click();
      }
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
    // §6.3/§6.7: everything opens collapsed, on every mount — a reload is
    // how the L10 starts, and it starts collapsed. Not read from
    // localStorage, unlike ACTOR_STORAGE_KEY/VIEW_STORAGE_KEY just below.
    state.expandedRocks = {};
    state.expandedProjects = {};

    var cfg = CFG();
    var stored = localStorage.getItem(cfg.ACTOR_STORAGE_KEY);
    var params = new URLSearchParams(window.location.search);
    var urlActor = params.get("actor");
    var candidate = urlActor || stored;
    var isKnownActive = state.people.some(function (p) { return p.name === candidate && p.active; });
    state.actor = isKnownActive ? candidate : null; // §7: stale/removed actor → unset, not an error
    if (urlActor && isKnownActive) localStorage.setItem(cfg.ACTOR_STORAGE_KEY, urlActor);

    var storedView = localStorage.getItem(cfg.VIEW_STORAGE_KEY);
    state.view = (storedView === "board" || storedView === "todos" || storedView === "issues")
      ? storedView : "board"; // D-062 default

    dom.topbarRight = document.getElementById("board-topbar-right");
    dom.summaryBar = document.getElementById("board-summary-bar");
    dom.burnupPanel = document.getElementById("board-burnup-panel");
    dom.mainEl = document.getElementById("main");
    dom.toastContainer = document.getElementById("toast-container");

    // Listeners are attached by setActiveViewListeners() below, from render(),
    // not here — this module is one of THREE that render into #main, and only
    // the visible one may be listening to it.

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
      render: render,
      // §6 collapsible hierarchy — exposed for tests/board-hierarchy.test.js
      onToggleRock: onToggleRock,
      onToggleProject: onToggleProject,
      onCollapseAll: onCollapseAll,
      rockCounts: rockCounts,
      projectCounts: projectCounts,
      onMainClick: onMainClick,
      onMainKeydown: onMainKeydown,
      patchRockBurnup: patchRockBurnup,
      patchProjectHeader: patchProjectHeader,
      patchTaskRow: patchTaskRow,
      patchMilestoneHeader: patchMilestoneHeader
    }
  };
})(typeof window !== "undefined" ? window : this);
