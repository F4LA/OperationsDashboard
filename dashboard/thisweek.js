/**
 * Operations Dashboard — This Week (View §6.3, Phase 7)
 *
 * Pure computation layer for the per-person weekly focus view. The contract
 * is fixed by D-061 (ops-week window + Monday key) and D-063 (bucket
 * criteria, "Both" duplication, pull/postpone/cascade rules) — read those
 * before changing anything here. Rendering and the pin/unpin write path live
 * in board.js; this module only computes.
 *
 * Public API
 *   OpsDashThisWeek.opsWeek(todayISO, startDayName, offset)
 *       → { start, end, mondayKey }                              (D-061, D-071a)
 *   OpsDashThisWeek.buckets(liveResult, currentState, window, people)
 *       → { [person]: { done, workingOn, notStarted } }                (D-063a/b)
 *   OpsDashThisWeek.availableToPull(plan, currentState, cancelledTaskIds)
 *       → [{ id, desc, owner, blocked, blockedBy: [{id, desc, owner}] }]
 *                                          (§11.5, D-071b — SUPERSEDES D-063e)
 *   OpsDashThisWeek.cascadeOf(plan, taskId)
 *       → [{ id, desc, owner }]                                        (D-063d)
 *
 * D-063(c) is deliberately NOT implemented here: the pin is a presentation-
 * layer override of bucket MEMBERSHIP, applied by board.js on top of what
 * buckets() computes — it never touches the engine's own projection, so it
 * has no business inside this module's pure D-063(a)/(b) math.
 *
 * Requires OpsDashEngine (calendar helpers, D-027 currentState shape) and
 * OpsDashValidate (id index + §4.2 dependency fan-out) loaded first — no
 * second date parser, no second dependency resolver (D-024).
 */
