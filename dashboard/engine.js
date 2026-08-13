/**
 * Operations Dashboard — Date Engine (PLAN MODE)
 *
 * Spec §4. Live mode (§4.7) is a later phase and is deliberately NOT implemented here.
 *
 * Semantics are fixed by D-020 (continuous working-day axis) and D-021 (deterministic
 * one-task-at-a-time scheduling), with deferred handling per D-017.
 *
 * The axis (D-020)
 *   Every working day (Mon–Fri) has width 1.0; weekends have width 0. Position N (an
 *   integer) is the START of the N-th working day counted from nextWorkingDay(sprint.start);
 *   a fraction is a point inside that day. Because only working days occupy the axis,
 *   `startPos + workDays` is plain addition — no weekend special-casing — and two half-day
 *   tasks for the same owner land on the same calendar day, per §4.1.
 *
 * Finish semantics (D-020)
 *   waitDays === 0 → finishPos = workEndPos. The finish stays at a continuous position
 *                    (possibly mid-day) so a dependent of the same owner can continue the
 *                    same day. The reported DATE is the last working day actually touched.
 *   waitDays  >  0 → the wait is CALENDAR time from the end of the active work; the finish
 *                    is then anchored to the START of the first working day on/after that
 *                    date, so a dependent begins that day from the beginning.
 *   In both cases the owner's availableFrom is released at workEndPos — free DURING the
 *   wait (§4.3, §4.5).
 *
 * Public API
 *   OpsDashEngine.planMode(plan)  → {ok, errors, tasks, milestones, rocks, order, stats}
 *
 * Requires OpsDashValidate (loaded before this file) for the id index and the §4.2
 * dependency fan-out, so that rule has exactly one implementation.
 */
