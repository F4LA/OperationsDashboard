/**
 * Operations Dashboard — Metrics (spec §5)
 *
 * Not on Bernardo's Phase 4 file list, but the board (§6) needs both numbers
 * this module computes, and they're pure structural math with no natural home
 * in board.js's DOM/wiring code — every other computation in this project
 * (validate.js, engine.js, events.js's fold) got its own testable module, so
 * this follows the same pattern rather than duplicating date math inline in
 * the renderer. Flagged in the Phase 4 report for review.
 *
 * §5.1 — Duration-weighted progress (per Rock, and sprint-wide)
 *   progress(scope) = Σ workDays of DONE tasks in scope / Σ workDays of ALL
 *   non-deferred tasks in scope. Weighted by workDays only (not wait — a
 *   shipping wait must not inflate progress). in_progress earns nothing (v1
 *   is binary crediting per §5.1).
 *
 *   The denominator comes from a FROZEN plan-mode result (computed once at
 *   app.js bootstrap, never recomputed) — every non-deferred task's workDays
 *   is a structural fact that doesn't change as people mark tasks. The
 *   numerator (which tasks are done) comes from live currentState.
 *
 * §5.2 — On-track vs. behind (burn-up)
 *   Two cumulative-work curves over the sprint calendar:
 *     planned(D) = Σ workDays of tasks whose FROZEN plannedFinish ≤ D
 *     actual(D)  = Σ workDays of tasks marked done on/before D (real
 *                  completion date from currentState.statusChangedAt)
 *   gap = actual(today) − planned(today); banded by Settings.onTrackBandWorkDays
 *   (D-033): gap ≥ 0 → green, −band < gap < 0 → amber, gap ≤ −band → red.
 *   Both curves are calendar-date comparisons (no working-day axis needed —
 *   §5.2 explicitly operates "over the sprint calendar").
 *
 * Public API
 *   OpsDashMetrics.buildRockIndex(plan)                        → {taskRock, rockName, rockOrder, rockTaskIds}
 *   OpsDashMetrics.progress(frozenTasks, currentState, taskIds) → {done, total, pct}
 *   OpsDashMetrics.onTrack(frozenTasks, currentState, taskIds, todayISO, band) → {planned, actual, gap, band, color}
 *   OpsDashMetrics.computeAll(plan, frozenPlanResult, currentState, todayISO, band)
 *       → { sprint: {progress, onTrack}, rocks: { [rockId]: {name, progress, onTrack} } }
 *   OpsDashMetrics.burnupSeries(frozenTasks, currentState, taskIds, axisStartISO, axisEndISO, todayISO)
 *       → { points: [{date, planned, actual|null}], total, axisStart, axisEnd, today }
 *
 * Requires OpsDashEngine (for parseISO/formatISO — calendar date parsing shared
 * with the engine's own, so a date string is interpreted identically everywhere
 * in the app).
 *
 * Phase 5 (burn-up series) — same two curves onTrack() already computes, just
 * sampled at every calendar day across the axis instead of only at `today`, so
 * the chart draws from the identical formula the chip's gap uses (no second
 * definition of "planned"/"actual" to drift out of sync). Axis range is a
 * caller decision (board.js), not this module's — see burnupSeries's own
 * comment for why.
 */