(function (root) {
  "use strict";

  var DAY_MS = 86400000;
  var DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  var FALLBACK_DAY_INDEX = 5; // Friday — D-061's documented, non-silent fallback

  function getEngine() {
    var eng = root.OpsDashEngine || (typeof globalThis !== "undefined" && globalThis.OpsDashEngine);
    if (!eng || !eng._internals) {
      throw new Error("OpsDashThisWeek requires OpsDashEngine to be loaded first.");
    }
    return eng;
  }

  function getValidate() {
    var v = root.OpsDashValidate || (typeof globalThis !== "undefined" && globalThis.OpsDashValidate);
    if (!v) {
      throw new Error("OpsDashThisWeek requires OpsDashValidate to be loaded first.");
    }
    return v;
  }

  /**
   * Day-of-week index (0=Sunday..6=Saturday) of a calendar ms value. Reads
   * the day-of-week off an ALREADY-PARSED date (via engine.js's own
   * parseISO), the same technique engine.js's own isWorkingDayMs uses — not
   * a second "today" source, since no Date.now()/argless `new Date()` is
   * ever called here.
   */
  function dayIndexAt(ms) {
    return new Date(ms).getUTCDay();
  }

  /** English day name (case-insensitive) → 0..6, or -1 if unparseable (D-061). */
  function parseDayName(name) {
    var s = String(name === undefined || name === null ? "" : name).trim().toLowerCase();
    return DAY_NAMES.indexOf(s);
  }

  /* ------------------------------------------------------------------ *
   * opsWeek (D-061)
   * ------------------------------------------------------------------ */

  /**
   * @param todayISO      "YYYY-MM-DD", explicit — never Date.now() (same
   *                      discipline as D-027/engine.js).
   * @param startDayName  English day name (case-insensitive), verbatim from
   *                      Settings.opsWeekStartDay. Missing/unparseable falls
   *                      back to Friday here too — defensive, so this stays a
   *                      total pure function; the DOCUMENTED, non-silent
   *                      fallback point per D-061 is app.js's own read of
   *                      Settings (same pattern as the band fallback there).
   * @param offset        OPTIONAL, default 0 (§11.1, D-071a). -1 = the week
   *                      that is CLOSING, +1 = the one OPENING. Two-argument
   *                      calls keep working unchanged.
   *
   * The offset shifts the WINDOW by 7 calendar days and the mondayKey is then
   * recomputed from the shifted window — not by adding 7 to the unshifted
   * mondayKey separately. Same answer today, but the two would drift apart the
   * moment opsWeekStartDay changes, and deriving both from one window keeps
   * "the key is the single Monday inside this window" true by construction
   * rather than by coincidence.
   */
  function opsWeek(todayISO, startDayName, offset) {
    var eng = getEngine();
    var parseISO = eng._internals.parseISO;
    var formatISO = eng._internals.formatISO;

    var startIdx = parseDayName(startDayName);
    if (startIdx === -1) startIdx = FALLBACK_DAY_INDEX;

    var shift = typeof offset === "number" && isFinite(offset) ? Math.round(offset) : 0;

    var todayMs = parseISO(todayISO);
    var todayIdx = dayIndexAt(todayMs);

    // windowStart = the most recent startIdx weekday on or before today,
    // then moved whole weeks by the offset.
    var back = (todayIdx - startIdx + 7) % 7;
    var windowStartMs = todayMs - back * DAY_MS + shift * 7 * DAY_MS;
    var windowEndMs = windowStartMs + 6 * DAY_MS;

    // Any 7-day window contains exactly one Monday (getUTCDay index 1) —
    // holds for any startIdx, which is D-061's own justification for using
    // the Monday as the pin's canonical week key. Computed from the SHIFTED
    // window, so it stays that window's own Monday for every offset.
    var mondayOffset = (1 - startIdx + 7) % 7;
    var mondayMs = windowStartMs + mondayOffset * DAY_MS;

    return {
      start: formatISO(windowStartMs),
      end: formatISO(windowEndMs),
      mondayKey: formatISO(mondayMs)
    };
  }

  /* ------------------------------------------------------------------ *
   * buckets (D-063a/b)
   * ------------------------------------------------------------------ */

  /**
   * @param liveResult    OpsDashEngine.liveMode() result — .tasks entries
   *                      already carry the resolved .owners array (Both →
   *                      both names), so owner resolution is never redone
   *                      here.
   * @param currentState  D-027 map: { taskId: {status, statusChangedAt} }
   * @param window        { start, end } from opsWeek(), inclusive ISO dates
   * @param people        plan.people (array of names) — every person gets an
   *                      entry even with zero tasks, so a column can render
   *                      empty rather than being absent.
   */
  function buckets(liveResult, currentState, window, people) {
    var out = {};
    for (var i = 0; i < people.length; i++) {
      out[people[i]] = { done: [], workingOn: [], notStarted: [] };
    }

    var tasks = (liveResult && liveResult.tasks) || {};
    for (var taskId in tasks) {
      if (!Object.prototype.hasOwnProperty.call(tasks, taskId)) continue;
      var task = tasks[taskId];
      var owners = task.owners || [task.owner];
      var cs = currentState[taskId];
      var status = cs && cs.status ? cs.status : "open";

      var bucketKey = null;
      if (status === "done") {
        if (cs && cs.statusChangedAt) {
          var datePart = String(cs.statusChangedAt).slice(0, 10); // D-028 truncation
          if (datePart >= window.start && datePart <= window.end) bucketKey = "done";
        }
      } else if (status === "in_progress") {
        bucketKey = "workingOn"; // no window filter (D-063a)
      } else {
        // "open": the live projection overlaps the window (D-063a)
        if (task.plannedStart && task.plannedFinish &&
          task.plannedStart <= window.end && task.plannedFinish >= window.start) {
          bucketKey = "notStarted";
        }
      }

      if (!bucketKey) continue;

      for (var j = 0; j < owners.length; j++) {
        if (out[owners[j]]) out[owners[j]][bucketKey].push(taskId);
      }
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * availableToPull (D-063e)
   * ------------------------------------------------------------------ */

  function taskIsDeferred(task, milestone) {
    return task.deferred === true || (milestone && milestone.deferred === true);
  }

  /**
   * Candidates for "+ add to this week" (§11.5).
   *
   * CONTRACT CHANGED by D-071(b), which SUPERSEDES D-063(e). This used to drop
   * blocked tasks with a `continue`; it now RETURNS them, flagged, naming each
   * unfinished dependency AND that dependency's owner.
   *
   * The owner is the entire point of the change, not a detail: it is what
   * produces the sentence "this depends on something of Emery's — Emery, can
   * you get it done this week?", and lets both commitments land in the same
   * week where they can be seen. Hiding blocked tasks hid the coordination.
   *
   * @param plan            the raw sprint-plan (for OpsDashValidate.buildIndex)
   * @param currentState    D-027 map
   * @param cancelledTaskIds OPTIONAL array — the SAME set handed to
   *                        engine.liveMode, so a cancelled task cannot be
   *                        offered for pulling into a week
   * @returns [{ id, desc, owner, blocked, blockedBy: [{id, desc, owner}] }]
   *          ordered by id. blockedBy is [] when blocked is false.
   */
  function availableToPull(plan, currentState, cancelledTaskIds) {
    var V = getValidate();
    var index = V.buildIndex(plan);
    var out = [];

    var cancelled = {};
    if (Array.isArray(cancelledTaskIds)) {
      for (var c = 0; c < cancelledTaskIds.length; c++) cancelled[cancelledTaskIds[c]] = true;
    }

    for (var i = 0; i < index.taskOrder.length; i++) {
      var id = index.taskOrder[i];
      var task = index.tasks[id];
      var milestone = index.milestones[index.milestoneOfTask[id]];
      if (taskIsDeferred(task, milestone)) continue;
      if (cancelled[id]) continue; // D-068: a cancelled task is not pullable

      var cs = currentState[id];
      var status = cs && cs.status ? cs.status : "open";
      if (status !== "open") continue;

      // §4.2 fan-out — the SAME resolver planMode/liveMode use (D-024), never
      // re-implemented here.
      var resolved = V.resolveDeps(task, index);
      var blockedBy = [];
      for (var j = 0; j < resolved.taskIds.length; j++) {
        var depId = resolved.taskIds[j];
        if (depId === id) continue;
        // A cancelled dependency no longer blocks: it left the schedule by the
        // same route a deferred one does (D-068c), so treating it as an open
        // blocker here would contradict the dates the engine is showing.
        if (cancelled[depId]) continue;
        var depState = currentState[depId];
        if (!depState || depState.status !== "done") {
          var depTask = index.tasks[depId];
          blockedBy.push({
            id: depId,
            desc: depTask ? depTask.desc : null,
            owner: depTask ? depTask.owner : null
          });
        }
      }

      out.push({
        id: id,
        desc: task.desc,
        owner: task.owner,
        blocked: blockedBy.length > 0,
        blockedBy: blockedBy
      });
    }

    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * cascadeOf (D-063d)
   * ------------------------------------------------------------------ */

  /**
   * Every task that transitively depends on `taskId`, with owner — feeds the
   * postpone-confirmation cascade. Informative only (D-063d): it warns, it
   * never blocks the postpone itself.
   */
  function cascadeOf(plan, taskId) {
    var V = getValidate();
    var index = V.buildIndex(plan);

    // Reverse-edge (dependents) map built from the SAME §4.2 fan-out
    // resolveDeps already provides — no second dependency resolver (D-024).
    var dependents = {};
    for (var i = 0; i < index.taskOrder.length; i++) dependents[index.taskOrder[i]] = [];
    for (var j = 0; j < index.taskOrder.length; j++) {
      var id = index.taskOrder[j];
      var resolved = V.resolveDeps(index.tasks[id], index);
      for (var k = 0; k < resolved.taskIds.length; k++) {
        var depId = resolved.taskIds[k];
        if (dependents[depId]) dependents[depId].push(id);
      }
    }

    var seen = {};
    var stack = (dependents[taskId] || []).slice();
    var out = [];
    while (stack.length) {
      var cur = stack.pop();
      if (seen[cur]) continue;
      seen[cur] = true;
      var t = index.tasks[cur];
      out.push({ id: cur, desc: t.desc, owner: t.owner });
      var next = dependents[cur] || [];
      for (var n = 0; n < next.length; n++) if (!seen[next[n]]) stack.push(next[n]);
    }

    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  root.OpsDashThisWeek = {
    opsWeek: opsWeek,
    buckets: buckets,
    availableToPull: availableToPull,
    cascadeOf: cascadeOf
  };
})(typeof window !== "undefined" ? window : this);