(function (root) {
  "use strict";

  var DAY_MS = 86400000;
  var EPSILON = 1e-9;
  var AXIS_CAP = 20000; // guards against a runaway wait pushing the axis forever

  /* ------------------------------------------------------------------ *
   * Numeric helpers — positions are sums of halves/quarters, but snap
   * anyway so floor() can never trip on a representation artifact.
   * ------------------------------------------------------------------ */

  function snap(x) {
    return Math.round(x * 1e6) / 1e6;
  }

  function isIntegerPos(x) {
    return Math.abs(x - Math.round(x)) < EPSILON;
  }

  /** Index of the working day a position sits inside. */
  function dayIndexAt(pos) {
    return isIntegerPos(pos) ? Math.round(pos) : Math.floor(pos);
  }

  /**
   * Index of the last working day actually OCCUPIED by work ending at `pos`.
   * A position landing exactly on an integer means the work filled the previous
   * day and stopped at its boundary. Never reported before `minIndex` (the start
   * day), which keeps a zero-duration task on its own start date.
   */
  function lastTouchedIndex(pos, minIndex) {
    var i = isIntegerPos(pos) ? Math.round(pos) - 1 : Math.floor(pos);
    return i < minIndex ? minIndex : i;
  }

  /* ------------------------------------------------------------------ *
   * Calendar helpers (§4.1) — all UTC, so DST can never shift a date.
   * ------------------------------------------------------------------ */

  function parseISO(iso) {
    var parts = String(iso).split("-");
    return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function formatISO(ms) {
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return d.getUTCFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  function isWorkingDayMs(ms) {
    var dow = new Date(ms).getUTCDay();
    return dow !== 0 && dow !== 6; // 0 = Sunday, 6 = Saturday
  }

  /* ------------------------------------------------------------------ *
   * The working-day axis (D-020)
   * ------------------------------------------------------------------ */

  function Axis(sprintStartMs) {
    this.days = [];
    this.cursor = sprintStartMs;
  }

  Axis.prototype._extendTo = function (index) {
    if (index > AXIS_CAP) {
      throw new Error("Working-day axis exceeded " + AXIS_CAP + " days; check waitDays for a runaway value.");
    }
    while (this.days.length <= index) {
      while (!isWorkingDayMs(this.cursor)) this.cursor += DAY_MS;
      this.days.push(this.cursor);
      this.cursor += DAY_MS;
    }
  };

  /** Calendar ms of working day `index`. Index 0 = nextWorkingDay(sprint.start) (§4.3). */
  Axis.prototype.dateAt = function (index) {
    this._extendTo(index);
    return this.days[index];
  };

  /** Index of the first working day on or after a calendar date (nextWorkingDay, §4.1). */
  Axis.prototype.indexOnOrAfter = function (ms) {
    var i = 0;
    for (;;) {
      this._extendTo(i);
      if (this.days[i] >= ms) return i;
      i++;
    }
  };

  /* ------------------------------------------------------------------ *
   * Graph
   * ------------------------------------------------------------------ */

  function getValidate(root_) {
    var v = root_ && root_.OpsDashValidate;
    if (!v && typeof globalThis !== "undefined") v = globalThis.OpsDashValidate;
    if (!v) {
      throw new Error("OpsDashEngine requires OpsDashValidate to be loaded first.");
    }
    return v;
  }

  /** A milestone marked deferred propagates to every one of its tasks (D-017). */
  function collectActive(plan, index) {
    var active = [];
    var deferred = [];

    for (var i = 0; i < index.taskOrder.length; i++) {
      var id = index.taskOrder[i];
      var task = index.tasks[id];
      var milestone = index.milestones[index.milestoneOfTask[id]];
      var isDeferred = task.deferred === true || (milestone && milestone.deferred === true);
      if (isDeferred) deferred.push(id);
      else active.push(id);
    }

    return { active: active, deferred: deferred };
  }

  function ownersOf(task, people) {
    if (task.owner === "Both") return people.slice();
    return [task.owner];
  }

  /** Transitive count of tasks that depend on each task — §4.4 criterion (a). */
  function downstreamCounts(activeIds, prereqs) {
    var dependents = {};
    var i, j;

    for (i = 0; i < activeIds.length; i++) dependents[activeIds[i]] = [];
    for (i = 0; i < activeIds.length; i++) {
      var id = activeIds[i];
      var list = prereqs[id];
      for (j = 0; j < list.length; j++) {
        if (dependents[list[j]]) dependents[list[j]].push(id);
      }
    }

    var counts = {};
    for (i = 0; i < activeIds.length; i++) {
      var startId = activeIds[i];
      var seen = {};
      var stack = dependents[startId].slice();
      var n = 0;
      while (stack.length) {
        var cur = stack.pop();
        if (seen[cur]) continue;
        seen[cur] = true;
        n++;
        var next = dependents[cur];
        for (j = 0; j < next.length; j++) if (!seen[next[j]]) stack.push(next[j]);
      }
      counts[startId] = n;
    }

    return counts;
  }

  /* ------------------------------------------------------------------ *
   * Ordering (§4.4 + D-021)
   * ------------------------------------------------------------------ */

  /**
   * Builds person → {taskId: rank} from every rock.executionOrder (§4.4).
   * An id absent from a person's list ranks after every listed id.
   */
  function buildExecutionOrder(plan) {
    var ranks = {};
    var rocks = plan.rocks || [];

    for (var r = 0; r < rocks.length; r++) {
      var eo = rocks[r].executionOrder;
      if (!eo || typeof eo !== "object") continue;
      for (var person in eo) {
        if (!Object.prototype.hasOwnProperty.call(eo, person)) continue;
        var list = eo[person];
        if (!Array.isArray(list)) continue;
        if (!ranks[person]) ranks[person] = {};
        for (var i = 0; i < list.length; i++) {
          if (ranks[person][list[i]] === undefined) ranks[person][list[i]] = i;
        }
      }
    }

    return ranks;
  }

  function makeComparator(ctx) {
    var index = ctx.index;
    var counts = ctx.counts;
    var execRanks = ctx.execRanks;
    var people = ctx.people;

    function ownerKey(id) {
      return ownersOf(index.tasks[id], people).slice().sort().join("+");
    }

    function deadlineOf(id) {
      var hd = index.tasks[id].hardDeadline;
      return hd ? parseISO(hd) : Infinity;
    }

    function totalDuration(id) {
      var t = index.tasks[id];
      return (t.workDays || 0) + (t.waitDays || 0);
    }

    /**
     * executionOrder overrides §4.4 for that person. Applied only between two tasks
     * carrying the SAME owner signature whose owner has a list — the spec defines the
     * override per person, not across people, so cross-person pairs fall through to
     * the §4.4 priority rules.
     */
    function execCompare(a, b) {
      if (ownerKey(a) !== ownerKey(b)) return 0;
      var owners = ownersOf(index.tasks[a], people);
      for (var i = 0; i < owners.length; i++) {
        var table = execRanks[owners[i]];
        if (!table) continue;
        var ra = table[a] === undefined ? Infinity : table[a];
        var rb = table[b] === undefined ? Infinity : table[b];
        if (ra !== rb) return ra - rb;
      }
      return 0;
    }

    return function (a, b) {
      var eo = execCompare(a, b);
      if (eo !== 0) return eo;

      // (a) unblocks the most downstream work, most first
      if (counts[a] !== counts[b]) return counts[b] - counts[a];

      // (b) earliest hardDeadline
      var da = deadlineOf(a);
      var db = deadlineOf(b);
      if (da !== db) return da - db;

      // (c) longest total duration
      var ta = totalDuration(a);
      var tb = totalDuration(b);
      if (ta !== tb) return tb - ta;

      // (d) final, total tie-break: task.id ascending (D-021)
      return a < b ? -1 : a > b ? 1 : 0;
    };
  }

  /* ------------------------------------------------------------------ *
   * planMode(plan)
   * ------------------------------------------------------------------ */

  function planMode(plan) {
    var errors = [];
    var V = getValidate(root);
    var index = V.buildIndex(plan);
    var people = Array.isArray(plan.people) ? plan.people.slice() : [];
    var i, j;

    if (!plan || !plan.sprint || !plan.sprint.start) {
      return {
        ok: false,
        errors: [{ code: "SPRINT_START_MISSING", message: "sprint.start is required to run the engine." }],
        tasks: {}, milestones: {}, rocks: {}, order: [], deferredTasks: [],
        stats: { scheduled: 0, deferred: 0 }
      };
    }

    var sprintStartMs = parseISO(plan.sprint.start);
    var sprintEndMs = plan.sprint.end ? parseISO(plan.sprint.end) : null;
    var axis = new Axis(sprintStartMs);

    /* ---- active vs deferred (D-017) ---- */
    var split = collectActive(plan, index);
    var activeIds = split.active;
    var activeSet = {};
    for (i = 0; i < activeIds.length; i++) activeSet[activeIds[i]] = true;

    /* ---- prerequisites (§4.2), narrowed to active tasks ----
       A milestone reference fans out to all its tasks; deferred ones are dropped
       because they never schedule and would otherwise block their dependents. */
    var prereqs = {};
    for (i = 0; i < activeIds.length; i++) {
      var id = activeIds[i];
      var resolved = V.resolveDeps(index.tasks[id], index);
      var list = [];
      for (j = 0; j < resolved.taskIds.length; j++) {
        var dep = resolved.taskIds[j];
        if (dep !== id && activeSet[dep]) list.push(dep);
      }
      prereqs[id] = list;
    }

    var counts = downstreamCounts(activeIds, prereqs);
    var comparator = makeComparator({
      index: index,
      counts: counts,
      execRanks: buildExecutionOrder(plan),
      people: people
    });

    /* ---- resources (§4.3): everyone starts at position 0 ---- */
    var availableFrom = {};
    for (i = 0; i < people.length; i++) availableFrom[people[i]] = 0;

    /* ---- scheduling loop (§4.5 as fixed by D-021) ---- */
    var tasks = {};
    var scheduled = {};
    var order = [];
    var remaining = activeIds.slice();

    while (remaining.length) {
      var ready = [];
      for (i = 0; i < remaining.length; i++) {
        var candidate = remaining[i];
        var deps = prereqs[candidate];
        var allDone = true;
        for (j = 0; j < deps.length; j++) {
          if (!scheduled[deps[j]]) { allDone = false; break; }
        }
        if (allDone) ready.push(candidate);
      }

      if (!ready.length) {
        errors.push({
          code: "DEPENDENCY_DEADLOCK",
          message: "Cannot schedule the remaining task(s) — every one is waiting on another " +
            "unscheduled task: " + remaining.slice().sort().join(", ") + ".",
          ids: remaining.slice().sort()
        });
        break;
      }

      ready.sort(comparator);
      var pick = ready[0];
      var task = index.tasks[pick];
      var owners = ownersOf(task, people);

      /* depFinish = max finish position of prerequisites, else the sprint start (§4.5) */
      var depFinishPos = 0;
      var picked = prereqs[pick];
      for (i = 0; i < picked.length; i++) {
        var pf = tasks[picked[i]].finishPos;
        if (pf > depFinishPos) depFinishPos = pf;
      }

      /* resourceFree = max availableFrom across owners; "Both" waits for the later (§4.3) */
      var resourceFreePos = 0;
      for (i = 0; i < owners.length; i++) {
        var af = availableFrom[owners[i]] || 0;
        if (af > resourceFreePos) resourceFreePos = af;
      }

      var startPos = snap(Math.max(depFinishPos, resourceFreePos));
      var startIndex = dayIndexAt(startPos);
      var workDays = task.workDays || 0;
      var waitDays = task.waitDays || 0;
      var workEndPos = snap(startPos + workDays);
      var workEndIndex = lastTouchedIndex(workEndPos, startIndex);

      var finishPos;
      var finishIndex;

      if (waitDays > 0) {
        // Wait is CALENDAR time from the end of the active work, then the finish is
        // anchored to the start of the next working day on/after it (D-020).
        var targetMs = axis.dateAt(workEndIndex) + waitDays * DAY_MS;
        finishIndex = axis.indexOnOrAfter(targetMs);
        finishPos = finishIndex;
      } else {
        finishPos = workEndPos;
        finishIndex = workEndIndex;
      }

      // Owner is free at the end of the ACTIVE work — free during the wait (§4.3/§4.5).
      for (i = 0; i < owners.length; i++) availableFrom[owners[i]] = workEndPos;

      tasks[pick] = {
        id: pick,
        milestoneId: index.milestoneOfTask[pick],
        owner: task.owner,
        owners: owners,
        type: task.type,
        workDays: workDays,
        waitDays: waitDays,
        plannedStart: formatISO(axis.dateAt(startIndex)),
        plannedFinish: formatISO(axis.dateAt(finishIndex)),
        startPos: startPos,
        workEndPos: workEndPos,
        finishPos: finishPos,
        deferred: false
      };

      scheduled[pick] = true;
      order.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }

    /* ---- roll-up (§4.6) ---- */
    var milestones = {};
    for (i = 0; i < index.milestoneOrder.length; i++) {
      var mid = index.milestoneOrder[i];
      var milestone = index.milestones[mid];
      var memberIds = index.tasksOfMilestone[mid] || [];
      var scheduledMembers = [];
      var maxFinishMs = null;

      for (j = 0; j < memberIds.length; j++) {
        var member = tasks[memberIds[j]];
        if (!member) continue; // deferred, or unscheduled because of a deadlock
        scheduledMembers.push(memberIds[j]);
        var ms = parseISO(member.plannedFinish);
        if (maxFinishMs === null || ms > maxFinishMs) maxFinishMs = ms;
      }

      // A milestone with no non-deferred tasks has no date — skip it rather than
      // taking max over an empty set (§4.6 guard).
      milestones[mid] = {
        id: mid,
        deferred: milestone.deferred === true,
        taskIds: memberIds.slice(),
        scheduledTaskIds: scheduledMembers,
        plannedFinish: maxFinishMs === null ? null : formatISO(maxFinishMs),
        red: maxFinishMs !== null && sprintEndMs !== null && maxFinishMs > sprintEndMs
      };
    }

    var rocks = {};
    for (i = 0; i < (plan.rocks || []).length; i++) {
      var rock = plan.rocks[i];
      var rockMax = null;
      var projects = Array.isArray(rock.projects) ? rock.projects : [];

      for (j = 0; j < projects.length; j++) {
        var mlist = Array.isArray(projects[j].milestones) ? projects[j].milestones : [];
        for (var k = 0; k < mlist.length; k++) {
          var entry = milestones[mlist[k].id];
          if (!entry || !entry.plannedFinish) continue; // no dated milestone → skip
          var mms = parseISO(entry.plannedFinish);
          if (rockMax === null || mms > rockMax) rockMax = mms;
        }
      }

      rocks[rock.id] = {
        id: rock.id,
        plannedFinish: rockMax === null ? null : formatISO(rockMax),
        red: rockMax !== null && sprintEndMs !== null && rockMax > sprintEndMs
      };
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      mode: "plan",
      sprint: {
        start: plan.sprint.start,
        end: plan.sprint.end || null,
        goLive: plan.sprint.goLive || null,
        firstWorkingDay: formatISO(axis.dateAt(0))
      },
      tasks: tasks,
      milestones: milestones,
      rocks: rocks,
      order: order,
      deferredTasks: split.deferred,
      stats: {
        scheduled: order.length,
        active: activeIds.length,
        deferred: split.deferred.length
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * liveMode(plan, currentState, todayISO) — spec §4.7, semantics fixed by
   * D-027–D-031. Does not modify planMode; shares its id index and priority
   * comparator (buildIndex, collectActive, ownersOf, downstreamCounts,
   * makeComparator, buildExecutionOrder) via the same module-level helpers.
   * The dependency-fan-out and roll-up steps mirror planMode's inline logic
   * in the two small helpers below, duplicated rather than extracted from
   * planMode's body, which this change must leave untouched (D-031).
   * ------------------------------------------------------------------ */

  /** Truncates an ISO timestamp (with or without a time part) to its date (D-028). */
  function truncateToDateMs(iso) {
    var s = String(iso);
    return parseISO(s.length >= 10 ? s.slice(0, 10) : s);
  }

  /** Same §4.2 fan-out planMode computes inline, narrowed to active ids. */
  function buildPrereqsFor(V, index, activeIds, activeSet) {
    var prereqs = {};
    for (var i = 0; i < activeIds.length; i++) {
      var id = activeIds[i];
      var resolved = V.resolveDeps(index.tasks[id], index);
      var list = [];
      for (var j = 0; j < resolved.taskIds.length; j++) {
        var dep = resolved.taskIds[j];
        if (dep !== id && activeSet[dep]) list.push(dep);
      }
      prereqs[id] = list;
    }
    return prereqs;
  }

  /** Same §4.6 roll-up planMode computes inline, generalized over any tasks map. */
  function computeRollup(plan, index, tasksMap, sprintEndMs) {
    var milestones = {};
    var i, j, k;

    for (i = 0; i < index.milestoneOrder.length; i++) {
      var mid = index.milestoneOrder[i];
      var milestone = index.milestones[mid];
      var memberIds = index.tasksOfMilestone[mid] || [];
      var scheduledMembers = [];
      var maxFinishMs = null;

      for (j = 0; j < memberIds.length; j++) {
        var member = tasksMap[memberIds[j]];
        if (!member) continue; // deferred, or unscheduled (deadlock / missing timestamp)
        scheduledMembers.push(memberIds[j]);
        var ms = parseISO(member.plannedFinish);
        if (maxFinishMs === null || ms > maxFinishMs) maxFinishMs = ms;
      }

      milestones[mid] = {
        id: mid,
        deferred: milestone.deferred === true,
        taskIds: memberIds.slice(),
        scheduledTaskIds: scheduledMembers,
        plannedFinish: maxFinishMs === null ? null : formatISO(maxFinishMs),
        red: maxFinishMs !== null && sprintEndMs !== null && maxFinishMs > sprintEndMs
      };
    }

    var rocks = {};
    for (i = 0; i < (plan.rocks || []).length; i++) {
      var rock = plan.rocks[i];
      var rockMax = null;
      var projects = Array.isArray(rock.projects) ? rock.projects : [];

      for (j = 0; j < projects.length; j++) {
        var mlist = Array.isArray(projects[j].milestones) ? projects[j].milestones : [];
        for (k = 0; k < mlist.length; k++) {
          var entry = milestones[mlist[k].id];
          if (!entry || !entry.plannedFinish) continue;
          var mms = parseISO(entry.plannedFinish);
          if (rockMax === null || mms > rockMax) rockMax = mms;
        }
      }

      rocks[rock.id] = {
        id: rock.id,
        plannedFinish: rockMax === null ? null : formatISO(rockMax),
        red: rockMax !== null && sprintEndMs !== null && rockMax > sprintEndMs
      };
    }

    return { milestones: milestones, rocks: rocks };
  }

  function liveMode(plan, currentState, todayISO) {
    var errors = [];
    var V = getValidate(root);

    if (!plan || !plan.sprint || !plan.sprint.start) {
      return {
        ok: false,
        errors: [{ code: "SPRINT_START_MISSING", message: "sprint.start is required to run the engine." }],
        mode: "live", tasks: {}, milestones: {}, rocks: {}, order: [], fixedTaskIds: [],
        deferredTasks: [], stats: { scheduled: 0, fixed: 0, deferred: 0 }
      };
    }
    if (!todayISO) {
      return {
        ok: false,
        errors: [{ code: "TODAY_MISSING", message: "liveMode requires an explicit todayISO parameter (never Date.now(), per D-027)." }],
        mode: "live", tasks: {}, milestones: {}, rocks: {}, order: [], fixedTaskIds: [],
        deferredTasks: [], stats: { scheduled: 0, fixed: 0, deferred: 0 }
      };
    }

    var index = V.buildIndex(plan);
    var people = Array.isArray(plan.people) ? plan.people.slice() : [];
    var i, j;

    var sprintStartMs = parseISO(plan.sprint.start);
    var sprintEndMs = plan.sprint.end ? parseISO(plan.sprint.end) : null;
    var axis = new Axis(sprintStartMs);

    /* ---- active vs deferred (D-017), same as plan mode ---- */
    var split = collectActive(plan, index);
    var activeIds = split.active;
    var activeSet = {};
    for (i = 0; i < activeIds.length; i++) activeSet[activeIds[i]] = true;

    var prereqs = buildPrereqsFor(V, index, activeIds, activeSet);
    var counts = downstreamCounts(activeIds, prereqs);
    var comparator = makeComparator({
      index: index,
      counts: counts,
      execRanks: buildExecutionOrder(plan),
      people: people
    });

    var state = currentState || {};
    var todayPos = axis.indexOnOrAfter(parseISO(todayISO));

    var availableFrom = {};
    for (i = 0; i < people.length; i++) availableFrom[people[i]] = 0;

    var tasks = {};
    var scheduled = {};
    var doneIds = [];
    var inProgressIds = [];
    var openIds = [];
    var fixedTaskIds = [];

    for (i = 0; i < activeIds.length; i++) {
      var tid = activeIds[i];
      var entry = state[tid];
      var status = entry && entry.status ? entry.status : "open";
      if (status === "done") doneIds.push(tid);
      else if (status === "in_progress") inProgressIds.push(tid);
      else openIds.push(tid);
      if (status === "done" || status === "in_progress") fixedTaskIds.push(tid);
    }

    /* ---- pass 1: done tasks fixed to their real completion date ---- */
    for (i = 0; i < doneIds.length; i++) {
      var did = doneIds[i];
      var dtask = index.tasks[did];
      var dentry = state[did] || {};
      var downers = ownersOf(dtask, people);

      if (!dentry.statusChangedAt) {
        errors.push({
          code: "MISSING_COMPLETED_AT", id: did,
          message: "Task " + did + " is marked done but has no statusChangedAt; cannot fix its date."
        });
        continue; // report, don't crash — task stays unscheduled
      }

      var completedMs = truncateToDateMs(dentry.statusChangedAt);
      var dFinishIndex = axis.indexOnOrAfter(completedMs);
      var dWaitDays = dtask.waitDays || 0;
      var dWorkEndIndex = axis.indexOnOrAfter(completedMs - dWaitDays * DAY_MS);

      tasks[did] = {
        id: did,
        milestoneId: index.milestoneOfTask[did],
        owner: dtask.owner,
        owners: downers,
        type: dtask.type,
        workDays: dtask.workDays || 0,
        waitDays: dWaitDays,
        status: "done",
        plannedStart: null,
        plannedFinish: formatISO(axis.dateAt(dFinishIndex)),
        startPos: null,
        workEndPos: dWorkEndIndex,
        finishPos: dFinishIndex,
        clamped: false,
        deferred: false
      };

      for (j = 0; j < downers.length; j++) {
        availableFrom[downers[j]] = Math.max(availableFrom[downers[j]] || 0, dWorkEndIndex);
      }
      scheduled[did] = true;
    }

    /* ---- pass 2: in_progress tasks fixed to their real start, finish clamped to today ---- */
    for (i = 0; i < inProgressIds.length; i++) {
      var pid = inProgressIds[i];
      var ptask = index.tasks[pid];
      var pentry = state[pid] || {};
      var powners = ownersOf(ptask, people);

      if (!pentry.statusChangedAt) {
        errors.push({
          code: "MISSING_STATUS_CHANGED_AT", id: pid,
          message: "Task " + pid + " is marked in_progress but has no statusChangedAt; cannot fix its start."
        });
        continue;
      }

      var startIndex = axis.indexOnOrAfter(truncateToDateMs(pentry.statusChangedAt));
      var startPos = startIndex;
      var pWorkDays = ptask.workDays || 0;
      var pWaitDays = ptask.waitDays || 0;
      var rawWorkEndPos = snap(startPos + pWorkDays);
      var clamped = rawWorkEndPos < todayPos;
      var workEndPos = clamped ? todayPos : rawWorkEndPos;
      var workEndIndex = lastTouchedIndex(workEndPos, startIndex);

      var pFinishPos, pFinishIndex;
      if (pWaitDays > 0) {
        var pTargetMs = axis.dateAt(workEndIndex) + pWaitDays * DAY_MS;
        pFinishIndex = axis.indexOnOrAfter(pTargetMs);
        pFinishPos = pFinishIndex;
      } else {
        pFinishPos = workEndPos;
        pFinishIndex = workEndIndex;
      }

      tasks[pid] = {
        id: pid,
        milestoneId: index.milestoneOfTask[pid],
        owner: ptask.owner,
        owners: powners,
        type: ptask.type,
        workDays: pWorkDays,
        waitDays: pWaitDays,
        status: "in_progress",
        plannedStart: formatISO(axis.dateAt(startIndex)),
        plannedFinish: formatISO(axis.dateAt(pFinishIndex)),
        startPos: startPos,
        workEndPos: workEndPos,
        finishPos: pFinishPos,
        clamped: clamped,
        deferred: false
      };

      for (j = 0; j < powners.length; j++) {
        availableFrom[powners[j]] = Math.max(availableFrom[powners[j]] || 0, workEndPos);
      }
      scheduled[pid] = true;
    }

    /* ---- pass 3: schedule the open remainder — planMode's exact loop (§4.5/D-021),
       with today added as a third floor under startPos ---- */
    var order = [];
    var remaining = openIds.slice();

    while (remaining.length) {
      var ready = [];
      for (i = 0; i < remaining.length; i++) {
        var candidate = remaining[i];
        var deps = prereqs[candidate];
        var allDone = true;
        for (j = 0; j < deps.length; j++) {
          if (!scheduled[deps[j]]) { allDone = false; break; }
        }
        if (allDone) ready.push(candidate);
      }

      if (!ready.length) {
        errors.push({
          code: "DEPENDENCY_DEADLOCK",
          message: "Cannot schedule the remaining open task(s) — every one is waiting on another " +
            "unscheduled task: " + remaining.slice().sort().join(", ") + ".",
          ids: remaining.slice().sort()
        });
        break;
      }

      ready.sort(comparator);
      var pick = ready[0];
      var task = index.tasks[pick];
      var owners = ownersOf(task, people);

      var depFinishPos = 0;
      var picked = prereqs[pick];
      for (i = 0; i < picked.length; i++) {
        var pf = tasks[picked[i]].finishPos;
        if (pf > depFinishPos) depFinishPos = pf;
      }

      var resourceFreePos = 0;
      for (i = 0; i < owners.length; i++) {
        var af = availableFrom[owners[i]] || 0;
        if (af > resourceFreePos) resourceFreePos = af;
      }

      // The only change from planMode's loop: today is a third floor (D-031).
      var startPos2 = snap(Math.max(depFinishPos, resourceFreePos, todayPos));
      var startIndex2 = dayIndexAt(startPos2);
      var workDays2 = task.workDays || 0;
      var waitDays2 = task.waitDays || 0;
      var workEndPos2 = snap(startPos2 + workDays2);
      var workEndIndex2 = lastTouchedIndex(workEndPos2, startIndex2);

      var finishPos2, finishIndex2;
      if (waitDays2 > 0) {
        var targetMs2 = axis.dateAt(workEndIndex2) + waitDays2 * DAY_MS;
        finishIndex2 = axis.indexOnOrAfter(targetMs2);
        finishPos2 = finishIndex2;
      } else {
        finishPos2 = workEndPos2;
        finishIndex2 = workEndIndex2;
      }

      for (i = 0; i < owners.length; i++) availableFrom[owners[i]] = workEndPos2;

      tasks[pick] = {
        id: pick,
        milestoneId: index.milestoneOfTask[pick],
        owner: task.owner,
        owners: owners,
        type: task.type,
        workDays: workDays2,
        waitDays: waitDays2,
        status: "open",
        plannedStart: formatISO(axis.dateAt(startIndex2)),
        plannedFinish: formatISO(axis.dateAt(finishIndex2)),
        startPos: startPos2,
        workEndPos: workEndPos2,
        finishPos: finishPos2,
        clamped: false,
        deferred: false
      };

      scheduled[pick] = true;
      order.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }

    var rollup = computeRollup(plan, index, tasks, sprintEndMs);

    return {
      ok: errors.length === 0,
      errors: errors,
      mode: "live",
      today: todayISO,
      sprint: {
        start: plan.sprint.start,
        end: plan.sprint.end || null,
        goLive: plan.sprint.goLive || null,
        firstWorkingDay: formatISO(axis.dateAt(0))
      },
      tasks: tasks,
      milestones: rollup.milestones,
      rocks: rollup.rocks,
      order: order,
      fixedTaskIds: fixedTaskIds,
      deferredTasks: split.deferred,
      stats: {
        scheduled: order.length,
        fixed: fixedTaskIds.length,
        active: activeIds.length,
        deferred: split.deferred.length
      }
    };
  }

  root.OpsDashEngine = {
    planMode: planMode,
    liveMode: liveMode,
    // exposed for tests and for the Gantt view later
    _internals: {
      Axis: Axis,
      parseISO: parseISO,
      formatISO: formatISO,
      isWorkingDayMs: isWorkingDayMs,
      dayIndexAt: dayIndexAt,
      lastTouchedIndex: lastTouchedIndex,
      downstreamCounts: downstreamCounts,
      truncateToDateMs: truncateToDateMs
    }
  };
})(typeof window !== "undefined" ? window : this);