(function (root) {
  "use strict";

  function getParseISO() {
    var eng = root.OpsDashEngine || (typeof globalThis !== "undefined" && globalThis.OpsDashEngine);
    if (!eng || !eng._internals || !eng._internals.parseISO) {
      throw new Error("OpsDashMetrics requires OpsDashEngine to be loaded first.");
    }
    return eng._internals.parseISO;
  }

  /** Same engine, same UTC-midnight round trip as parseISO — no second date library. */
  function getFormatISO() {
    var eng = root.OpsDashEngine || (typeof globalThis !== "undefined" && globalThis.OpsDashEngine);
    if (!eng || !eng._internals || !eng._internals.formatISO) {
      throw new Error("OpsDashMetrics requires OpsDashEngine to be loaded first.");
    }
    return eng._internals.formatISO;
  }

  /* ------------------------------------------------------------------ *
   * buildRockIndex — taskId/milestoneId → rockId, walking the plan tree
   * directly (independent of engine output, so it also covers deferred
   * tasks/milestones — harmless, since callers only look up ids that are
   * actually keys of a frozen-plan or live-mode tasks map, which already
   * excludes deferred per D-017).
   * ------------------------------------------------------------------ */

  function buildRockIndex(plan) {
    var taskRock = {};
    var milestoneRock = {};
    var rockName = {};
    var rockOrder = [];
    var rockTaskIds = {};

    var rocks = Array.isArray(plan && plan.rocks) ? plan.rocks : [];
    for (var ri = 0; ri < rocks.length; ri++) {
      var rock = rocks[ri];
      if (!rock || !rock.id) continue;
      rockOrder.push(rock.id);
      rockName[rock.id] = rock.name || rock.id;
      rockTaskIds[rock.id] = [];

      var projects = Array.isArray(rock.projects) ? rock.projects : [];
      for (var pi = 0; pi < projects.length; pi++) {
        var milestones = Array.isArray(projects[pi] && projects[pi].milestones) ? projects[pi].milestones : [];
        for (var mi = 0; mi < milestones.length; mi++) {
          var milestone = milestones[mi];
          if (!milestone || !milestone.id) continue;
          milestoneRock[milestone.id] = rock.id;

          var tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
          for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            if (!task || !task.id) continue;
            taskRock[task.id] = rock.id;
            rockTaskIds[rock.id].push(task.id);
          }
        }
      }
    }

    return {
      taskRock: taskRock,
      milestoneRock: milestoneRock,
      rockName: rockName,
      rockOrder: rockOrder,
      rockTaskIds: rockTaskIds
    };
  }

  /* ------------------------------------------------------------------ *
   * progress (§5.1)
   * ------------------------------------------------------------------ */

  /**
   * @param frozenTasks  the `.tasks` map from a plan-mode result (structural;
   *                     every non-deferred task, each carrying workDays)
   * @param currentState D-027 map: {taskId: {status, statusChangedAt}}
   * @param taskIds      ids to include in scope (a Rock's ids, or every key
   *                     of frozenTasks for sprint-wide)
   */
  function progress(frozenTasks, currentState, taskIds) {
    var done = 0;
    var total = 0;

    for (var i = 0; i < taskIds.length; i++) {
      var id = taskIds[i];
      var t = frozenTasks[id];
      if (!t) continue; // not in this frozen plan (shouldn't happen for a valid scope)
      var wd = t.workDays || 0;
      total += wd;
      var cs = currentState[id];
      if (cs && cs.status === "done") done += wd;
    }

    return { done: done, total: total, pct: total > 0 ? done / total : 0 };
  }

  /* ------------------------------------------------------------------ *
   * onTrack (§5.2)
   * ------------------------------------------------------------------ */

  /**
   * @param frozenTasks  same frozen plan-mode `.tasks` map as progress()
   * @param currentState D-027 map
   * @param taskIds      ids in scope
   * @param todayISO     "YYYY-MM-DD", explicit — never Date.now() (same
   *                     discipline as the engine's own today parameter)
   * @param band         Settings.onTrackBandWorkDays (work-days of slack)
   */
  function onTrack(frozenTasks, currentState, taskIds, todayISO, band) {
    var parseISO = getParseISO();
    var todayMs = parseISO(todayISO);
    var planned = 0;
    var actual = 0;

    for (var i = 0; i < taskIds.length; i++) {
      var id = taskIds[i];
      var t = frozenTasks[id];
      if (!t) continue;
      var wd = t.workDays || 0;

      if (t.plannedFinish && parseISO(t.plannedFinish) <= todayMs) {
        planned += wd;
      }

      var cs = currentState[id];
      if (cs && cs.status === "done" && cs.statusChangedAt) {
        var doneDatePart = String(cs.statusChangedAt).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(doneDatePart) && parseISO(doneDatePart) <= todayMs) {
          actual += wd;
        }
      }
    }

    var gap = actual - planned;
    var b = typeof band === "number" && band >= 0 ? band : 0;
    var color;
    if (gap >= 0) color = "green";
    else if (gap <= -b) color = "red";
    else color = "amber";

    return { planned: planned, actual: actual, gap: gap, band: b, color: color };
  }

  /* ------------------------------------------------------------------ *
   * burnupSeries (§5.2, Phase 5) — the same two curves as onTrack(),
   * sampled once per calendar day across the axis instead of only at today.
   * ------------------------------------------------------------------ */

  var DAY_MS = 86400000;

  /**
   * @param frozenTasks   same frozen plan-mode `.tasks` map as progress()/onTrack()
   * @param currentState  D-027 map
   * @param taskIds       ids in scope (a Rock's ids, or every frozenTasks key for sprint-wide)
   * @param axisStartISO  first day of the x-axis — the caller's call (board.js),
   *                      not this function's; typically plan.sprint.start
   * @param axisEndISO    last day of the x-axis, inclusive — typically
   *                      max(sprint.end, latest frozen plannedFinish in scope),
   *                      so an overshooting Rock's own curve doesn't get cut off
   * @param todayISO      "YYYY-MM-DD", explicit — same discipline as onTrack()
   *
   * No working-day skipping: §5.2 explicitly operates over the sprint
   * CALENDAR, and onTrack() already compares calendar dates, not axis
   * positions — one calendar day per point, weekends included.
   */
  function burnupSeries(frozenTasks, currentState, taskIds, axisStartISO, axisEndISO, todayISO) {
    var parseISO = getParseISO();
    var formatISO = getFormatISO();
    var startMs = parseISO(axisStartISO);
    var endMs = parseISO(axisEndISO);
    var todayMs = parseISO(todayISO);

    var total = 0;
    var infos = [];
    for (var i = 0; i < taskIds.length; i++) {
      var task = frozenTasks[taskIds[i]];
      if (!task) continue; // not in this frozen plan — same guard progress()/onTrack() use
      var wd = task.workDays || 0;
      total += wd;

      var plannedMs = task.plannedFinish ? parseISO(task.plannedFinish) : null;

      var doneMs = null;
      var cs = currentState[taskIds[i]];
      if (cs && cs.status === "done" && cs.statusChangedAt) {
        var datePart = String(cs.statusChangedAt).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) doneMs = parseISO(datePart);
      }

      infos.push({ workDays: wd, plannedMs: plannedMs, doneMs: doneMs });
    }

    var points = [];
    for (var ms = startMs; ms <= endMs; ms += DAY_MS) {
      var planned = 0;
      var actualSum = 0;
      for (var j = 0; j < infos.length; j++) {
        var info = infos[j];
        if (info.plannedMs !== null && info.plannedMs <= ms) planned += info.workDays;
        if (info.doneMs !== null && info.doneMs <= ms) actualSum += info.workDays;
      }
      points.push({
        date: formatISO(ms),
        planned: planned,
        actual: ms > todayMs ? null : actualSum // no invented future — §5.2 / the redesign brief
      });
    }

    return {
      points: points,
      total: total,
      axisStart: axisStartISO,
      axisEnd: axisEndISO,
      today: todayISO
    };
  }

  /* ------------------------------------------------------------------ *
   * computeAll — the one call board.js needs per render
   * ------------------------------------------------------------------ */

  function computeAll(plan, frozenPlanResult, currentState, todayISO, band) {
    var idx = buildRockIndex(plan);
    var frozenTasks = frozenPlanResult.tasks;
    var allTaskIds = Object.keys(frozenTasks);

    var rocks = {};
    for (var i = 0; i < idx.rockOrder.length; i++) {
      var rockId = idx.rockOrder[i];
      var ids = idx.rockTaskIds[rockId];
      rocks[rockId] = {
        name: idx.rockName[rockId],
        progress: progress(frozenTasks, currentState, ids),
        onTrack: onTrack(frozenTasks, currentState, ids, todayISO, band)
      };
    }

    return {
      sprint: {
        progress: progress(frozenTasks, currentState, allTaskIds),
        onTrack: onTrack(frozenTasks, currentState, allTaskIds, todayISO, band)
      },
      rocks: rocks,
      rockOrder: idx.rockOrder
    };
  }

  root.OpsDashMetrics = {
    buildRockIndex: buildRockIndex,
    progress: progress,
    onTrack: onTrack,
    burnupSeries: burnupSeries,
    computeAll: computeAll
  };
})(typeof window !== "undefined" ? window : this);
