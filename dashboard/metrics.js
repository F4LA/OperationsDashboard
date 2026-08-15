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
 *   OpsDashMetrics.burnupSeries(frozenTasks, currentState, taskIds, axisStartISO, axisEndISO, todayISO, cancelledSet)
 *       → { points: [{date, planned, actual|null}], total, axisStart, axisEnd, today, cancelled }
 *   OpsDashMetrics.weeklyCompletion(opts)
 *       → { team, byPerson } — §12's weekly numbers (D-077)
 *
 * §12 (Phase 8 part 2A) lives here rather than beside the §11 markup because
 * D-053 fixed the house split — pure math in metrics.js, markup in the file
 * that draws — and D-077 resolved the D-071(c)/D-076 clash the same way.
 *
 * Cancelled work (D-068d/e) enters as an OPTIONAL {taskId:true} set:
 * progress() drops those work-days from the denominator and reports them
 * separately, while onTrack() and burnupSeries()'s planned curve are
 * deliberately left alone — the promise stays frozen, so the chart can still
 * show that too much was promised.
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
  /**
   * @param cancelledSet OPTIONAL {taskId: true} (D-068d). Cancelled work-days
   *        LEAVE the denominator and come back as `cancelled`, shown beside
   *        the bar rather than inside it.
   *
   *        Leaving them in would mean the Rock can never reach 100% and its
   *        chip stays red forever over work somebody decided not to do —
   *        which D-058 called the worst possible habit for a new board.
   *        Hiding them entirely would be the opposite lie. So: out of the
   *        denominator, and named.
   */
  function progress(frozenTasks, currentState, taskIds, cancelledSet) {
    var done = 0;
    var total = 0;
    var cancelled = 0;
    var cancelledMap = cancelledSet || {};

    for (var i = 0; i < taskIds.length; i++) {
      var id = taskIds[i];
      var t = frozenTasks[id];
      if (!t) continue; // not in this frozen plan (shouldn't happen for a valid scope)
      var wd = t.workDays || 0;

      if (cancelledMap[id] === true) {
        cancelled += wd;
        continue; // out of BOTH numerator and denominator
      }

      total += wd;
      var cs = currentState[id];
      if (cs && cs.status === "done") done += wd;
    }

    return {
      done: done,
      total: total,
      pct: total > 0 ? done / total : 0,
      cancelled: cancelled
    };
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
  /**
   * @param cancelledSet OPTIONAL {taskId: true} (D-068e). ADDITIVE ONLY: it
   *        contributes one extra scalar, `cancelled`, so the mandatory numeric
   *        footer can name the cancelled days separately. The PLANNED curve is
   *        deliberately NOT recomputed and its arithmetic below is untouched.
   *
   *        The planned curve is the frozen promise (D-053). The progress bar
   *        answers "how much of the remaining work is done"; the burn-up
   *        answers "how are we doing against what we promised". Rewriting the
   *        promise mid-sprint would leave the chart unable to show that too
   *        much was promised — which is the one thing it exists to reveal.
   */
  function burnupSeries(frozenTasks, currentState, taskIds, axisStartISO, axisEndISO, todayISO, cancelledSet) {
    var parseISO = getParseISO();
    var formatISO = getFormatISO();
    var startMs = parseISO(axisStartISO);
    var endMs = parseISO(axisEndISO);
    var todayMs = parseISO(todayISO);
    var cancelledMap = cancelledSet || {};
    var cancelledWorkDays = 0;

    var total = 0;
    var infos = [];
    for (var i = 0; i < taskIds.length; i++) {
      var task = frozenTasks[taskIds[i]];
      if (!task) continue; // not in this frozen plan — same guard progress()/onTrack() use
      var wd = task.workDays || 0;
      if (cancelledMap[taskIds[i]] === true) cancelledWorkDays += wd;
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
      today: todayISO,
      // The one addition (D-068e). `total` and every point above are computed
      // exactly as before — this is a label for the footer, not an input to
      // the curve.
      cancelled: cancelledWorkDays
    };
  }

  /* ------------------------------------------------------------------ *
   * §12 — weekly completion (Phase 8 part 2A, D-077)
   *
   * Lives here, not next to the §11 markup, because D-053 fixed the house
   * split: pure math in metrics.js, markup in whatever file draws. This is
   * the same family as progress() and burnupSeries() directly above.
   * ------------------------------------------------------------------ */

  function emptyTally() {
    return { completed: [], moved: [], discarded: [], cancelled: [] };
  }

  function tallyCounts(t, denominator) {
    return {
      completed: t.completed.slice(),
      moved: t.moved.slice(),
      discarded: t.discarded.slice(),
      cancelled: t.cancelled.slice(),
      completedCount: t.completed.length,
      movedCount: t.moved.length,
      discardedCount: t.discarded.length,
      cancelledCount: t.cancelled.length,
      denominator: denominator === null ? null : denominator.length,
      /**
       * No denominator = no rate. Deliberately NOT reconstructed by counting
       * what happens to be visible: a Rock task the engine proposed and nobody
       * touched leaves NO event at all, so a counted denominator would silently
       * omit exactly the tasks that went well. That is the entire reason D-070
       * froze it with an explicit event.
       *
       * A denominator of ZERO also gives rate null, not 0 (D-078, correction
       * 2): dividing by zero is undefined, and showing 0% to someone who
       * completed three tasks they picked up mid-week is the same class of lie
       * as the silent denominator D-070 exists to prevent.
       *
       * So `rate` collapses two different situations into null, and the
       * caller MUST use `denominator` to tell them apart — 2B has to render
       * them differently:
       *     denominator === null → the week was never confirmed  ("—")
       *     denominator === 0    → confirmed with nothing in it  ("no commitments")
       */
      rate: (denominator === null || denominator.length === 0)
        ? null
        : t.completed.length / denominator.length
    };
  }

  /**
   * @param opts {
   *   window,        { start, end, mondayKey } from OpsDashThisWeek.opsWeek()
   *   taskOwners,    { taskId: [person, ...] } — resolved owners, "Both" already
   *                  expanded, so this function never re-derives ownership
   *   people,        [name, ...] — every person gets an entry, even at zero
   *   currentState,  D-027 map
   *   pins,          OpsDashEvents.pins()      — {taskId: isoMonday}
   *   pinEvents,     OpsDashEvents.pinEvents() — same, plus each pin's own
   *                  timestamp, which is what lets a move made THIS week be
   *                  told from an old pin pointing forward (D-078). Optional:
   *                  without it, a pin can only be judged when its task is in
   *                  the frozen commitment.
   *   discards,      OpsDashEvents.discards()
   *   cancels,       OpsDashEvents.cancels()
   *   commitment     OpsDashEvents.weekCommitment() → string[] | null
   * }
   *
   * @returns { team: <tally>, byPerson: { [person]: <tally> } }
   *
   * Counting rules, all from §12 / §11.5:
   *   completed — reached done with statusChangedAt INSIDE the window
   *               (truncated to its date part, D-028)
   *   moved     — pinned to a Monday LATER than this window's mondayKey
   *   discarded — present in the discards map (ad-hoc, D-067)
   *   cancelled — present in the cancels map (plan tasks, D-068), counted and
   *               reported SEPARATELY from discarded: a discard is meeting
   *               noise, a cancellation is a plan that stopped matching reality
   *   rate      — completed ÷ the frozen denominator, or null if unconfirmed
   *
   * The numerator is NOT clamped to the denominator. Work added mid-week counts
   * when finished but never inflates the frozen denominator (§11.5), so a rate
   * above 1 is a real, meaningful outcome — someone did more than they
   * committed to — and flattening it to 100% would hide that.
   *
   * Rock tasks are counted like any other (§12): in this company they ARE the
   * week's to-dos, and a rate that excluded them would measure half the week.
   */
  function weeklyCompletion(opts) {
    var window = opts.window;
    var people = opts.people || [];
    var taskOwners = opts.taskOwners || {};
    var currentState = opts.currentState || {};
    var pins = opts.pins || {};
    var pinEventMap = opts.pinEvents || {};
    var discardMap = opts.discards || {};
    var cancelMap = opts.cancels || {};
    var commitment = opts.commitment === undefined ? null : opts.commitment;

    var team = emptyTally();
    var byPerson = {};
    var i;
    for (i = 0; i < people.length; i++) byPerson[people[i]] = emptyTally();

    var committed = {};
    if (commitment) for (i = 0; i < commitment.length; i++) committed[commitment[i]] = true;

    /** Event date inside this window? Truncated to the day per D-028. */
    function inWindow(isoTimestamp) {
      if (!isoTimestamp) return false;
      var day = String(isoTimestamp).slice(0, 10);
      return day >= window.start && day <= window.end;
    }

    /**
     * The tasks this week is allowed to judge (D-078, correction 1): the frozen
     * commitment, plus anything whose OUTCOME-PRODUCING EVENT landed inside the
     * window.
     *
     * This used to sweep in every key of currentState, which meant every task
     * that had ever been touched in the whole sprint. Combined with the
     * membership-only tests below, a task discarded three weeks ago was
     * re-counted as discarded this week, and every week after — so the discard
     * rate §12 asks you to watch across a sprint inflated on its own.
     */
    var considered = {};
    addKeys(considered, committed);

    for (var sId in currentState) {
      if (!Object.prototype.hasOwnProperty.call(currentState, sId)) continue;
      var scs = currentState[sId];
      if (scs && scs.status === "done" && inWindow(scs.statusChangedAt)) considered[sId] = true;
    }
    for (var dId in discardMap) {
      if (!Object.prototype.hasOwnProperty.call(discardMap, dId)) continue;
      if (inWindow(discardMap[dId] && discardMap[dId].timestamp)) considered[dId] = true;
    }
    for (var cId in cancelMap) {
      if (!Object.prototype.hasOwnProperty.call(cancelMap, cId)) continue;
      if (inWindow(cancelMap[cId] && cancelMap[cId].timestamp)) considered[cId] = true;
    }
    for (var pId in pinEventMap) {
      if (!Object.prototype.hasOwnProperty.call(pinEventMap, pId)) continue;
      if (inWindow(pinEventMap[pId] && pinEventMap[pId].timestamp)) considered[pId] = true;
    }

    for (var taskId in considered) {
      if (!Object.prototype.hasOwnProperty.call(considered, taskId)) continue;

      var bucket = classify(taskId);
      if (!bucket) continue;

      team[bucket].push(taskId);

      var owners = taskOwners[taskId] || [];
      for (var o = 0; o < owners.length; o++) {
        if (byPerson[owners[o]]) byPerson[owners[o]][bucket].push(taskId);
      }
    }

    /**
     * One task → at most one outcome, with the FIXED priority D-078(b) locked:
     * completed > discarded > cancelled > moved. Deliberately not ordered by
     * timestamp, so the answer is stable and does not depend on the order
     * events happened to arrive in.
     *
     * Every outcome requires that its own event fell inside the window —
     * UNLESS the task is in the frozen commitment, which is this week's
     * commitment by definition and is therefore always judged (D-078,
     * correction 1; extended to `completed` by D-079).
     */
    function classify(taskId) {
      var isCommitted = committed[taskId] === true;

      // D-079: a COMMITTED task counts as completed even if it reached done
      // before the window opened. The frozen commitment is already the
      // membership filter for the week — if the id is in D-070's array it is
      // this week's by definition — so §12's "within the window" is there to
      // exclude noise from OUTSIDE (the defect D-078 fixed), not to withhold
      // credit for work that was genuinely committed. Leaving it out told a
      // person "you didn't do this" about finished work sitting in plain
      // sight, at the L10 close with the team watching, which is the failure
      // that stops people trusting the number at all.
      //
      // The window test still applies in full to anything NOT committed.
      var cs = currentState[taskId];
      if (cs && cs.status === "done" && (isCommitted || inWindow(cs.statusChangedAt))) {
        return "completed";
      }

      var dis = discardMap[taskId];
      if (dis && (isCommitted || inWindow(dis.timestamp))) return "discarded";

      var can = cancelMap[taskId];
      if (can && (isCommitted || inWindow(can.timestamp))) return "cancelled";

      // A move is a decision taken THIS week. An old pin that happens to point
      // at a far-off Monday is not a movement of this meeting, and counting it
      // every week until it arrives is exactly the inflation this guards.
      var pinEv = pinEventMap[taskId];
      var pinValue = pinEv ? pinEv.value : pins[taskId];
      if (pinValue && pinValue > window.mondayKey) {
        if (isCommitted || (pinEv && inWindow(pinEv.timestamp))) return "moved";
      }
      return null;
    }

    var out = { team: tallyCounts(team, commitment), byPerson: {} };
    for (i = 0; i < people.length; i++) {
      // Each person is rated against the slice of the frozen commitment that
      // is theirs — the team denominator would make everyone look behind.
      var person = people[i];
      var personCommitment = commitment === null ? null : commitment.filter(function (id) {
        return (taskOwners[id] || []).indexOf(person) !== -1;
      });
      out.byPerson[person] = tallyCounts(byPerson[person], personCommitment);
    }
    return out;
  }

  function addKeys(target, source) {
    for (var k in source) {
      if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * computeAll — the one call board.js needs per render
   * ------------------------------------------------------------------ */

  /**
   * @param cancelledSet OPTIONAL {taskId: true}, threaded down to progress()
   *        (D-068d). Omitting it means "nothing cancelled" and produces
   *        byte-identical output to every pre-Phase-8 call.
   *
   * onTrack() deliberately does NOT receive it: its planned curve is the
   * frozen promise and does not move when work is cancelled (D-068e), the
   * same reasoning as burnupSeries above.
   */
  function computeAll(plan, frozenPlanResult, currentState, todayISO, band, cancelledSet) {
    var idx = buildRockIndex(plan);
    var frozenTasks = frozenPlanResult.tasks;
    var allTaskIds = Object.keys(frozenTasks);

    var rocks = {};
    for (var i = 0; i < idx.rockOrder.length; i++) {
      var rockId = idx.rockOrder[i];
      var ids = idx.rockTaskIds[rockId];
      rocks[rockId] = {
        name: idx.rockName[rockId],
        progress: progress(frozenTasks, currentState, ids, cancelledSet),
        onTrack: onTrack(frozenTasks, currentState, ids, todayISO, band)
      };
    }

    return {
      sprint: {
        progress: progress(frozenTasks, currentState, allTaskIds, cancelledSet),
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
    weeklyCompletion: weeklyCompletion,
    computeAll: computeAll
  };
})(typeof window !== "undefined" ? window : this);
