/**
 * Operations Dashboard — To-dos (View §11, Phase 8 part 2B)
 *
 * Supersedes §6.3 / the old "This Week" view that used to live inside
 * board.js. Markup and wiring ONLY (D-077, D-053's house split): every real
 * computation here is a call into thisweek.js (opsWeek/availableToPull/
 * cascadeOf) or metrics.js (weeklyCompletion) — this file does not
 * re-implement any of that math, only assembles what those return into rows,
 * cards and controls, and owns the write path for the six new event actions
 * plus createTask.
 *
 * Independent module, independent state — NOT a continuation of board.js's
 * old This Week code (which is deleted, not ported: its pin-override logic
 * is re-expressed here because it was always view-layer, not thisweek.js's,
 * per its own original comment). board.js still owns the shared topbar
 * (Acting as, the view switch, Refresh) and the Sprint Board; this module
 * owns #main whenever the segmented control's "To-dos" segment is active —
 * board.js's render() calls OpsDashTodos.render() at that point, exactly
 * where it used to call its own renderThisWeekView().
 *
 * Week selector (§11.1, D-092): THREE positions, each showing its label AND
 * its window — Closed (-1) / Current (0) / Next week (+1) — recomputed on
 * every render from today vs. opsWeekStartDay, NEVER persisted (D-081c: a
 * Wednesday load must not reopen on a week that closed days ago). Person and
 * Origin filters are equally unpersisted (D-081d), defaulting to Everyone /
 * all every time.
 *
 * THE MODE COMES FROM THE WEEK, NOT FROM THE SELECTOR (D-092). What you may
 * do in a week is decided by whether that week is confirmed:
 *   BUILD    not yet confirmed — add from Available, capacity counter,
 *            confirm button (§11.5). The week opens EMPTY (D-091).
 *   EXECUTE  confirmed — mark status, move, discard, cancel (§11.4).
 *   REVIEW   the window has ended — read it, with the §12 summary.
 *
 * The retired code derived this from the selector position (BUILD tied to
 * offset +1), which is wrong on the one day that matters: the ops week runs
 * Friday→Thursday and the L10 is Friday, so on Friday offset 0 IS the week
 * being built and offset +1 is a week seven days further out. Anchoring to
 * confirmWeek also makes advance loading safe — a week loaded Thursday night
 * under "Next week" is the same unconfirmed, still-loadable week on Friday
 * morning under "Current", with the identical window printed beside it.
 *
 * §12's summary renders only on a week that has ended.
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Module state
   * ------------------------------------------------------------------ */

  var state = {
    plan: null,
    index: null,             // OpsDashValidate.buildIndex(plan)
    currentState: {},        // D-027 map (Rock + ad-hoc share this)
    deliverables: {},
    pins: {},
    pinEvents: {},
    discards: {},
    cancels: {},
    tasksAdHoc: {},           // parseTasks() output, keyed by id
    people: [],               // People tab [{name, active}]
    opsWeekStartDay: "Friday",
    folded: null,             // OpsDashEvents.fold() result — re-derived after every write
    weekOffset: 0,            // -1 Closed / 0 Current / +1 Next week — NOT persisted (D-081c)
    personFilter: "",         // "" = Everyone — NOT persisted (D-081d)
    originFilter: "all",      // all | rock | other — NOT persisted (D-081d)
    liveResult: null
  };

  var dom = {};
  var STATUS_ORDER = ["open", "in_progress", "done"];
  var STATUS_LABEL = { open: "Open", in_progress: "In progress", done: "Done" };
  var CAPACITY_WORKDAYS = 5; // D-081b — the Friday→Thursday window

  /* ------------------------------------------------------------------ *
   * Small helpers (own copies — this module is deliberately independent
   * of board.js, which owns none of these as exports)
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

  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
  }

  function CFG() {
    var cfg = root.OpsDashConfig;
    if (!cfg) throw new Error("OpsDashTodos requires OpsDashConfig to be loaded first.");
    return cfg;
  }

  function toast(message, kind) {
    if (!dom.toastContainer) dom.toastContainer = document.getElementById("toast-container");
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
    if (result.code && result.message) return result.message;
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

  /** Read fresh, never cached — "Acting as" is board.js's control, shared via
   *  the one localStorage key (§3), never fused with this view's Person filter
   *  (§11.2: the two must stay separate; whoever clicked writes the event). */
  function currentActor() {
    try {
      return localStorage.getItem(CFG().ACTOR_STORAGE_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function requireActor() {
    var actor = currentActor();
    if (!actor) {
      toast("Select who you are (\u201cActing as\u201d) before marking tasks.", "error");
      return null;
    }
    return actor;
  }

  /* ------------------------------------------------------------------ *
   * Derived data
   * ------------------------------------------------------------------ */

  function getEngine() { return root.OpsDashEngine; }
  function getEvents() { return root.OpsDashEvents; }
  function getThisWeek() { return root.OpsDashThisWeek; }
  function getMetrics() { return root.OpsDashMetrics; }
  function getValidate() { return root.OpsDashValidate; }

  function cancelledIds() {
    return Object.keys(state.cancels);
  }

  /** liveMode, cancel-aware (D-068c). A SEPARATE computation from board.js's
   *  own liveResult — flagged as an open question in the build report: while
   *  this view knows about cancellations, the Sprint Board (out of scope for
   *  this pass) does not yet pass a cancelled set to its own liveMode call. */
  function recompute() {
    state.liveResult = getEngine().liveMode(
      state.plan, state.currentState, CFG().todayISO(), cancelledIds()
    );
  }

  function currentWindow() {
    return windowAt(state.weekOffset);
  }

  function windowAt(offset) {
    return getThisWeek().opsWeek(CFG().todayISO(), state.opsWeekStartDay, offset);
  }

  /** §11.1 default: Closed on the ops week's own start day (the L10 is that
   *  day and step 6 comes first), Current any other day. Computed by
   *  comparing today against the offset-0 window's own start (which IS today
   *  exactly when today is the start day) rather than re-deriving a
   *  day-of-week name — one fewer place that has to agree with opsWeek's own
   *  day-name parsing. Never persisted (D-081c). */
  function defaultWeekOffset() {
    var todayISO = CFG().todayISO();
    var cur = getThisWeek().opsWeek(todayISO, state.opsWeekStartDay, 0);
    return cur.start === todayISO ? -1 : 0;
  }

  /* ------------------------------------------------------------------ *
   * Week mode (§11.1, D-092) — THE rule this pass exists to fix.
   *
   * What you can do in a week is decided by whether that week is CONFIRMED,
   * never by the selector position and never by the weekday. The old code
   * tied BUILD to offset +1, and that is wrong on the one day that matters:
   * the ops week runs Friday→Thursday and the L10 is Friday, so on Friday
   * offset 0 IS the week that opens that day — the one step 8 must build —
   * while offset +1 is the week that opens the FOLLOWING Friday. Anchoring
   * to confirmWeek removes the whole class of error: a week loaded Thursday
   * night under "Next week" becomes "Current" the next morning, still
   * unconfirmed, still loadable, same window printed beside the label.
   * ------------------------------------------------------------------ */

  /** True once the window has ended — a property of the WEEK (its own dates
   *  against today), deliberately not of the selector position. */
  function weekHasEnded(win) {
    return win.end < CFG().todayISO();
  }

  function weekIsConfirmed(win) {
    return getEvents().weekCommitment(state.folded, win.mondayKey) !== null;
  }

  /**
   * @returns "review"  — the week has ended: read it, with the §12 summary
   *          "execute" — confirmed: mark status, move, discard, cancel (§11.4)
   *          "build"   — not yet confirmed: add tasks, capacity, confirm (§11.5)
   */
  function weekModeFor(win) {
    if (weekHasEnded(win)) return "review";
    return weekIsConfirmed(win) ? "execute" : "build";
  }

  /**
   * "Aug 15–21" within one month, "Aug 29 – Sep 4" across two (§11.1's own
   * examples). The date is not decoration: it is the anchor that lets someone
   * load a week on Thursday night and recognise the same week on Friday when
   * it has moved from "Next week" to "Current".
   *
   * Formatted through Intl rather than a hand-rolled month table, pinned to
   * UTC because every date in this app is parsed as UTC midnight (engine.js's
   * parseISO) — formatting in the viewer's local zone would shift the label
   * by a day for anyone west of Greenwich.
   */
  function formatWindowRange(win) {
    var parseISO = getEngine()._internals.parseISO;
    var monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
    var dayFmt = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });

    var startMs = parseISO(win.start);
    var endMs = parseISO(win.end);
    var startMonth = monthFmt.format(startMs);
    var endMonth = monthFmt.format(endMs);
    var startDay = dayFmt.format(startMs);
    var endDay = dayFmt.format(endMs);

    return startMonth === endMonth
      ? startMonth + " " + startDay + "–" + endDay
      : startMonth + " " + startDay + " – " + endMonth + " " + endDay;
  }

  function ownersOfPlain(owner) {
    return owner === "Both" ? state.plan.people.slice() : [owner];
  }

  /** Structural ownership for EVERY task, Rock or ad-hoc, regardless of
   *  whether it is currently scheduled — weeklyCompletion needs an owner for
   *  a cancelled Rock task too, and a cancelled task has already left
   *  liveResult.tasks by the time this is read (§12 math, D-078). */
  function buildTaskOwners() {
    var out = {};
    var tasks = state.index.tasks;
    for (var id in tasks) {
      if (!Object.prototype.hasOwnProperty.call(tasks, id)) continue;
      out[id] = ownersOfPlain(tasks[id].owner);
    }
    for (var aid in state.tasksAdHoc) {
      if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, aid)) continue;
      out[aid] = [state.tasksAdHoc[aid].owner];
    }
    return out;
  }

  function nextMondayKey(mondayKey) {
    var eng = getEngine()._internals;
    return eng.formatISO(eng.parseISO(mondayKey) + 7 * 86400000);
  }

  /** §11.4 drag marker: count of `pin` events for a task, MINUS the first
   *  (the task's initial assignment is not itself a "move"). Only `pin`
   *  actions count — an `unpin` releases a pin, it does not relocate the
   *  task anywhere, so it is not a move either. */
  function moveCount(taskId) {
    if (!state.folded || !Array.isArray(state.folded.events)) return 0;
    var n = 0;
    for (var i = 0; i < state.folded.events.length; i++) {
      var ev = state.folded.events[i];
      if (ev.taskId === taskId && ev.action === "pin") n++;
    }
    return n > 0 ? n - 1 : 0;
  }

  /* ------------------------------------------------------------------ *
   * Per-person item assembly — Rock + ad-hoc, ONE list (§11.3)
   * ------------------------------------------------------------------ */

  /**
   * Rock-task bucket membership for a window.
   *
   * D-091 changed what "in this week" MEANS for unstarted work: the week
   * opens EMPTY and nothing is committed until a person puts it there, so
   * `notStarted` is now derived from the PIN alone. It used to start from
   * buckets()'s projection ("the tasks the engine places in this window")
   * and then apply the D-063(c) pin override on top; the projection half is
   * gone, and what it used to contribute is now the informative Available
   * panel instead (§11.5).
   *
   * `done` and `workingOn` keep coming from buckets() untouched, and that
   * asymmetry is deliberate: a task you actually FINISHED inside the window
   * belongs on the week's record whether or not it was ever formally
   * committed — which is exactly §12's rule that mid-week additions count
   * toward the numerator. Only the not-yet-started list is a commitment,
   * and only a commitment needs a person to have put it there.
   */
  function rockBucketsForWindow(win) {
    var b = getThisWeek().buckets(state.liveResult, state.currentState, win, state.plan.people);
    var pins = state.pins;

    for (var person in b) {
      if (!Object.prototype.hasOwnProperty.call(b, person)) continue;
      b[person].notStarted = [];
    }

    var tasks = state.liveResult.tasks;
    for (var taskId in tasks) {
      if (!Object.prototype.hasOwnProperty.call(tasks, taskId)) continue;
      if (pins[taskId] !== win.mondayKey) continue; // committed to THIS week, or not in it
      var t = tasks[taskId];
      var cs = state.currentState[taskId];
      var status = cs && cs.status ? cs.status : "open";
      if (status !== "open") continue; // done/in_progress are handled by buckets() above
      var owners = t.owners || [t.owner];
      for (var j = 0; j < owners.length; j++) {
        var p = owners[j];
        if (b[p] && b[p].notStarted.indexOf(taskId) === -1) b[p].notStarted.push(taskId);
      }
    }

    return b;
  }

  /** Ad-hoc bucket for one task: the SAME three-way split as Rock (done /
   *  workingOn / notStarted), but "notStarted" membership is ENTIRELY the
   *  pin — an ad-hoc task has no engine projection to fall back on (§1 v2:
   *  "Week assignment reuses pin... for ad-hoc tasks it is the ONLY source
   *  of week"). */
  function adHocBucket(taskId, win) {
    var cs = state.currentState[taskId];
    var status = cs && cs.status ? cs.status : "open";

    if (status === "done") {
      if (cs && cs.statusChangedAt) {
        var day = String(cs.statusChangedAt).slice(0, 10);
        if (day >= win.start && day <= win.end) return "done";
      }
      return null;
    }
    if (status === "in_progress") return "workingOn";
    return state.pins[taskId] === win.mondayKey ? "notStarted" : null;
  }

  /**
   * One person's full REVIEW-mode list for a window: Rock + ad-hoc, tagged
   * with origin, bucket, and every flag the row needs to render (discarded/
   * cancelled overlay, move count, deliverable link).
   */
  function reviewItemsForPerson(person, win) {
    var items = [];
    var rockBuckets = rockBucketsForWindow(win);
    var rb = rockBuckets[person] || { done: [], workingOn: [], notStarted: [] };
    var kinds = ["done", "workingOn", "notStarted"];

    kinds.forEach(function (kind) {
      rb[kind].forEach(function (id) {
        items.push(makeReviewItem("rock", id, kind));
      });
    });

    for (var aid in state.tasksAdHoc) {
      if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, aid)) continue;
      var at = state.tasksAdHoc[aid];
      if (at.owner !== person) continue;
      var kind = adHocBucket(aid, win);
      if (!kind) continue;
      items.push(makeReviewItem("adhoc", aid, kind));
    }

    /**
     * D-081(f) needs a fix here: a cancelled Rock task LEAVES liveResult.tasks
     * entirely (D-068c — same code path as a plan-deferred task), so the
     * rockBuckets loop above never sees it and it would otherwise vanish
     * instead of staying visible with its reason and an Undo. Found by
     * exercising the cancel flow in the browser, not assumed — an ad-hoc
     * discard needed no equivalent fix, because discard never touches the
     * engine at all (state.pins/currentState are untouched by discarding),
     * so adHocBucket() above already keeps a discarded ad-hoc task visible.
     *
     * Membership for a task the engine no longer schedules: its pin if it
     * has one (unchanged by cancelling), otherwise the window whose event
     * timestamp actually contains the cancel — the SAME event-timestamp
     * membership rule D-078 already established for §12, applied here to
     * keep a defunct task from reappearing in every week forever.
     */
    var alreadyAdded = {};
    items.forEach(function (it) { alreadyAdded[it.id] = true; });

    for (var cid in state.cancels) {
      if (!Object.prototype.hasOwnProperty.call(state.cancels, cid)) continue;
      if (alreadyAdded[cid]) continue;
      var ct = state.index.tasks[cid];
      if (!ct) continue; // not a Rock task id — cancel is Rock-only by namespace (D-068)
      if (ownersOfPlain(ct.owner).indexOf(person) === -1) continue;

      var pin = state.pins[cid];
      var visibleHere = pin !== undefined
        ? pin === win.mondayKey
        : (function () {
            var day = String(state.cancels[cid].timestamp || "").slice(0, 10);
            return day >= win.start && day <= win.end;
          })();
      if (!visibleHere) continue;

      items.push(makeReviewItem("rock", cid, "notStarted"));
    }

    return items;
  }

  function makeReviewItem(origin, id, bucketKind) {
    var desc, workDays, waitDays, rockId, milestoneId;
    if (origin === "rock") {
      var t = state.index.tasks[id];
      desc = t ? t.desc : id;
      workDays = t ? t.workDays : 0;
      waitDays = t ? t.waitDays : 0;
      milestoneId = state.index.milestoneOfTask[id];
      rockId = findRockOfMilestone(milestoneId);
    } else {
      var at = state.tasksAdHoc[id] || {};
      desc = at.desc || id;
      workDays = at.workDays || 0;
      waitDays = 0;
      rockId = null;
      milestoneId = null;
    }

    var cs = state.currentState[id];
    var status = cs && cs.status ? cs.status : "open";

    return {
      origin: origin, id: id, desc: desc, workDays: workDays, waitDays: waitDays,
      rockId: rockId, milestoneId: milestoneId,
      bucketKind: bucketKind, status: status,
      discarded: Object.prototype.hasOwnProperty.call(state.discards, id) ? state.discards[id] : null,
      cancelled: Object.prototype.hasOwnProperty.call(state.cancels, id) ? state.cancels[id] : null,
      moves: moveCount(id),
      deliverable: state.deliverables[id] || null
    };
  }

  var rockOfMilestoneCache = null;
  function findRockOfMilestone(milestoneId) {
    if (!rockOfMilestoneCache) {
      rockOfMilestoneCache = getMetrics().buildRockIndex(state.plan).milestoneRock;
    }
    return rockOfMilestoneCache[milestoneId] || null;
  }

  function originPasses(item) {
    if (state.originFilter === "rock") return item.origin === "rock";
    if (state.originFilter === "other") return item.origin === "adhoc";
    return true;
  }

  /* ------------------------------------------------------------------ *
   * §12 summary (closing week only, per this view's own brief)
   * ------------------------------------------------------------------ */

  function rateText(tally) {
    if (tally.denominator === null) return "\u2014"; // unconfirmed — D-070/D-078
    if (tally.denominator === 0) return "no commitments"; // confirmed empty, a REAL 0-of-0
    return Math.round(tally.rate * 100) + "% (" + tally.completedCount + "/" + tally.denominator + ")";
  }

  function renderSummary(win) {
    var commitment = getEvents().weekCommitment(state.folded, win.mondayKey);
    var result = getMetrics().weeklyCompletion({
      window: win,
      people: state.plan.people,
      taskOwners: buildTaskOwners(),
      currentState: state.currentState,
      pins: state.pins,
      pinEvents: state.pinEvents, // required — otherwise moves undercount silently (D-078/§12 brief)
      discards: state.discards,
      cancels: state.cancels,
      commitment: commitment
    });

    state._weeklyResult = result; // cached so per-card rates reuse this one computation

    var team = result.team;
    return (
      '<div class="todo-summary">' +
        '<span class="todo-summary-rate">Team: <strong>' + escapeHtml(rateText(team)) + "</strong></span>" +
        '<span class="todo-summary-detail">' +
          team.movedCount + " moved &middot; " +
          team.discardedCount + " discarded &middot; " +
          team.cancelledCount + " cancelled" +
        "</span>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ *
   * Controls (§11.2) — Week / Person / Origin, none persisted (D-081d)
   * ------------------------------------------------------------------ */

  /** Label AND window, together, on every position (§11.1, D-092). "Next
   *  week" is safe as a relative label precisely because it says what it is
   *  relative TO, so it is honest that it becomes "Current" tomorrow;
   *  "Opening" did not say that, which is why D-092 discards that name. */
  var WEEK_POSITIONS = [
    { offset: -1, label: "Closed" },
    { offset: 0, label: "Current" },
    { offset: 1, label: "Next week" }
  ];

  function renderControls() {
    var weekOptions = WEEK_POSITIONS.map(function (pos) {
      var sel = state.weekOffset === pos.offset ? " selected" : "";
      return '<option value="' + pos.offset + '"' + sel + ">" +
        escapeHtml(pos.label + " · " + formatWindowRange(windowAt(pos.offset))) + "</option>";
    }).join("");

    var personOptions = ['<option value=""' + (state.personFilter === "" ? " selected" : "") + ">Everyone</option>"]
      .concat(state.people.map(function (p) {
        var sel = state.personFilter === p.name ? " selected" : "";
        return '<option value="' + escapeAttr(p.name) + '"' + sel + ">" + escapeHtml(p.name) + "</option>";
      })).join("");

    var originOptions = [
      ["all", "All"], ["rock", "Rock only"], ["other", "Other only"]
    ].map(function (pair) {
      var sel = state.originFilter === pair[0] ? " selected" : "";
      return '<option value="' + pair[0] + '"' + sel + ">" + pair[1] + "</option>";
    }).join("");

    return (
      '<div class="todo-controls">' +
        '<label class="todo-control">Week ' +
          '<select data-action="todo-week" aria-label="Week">' + weekOptions + "</select>" +
        "</label>" +
        '<label class="todo-control">Person ' +
          '<select data-action="todo-person" aria-label="Person">' + personOptions + "</select>" +
        "</label>" +
        '<label class="todo-control">Origin ' +
          '<select data-action="todo-origin" aria-label="Origin">' + originOptions + "</select>" +
        "</label>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ *
   * REVIEW mode (closing / current, §11.4)
   * ------------------------------------------------------------------ */

  function statusCtrlHtml(taskId, status, desc) {
    var options = STATUS_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" +
        escapeHtml(STATUS_LABEL[s]) + "</option>";
    }).join("");
    return '<select class="status-ctrl status-' + status +
      '" data-action="todo-set-status" data-task-id="' + escapeAttr(taskId) +
      '" aria-label="Status for ' + escapeAttr(desc || taskId) + '">' +
      options + "</select>";
  }

  function originMarkerHtml(item) {
    if (item.origin !== "rock") return "";
    var label = (item.rockId ? item.rockId + " \u00b7 " : "") + item.id;
    return '<span class="todo-origin-marker">' + escapeHtml(label) + "</span>";
  }

  function durationLabel(item) {
    var s = (item.workDays === 1 ? "1 day" : item.workDays + " days");
    if (item.waitDays > 0) s += " + wait " + (item.waitDays === 1 ? "1 day" : item.waitDays + " days");
    return s;
  }

  function moveMarkerHtml(item) {
    if (item.moves < 2) return "";
    return '<span class="todo-move-marker" title="Moved ' + item.moves +
      ' times">\u21bb \u00d7' + item.moves + "</span>";
  }

  function closedBadgeHtml(item) {
    var closed = item.discarded || item.cancelled;
    if (!closed) return "";
    var label = item.discarded ? "Discarded" : "Cancelled";
    return (
      '<div class="todo-closed-badge">' +
        "<span>" + escapeHtml(label) + ": " + escapeHtml(closed.note) + "</span>" +
        '<button type="button" class="todo-action-btn" data-action="todo-undo" ' +
          'data-task-id="' + escapeAttr(item.id) + '" data-origin="' + item.origin + '">Undo</button>' +
      "</div>"
    );
  }

  /** D-078d: actions ONLY on unfinished rows. Discard/cancel with a
   *  mandatory reason and — for a Rock task — the cascade shown first
   *  (D-068b, same cascadeOf as postpone, D-063d), informative and
   *  never blocking.
   *
   *  BUILD mode does not get mark/move/discard/cancel (D-092: nothing is
   *  committed yet, so there is nothing to close). It gets a DIFFERENT
   *  action instead — Remove, restored by D-095 — but only on a row that
   *  is actually pinned to this window: this excludes a workingOn row that
   *  D-063a shows in every window unconditionally (in-progress status, no
   *  window filter) but that this build week never committed. */
  function reviewActionsHtml(item, mode, win) {
    if (mode === "build") {
      if (state.pins[item.id] !== win.mondayKey) return "";
      return '<div class="todo-row-actions">' +
        '<button type="button" class="todo-action-btn" data-action="todo-unpin-build" ' +
          'data-task-id="' + escapeAttr(item.id) + '">Remove — undo this addition</button>' +
        "</div>";
    }
    if (item.status === "done") return "";
    if (item.discarded || item.cancelled) return ""; // already closed — Undo covers it

    var moveBtn = '<button type="button" class="todo-action-btn" data-action="todo-postpone" ' +
      'data-task-id="' + escapeAttr(item.id) + '">Move to next week</button>';
    var closeBtn = item.origin === "adhoc"
      ? '<button type="button" class="todo-action-btn" data-action="todo-discard-open" ' +
        'data-task-id="' + escapeAttr(item.id) + '">Discard\u2026</button>'
      : '<button type="button" class="todo-action-btn" data-action="todo-cancel-open" ' +
        'data-task-id="' + escapeAttr(item.id) + '">Cancel\u2026</button>';

    return '<div class="todo-row-actions">' + moveBtn + closeBtn + "</div>";
  }

  function reviewRowHtml(item, mode, win) {
    return (
      '<div class="todo-row" data-task-id="' + escapeAttr(item.id) + '" data-origin="' + item.origin + '">' +
        // Status becomes markable only once the week is confirmed (D-092).
        (mode === "build"
          ? ""
          : '<div class="todo-row-status">' + statusCtrlHtml(item.id, item.status, item.desc) + "</div>") +
        '<div class="todo-row-main">' +
          '<div class="todo-row-top">' +
            originMarkerHtml(item) +
            '<span class="todo-row-desc">' + escapeHtml(item.desc) + "</span>" +
            moveMarkerHtml(item) +
          "</div>" +
          '<div class="todo-row-meta">' +
            '<span class="duration">' + escapeHtml(durationLabel(item)) + "</span>" +
            (item.deliverable
              ? '<a class="deliverable-link" href="' + escapeAttr(item.deliverable) +
                '" target="_blank" rel="noopener noreferrer">Deliverable \u2197</a>'
              : "") +
          "</div>" +
        "</div>" +
        reviewActionsHtml(item, mode, win) +
        closedBadgeHtml(item) +
        '<div class="todo-reason-panel hidden" data-task-id="' + escapeAttr(item.id) + '" aria-live="polite"></div>' +
      "</div>"
    );
  }

  function reviewSectionHtml(title, items, mode, win, emptyText) {
    if (!items.length) {
      return '<div class="todo-section"><h4>' + escapeHtml(title) + "</h4>" +
        '<p class="todo-section-empty">' + escapeHtml(emptyText || "Nothing here.") + "</p></div>";
    }
    var sorted = items.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return '<div class="todo-section"><h4>' + escapeHtml(title) + " (" + items.length + ")</h4>" +
      sorted.map(function (it) { return reviewRowHtml(it, mode, win); }).join("") + "</div>";
  }

  function reviewCardBody(person, win, mode) {
    var items = reviewItemsForPerson(person, win).filter(originPasses);
    var byKind = { done: [], workingOn: [], notStarted: [] };
    items.forEach(function (it) { byKind[it.bucketKind].push(it); });

    // D-091: a week being built starts with an empty commitment, and the
    // empty state should say so rather than read as if something is missing.
    var committedEmpty = mode === "build"
      ? "Nothing committed yet \u2014 add from Available, or create a to-do below."
      : "Nothing here.";

    return (
      reviewSectionHtml("Done this week", byKind.done, mode, win) +
      reviewSectionHtml("Working on", byKind.workingOn, mode, win) +
      reviewSectionHtml("Committed", byKind.notStarted, mode, win, committedEmpty)
    );
  }

  /* ------------------------------------------------------------------ *
   * Commitment + the Available panel (§11.5, D-091)
   *
   * The week opens EMPTY. Nothing is committed until a person puts it
   * there — so a person's committed set for a window is exactly what is
   * pinned to that window's Monday key, Rock and ad-hoc alike. The old
   * buildProposedForPerson (projection-derived pre-fill) is gone.
   *
   * D-091(b) originally reasoned that removing the pre-fill also removed
   * the need for a "take it out" action — "if nothing enters on its own,
   * there is nothing to take out." That was wrong and D-095 corrects it: an
   * empty-start week makes adding by hand the ONLY way to build the week,
   * so a mis-click on a shared screen during step 8 became MORE likely, not
   * less. The action is back as reviewActionsHtml's build-mode branch —
   * undoing your own addition, not "rejecting a system proposal" (nothing
   * is proposed any more) — mechanically the same unpin, reached from a
   * different row.
   * ------------------------------------------------------------------ */

  /** Every task id this person has COMMITTED to this window — pin-based,
   *  Rock and ad-hoc together. One definition, used by both the capacity
   *  counter and confirmWeek's frozen list, so those two can never disagree
   *  about what the week actually contains. */
  function committedIdsForPerson(person, win) {
    var out = [];
    var pins = state.pins;

    var tasks = state.liveResult.tasks;
    for (var taskId in tasks) {
      if (!Object.prototype.hasOwnProperty.call(tasks, taskId)) continue;
      if (pins[taskId] !== win.mondayKey) continue;
      var owners = tasks[taskId].owners || [tasks[taskId].owner];
      if (owners.indexOf(person) !== -1) out.push(taskId);
    }

    for (var aid in state.tasksAdHoc) {
      if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, aid)) continue;
      if (state.tasksAdHoc[aid].owner !== person) continue;
      if (pins[aid] !== win.mondayKey) continue;
      out.push(aid);
    }

    return out.sort();
  }

  /**
   * The Available panel (§11.5, D-091a): informative, never auto-committed.
   * Everything this person could pull in — including the tasks the live
   * projection places in this very window, which is exactly what used to be
   * pre-filled — and it SHOWS blocked tasks, flagged, naming the blocker and
   * its owner. D-071(b) is preserved whole: hiding blocked tasks hides the
   * coordination that naming them is there to produce.
   *
   * Already-committed tasks drop out (they are in the list beside this one),
   * and the projection's own picks sort first, since those are the ones the
   * engine expects this week.
   */
  function availablePanelHtml(person, win) {
    var committed = committedIdsForPerson(person, win);
    var candidates = getThisWeek().availableToPull(state.plan, state.currentState, cancelledIds())
      .filter(function (t) {
        return ownersOfPlain(t.owner).indexOf(person) !== -1 && committed.indexOf(t.id) === -1;
      });

    // "projected here" = the live projection overlaps this window, the same
    // overlap test thisweek.js's buckets() uses for its notStarted bucket.
    var live = state.liveResult.tasks;
    candidates.forEach(function (t) {
      var lt = live[t.id];
      t._projectedHere = !!(lt && lt.plannedStart && lt.plannedFinish &&
        lt.plannedStart <= win.end && lt.plannedFinish >= win.start);
    });
    candidates.sort(function (a, b) {
      if (a._projectedHere !== b._projectedHere) return a._projectedHere ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    if (!candidates.length) {
      return '<div class="todo-available"><h4>Available</h4>' +
        '<p class="todo-section-empty">Nothing left to pull in.</p></div>';
    }

    var rows = candidates.map(function (t) {
      var blockedHtml = t.blocked
        ? '<div class="todo-blocked-note">Blocked by ' +
            t.blockedBy.map(function (b) {
              return escapeHtml(b.id) + " (" + escapeHtml(b.owner || "unassigned") + ")";
            }).join(", ") + "</div>"
        : "";
      var rockLabel = (findRockOfMilestone(state.index.milestoneOfTask[t.id]) || "") + " · " + t.id;
      return (
        '<div class="todo-available-row" data-task-id="' + escapeAttr(t.id) + '">' +
          '<div class="todo-row-main">' +
            '<div class="todo-row-top">' +
              '<span class="todo-origin-marker">' + escapeHtml(rockLabel) + "</span>" +
              '<span class="todo-row-desc">' + escapeHtml(t.desc) + "</span>" +
              (t._projectedHere
                ? '<span class="todo-projected-marker" title="The live projection places this task in this window.">projected here</span>'
                : "") +
            "</div>" +
            blockedHtml +
          "</div>" +
          '<button type="button" class="todo-action-btn" data-action="todo-pull" ' +
            'data-task-id="' + escapeAttr(t.id) + '" data-person="' + escapeAttr(person) + '">' +
            "Add to week</button>" +
        "</div>"
      );
    }).join("");

    return '<div class="todo-available"><h4>Available (' + candidates.length + ")</h4>" + rows + "</div>";
  }

  function buildAdHocFormHtml(person, opts) {
    var ownerOptions = state.people.map(function (p) {
      return '<option value="' + escapeAttr(p.name) + '"' + (p.name === person ? " selected" : "") + ">" +
        escapeHtml(p.name) + "</option>";
    }).join("");

    // \u00a713.3 reuses this exact form from the Issues view, with the issue id
    // pre-filled and LOCKED \u2014 hence the optional sourceIssueId. It rides as a
    // data attribute rather than a disabled input because a disabled field is
    // still a field someone can try to argue with; there is nothing here to
    // edit, only a fact about where this to-do came from. The Issues view
    // renders the human-readable version of that fact beside the form.
    var sourceIssueId = opts && opts.sourceIssueId ? opts.sourceIssueId : "";
    var weekAttr = opts && opts.week
      ? ' data-week="' + escapeAttr(opts.week) + '"'
      : "";

    return (
      '<div class="todo-adhoc-form" data-person="' + escapeAttr(person) + '"' +
        (sourceIssueId ? ' data-source-issue-id="' + escapeAttr(sourceIssueId) + '"' : "") +
        weekAttr + ">" +
        '<input type="text" class="todo-adhoc-desc" placeholder="New to-do\u2026" ' +
          'aria-label="Description" autocomplete="off" />' +
        '<select class="todo-adhoc-owner" aria-label="Owner">' + ownerOptions + "</select>" +
        '<input type="number" class="todo-adhoc-workdays" placeholder="Days" step="0.5" min="0.5" ' +
          'autocomplete="off" ' +
          'aria-label="Estimated work days" style="width:5em" />' +
        '<input type="date" class="todo-adhoc-deadline" aria-label="Deadline (optional)" autocomplete="off" />' +
        '<button type="button" class="todo-action-btn" data-action="todo-add-adhoc" ' +
          'data-person="' + escapeAttr(person) + '">Add</button>' +
      "</div>"
    );
  }

  /** D-081b, and MORE load-bearing since D-091: with nothing pre-filled, this
   *  counter is the only thing telling a person they are overcommitting (or
   *  undercommitting) as they add by hand. Counts the same pin-based
   *  commitment the confirm button freezes, so the number on screen and the
   *  number that gets frozen are the same number. */
  function personWeekWorkDays(person, win) {
    var total = 0;
    committedIdsForPerson(person, win).forEach(function (id) {
      var rockTask = state.index.tasks[id];
      if (rockTask) { total += rockTask.workDays || 0; return; }
      var adHoc = state.tasksAdHoc[id];
      if (adHoc) total += adHoc.workDays || 0;
    });
    return total;
  }

  function capacityWarningHtml(person, win) {
    var total = personWeekWorkDays(person, win);
    if (total <= CAPACITY_WORKDAYS) return "";
    return '<p class="todo-capacity-warning">\u26a0 ' + escapeHtml(person) + " is at " + total +
      " work-days against a " + CAPACITY_WORKDAYS + "-day week. Input to the conversation, not a block (\u00a711.5).</p>";
  }

  /** The capacity line always renders while a week is live (build/execute) —
   *  it reads "N of 5 work-days" even when under, because D-091(d) makes it
   *  the only signal of under- OR over-commitment now that nothing is
   *  pre-filled. Over the limit it turns into the warning. */
  function capacityLineHtml(person, win) {
    var total = personWeekWorkDays(person, win);
    if (total > CAPACITY_WORKDAYS) return capacityWarningHtml(person, win);
    return '<p class="todo-capacity-line">' + total + " of " + CAPACITY_WORKDAYS +
      " work-days committed.</p>";
  }

  /**
   * Only ever rendered in BUILD mode, so the week being confirmed is by
   * definition not yet confirmed — hence no "re-confirm" branch any more.
   * That is a consequence of D-092's own mode list (confirm belongs to
   * build; execution is mark/move/discard/cancel) reinforced by §11.5's
   * denominator guarantee: re-confirming mid-week would fold work added
   * after the fact into the frozen denominator, which is exactly what
   * "anything added mid-week never inflates the denominator" forbids.
   */
  function confirmWeekButtonHtml(win) {
    // D-081a: shown ONLY with the person filter on Everyone.
    if (state.personFilter !== "") return "";
    return (
      '<div class="todo-confirm-week">' +
        '<button type="button" class="btn btn-secondary" data-action="todo-confirm-week" ' +
          'data-monday="' + escapeAttr(win.mondayKey) + '">Confirm this week</button>' +
        '<span class="todo-confirm-note">Freezes what is committed now as this week\u2019s denominator (\u00a712).</span>' +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ *
   * Cards + full render
   * ------------------------------------------------------------------ */

  /**
   * One card body for all three modes, because the CONTENT of a week never
   * changes with the mode \u2014 only what you may do with it (\u00a711.1: "the same
   * week never changes meaning, only which box it sits in"). The committed
   * list is always the pin-based commitment; what varies is whether the
   * Available panel and the capacity line are shown (live weeks only) and
   * whether rows carry actions (D-092: build is add/count/confirm, execution
   * is mark/move/discard/cancel).
   */
  function cardHtml(person, win, mode) {
    var rateHtml = "";
    if (mode === "review" && win === state._closingWindowForRate && state._weeklyResult) {
      var t = state._weeklyResult.byPerson[person];
      if (t) rateHtml = '<span class="todo-card-rate">' + escapeHtml(rateText(t)) + "</span>";
    }

    var isLive = mode !== "review";
    var body =
      '<div class="todo-card-cols">' +
        '<div class="todo-card-committed">' +
          reviewCardBody(person, win, mode) +
          (isLive ? capacityLineHtml(person, win) : "") +
        "</div>" +
        (isLive ? '<div class="todo-card-available">' + availablePanelHtml(person, win) + "</div>" : "") +
      "</div>" +
      // D-094: ad-hoc creation is un-gated from build mode specifically \u2014
      // unplanned work arrives on a Tuesday, with the week already confirmed
      // and running \u2014 but a CLOSED week is read-only: creating there would
      // pin a brand-new task into a window that has already ended.
      (isLive ? '<div class="todo-section"><h4>Add a to-do</h4>' + buildAdHocFormHtml(person) + "</div>" : "");

    return (
      '<div class="todo-card" data-person="' + escapeAttr(person) + '">' +
        '<div class="todo-card-header"><h3>' + escapeHtml(person) + "</h3>" + rateHtml + "</div>" +
        body +
      "</div>"
    );
  }

  function render() {
    if (!state.plan) return; // not mounted yet
    dom.mainEl = dom.mainEl || document.getElementById("main");
    if (!dom.mainEl) return;

    var win = currentWindow();
    // D-092: the mode comes from the WEEK (ended? confirmed?), never from the
    // selector position and never from the weekday.
    var mode = weekModeFor(win);
    var people = state.personFilter ? [state.personFilter] : state.people.map(function (p) { return p.name; });

    var summaryHtml = "";
    if (mode === "review") {
      state._closingWindowForRate = win;
      summaryHtml = renderSummary(win);
    } else {
      state._weeklyResult = null;
    }

    var cardsHtml = people.map(function (p) { return cardHtml(p, win, mode); }).join("");
    var confirmHtml = mode === "build" ? confirmWeekButtonHtml(win) : "";

    // The heading states the selected week's label, its window and what the
    // week's confirmation state permits \u2014 so the mode is never something the
    // person has to infer from which controls happen to be on screen.
    var positionLabel = (WEEK_POSITIONS.filter(function (pos) {
      return pos.offset === state.weekOffset;
    })[0] || { label: "" }).label;
    var MODE_NOTE = {
      build: "Not confirmed yet \u2014 being built",
      execute: "Confirmed \u2014 in progress",
      review: "Closed"
    };

    dom.mainEl.innerHTML =
      '<div class="todo-header">' +
        "<h2>To-dos</h2>" +
        '<span class="todo-window">' + escapeHtml(positionLabel + " \u00b7 " + formatWindowRange(win)) + "</span>" +
        // aria-live: changing the Week select swaps the mode and the whole
        // card region underneath with no focus move, so a screen-reader user
        // otherwise gets no signal that what they can do just changed.
        '<span class="todo-mode-note" role="status" aria-live="polite">' +
          escapeHtml(MODE_NOTE[mode]) + "</span>" +
      "</div>" +
      renderControls() +
      summaryHtml +
      '<div class="todo-cards">' + cardsHtml + "</div>" +
      confirmHtml;
  }

  /* ------------------------------------------------------------------ *
   * Refresh after any write — full refetch + refold (simpler and safer
   * than replicating per-field optimistic patches across six new action
   * types; writes here are infrequent L10-meeting clicks, not a hot path).
   * ------------------------------------------------------------------ */

  function refreshFromServer() {
    return getEvents().fetchEvents().then(function (events) {
      var folded = getEvents().fold(events);
      state.folded = folded;
      state.currentState = getEvents().toCurrentState(folded);
      state.deliverables = getEvents().deliverables(folded);
      state.pins = getEvents().pins(folded);
      state.pinEvents = getEvents().pinEvents(folded);
      state.discards = getEvents().discards(folded);
      state.cancels = getEvents().cancels(folded);
      recompute();
      render();
    });
  }

  /* ------------------------------------------------------------------ *
   * Writes
   * ------------------------------------------------------------------ */

  function postAndRefresh(action, taskId, value, note, successMsg) {
    var actor = requireActor();
    if (!actor) return;
    getEvents().postEvent(action, taskId, value, actor, note || "")
      .then(function (result) {
        if (!result.ok) { toast(describeWriteError(result), "error"); return; }
        return refreshFromServer().then(function () {
          if (successMsg) toast(successMsg, "success");
        });
      })
      .catch(function (err) { toast("Could not save: " + err.message, "error"); });
  }

  /**
   * createTask (D-066) is a sibling RPC, not an Events-log action, so it does
   * not go through OpsDashEvents.postEvent — a direct POST, following the
   * same §3 write-path rules (text/plain "simple request", no-cors ONLY on a
   * TypeError). The backend performs its own write-then-verify (D-066e) and
   * returns `verified` in the response, so this does not additionally re-read
   * the Tasks tab to confirm — a deliberate simplification flagged in the
   * build report, unlike postEvent's full client-side verify loop.
   */
  function postCreateTask(payload) {
    var cfg = CFG();
    var body = JSON.stringify(Object.assign({ action: "createTask" }, payload));
    var opts = { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body };
    return fetch(cfg.WEB_APP_URL, opts)
      .then(function (res) { return res.text(); })
      .then(function (text) {
        try { return JSON.parse(text); } catch (e) {
          return { ok: false, code: "BAD_RESPONSE", message: "Server response was not JSON." };
        }
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          return fetch(cfg.WEB_APP_URL, { method: "POST", headers: opts.headers, body: body, mode: "no-cors" })
            .then(function () {
              return { ok: false, code: "UNVERIFIED", message: "Sent, but the network blocked reading the response — check the Tasks tab." };
            })
            .catch(function () {
              return { ok: false, code: "POST_FAILED", message: "Could not reach the server." };
            });
        }
        return { ok: false, code: "POST_FAILED", message: String((err && err.message) || err) };
      });
  }

  function onSetStatus(taskId, next, selectEl) {
    var actor = requireActor();
    if (!actor) { selectEl.value = selectEl.getAttribute("data-prev") || "open"; return; }

    selectEl.disabled = true;
    getEvents().postEvent("setStatus", taskId, next, actor, "")
      .then(function (result) {
        if (!result.ok) {
          toast("Could not update status: " + describeWriteError(result), "error");
          selectEl.disabled = false;
          return;
        }
        return refreshFromServer();
      })
      .catch(function (err) {
        toast("Could not update status: " + err.message, "error");
        selectEl.disabled = false;
      });
  }

  function onPostpone(taskId) {
    var win = currentWindow();
    postAndRefresh("pin", taskId, nextMondayKey(win.mondayKey), "", "Moved " + taskId + " to next week.");
  }

  function onUndo(taskId, origin) {
    var action = origin === "adhoc" ? "undiscard" : "uncancel";
    postAndRefresh(action, taskId, "", "", "Undone.");
  }

  function onPull(taskId, person) {
    var win = currentWindow();
    postAndRefresh("pin", taskId, win.mondayKey, "", "Pulled " + taskId + " into " + person + "\u2019s week.");
  }

  /** D-095: undo your own addition, build mode only. No reason \u2014 unlike
   *  discard/cancel (\u00a711.4), this corrects something that never became a
   *  commitment, so there is nothing to explain. Plain unpin, no value. */
  function onUnpinBuild(taskId) {
    postAndRefresh("unpin", taskId, "", "", "Removed " + taskId + " from this week.");
  }

  /** Opens the inline reason panel for discard/cancel — the cascade (for a
   *  Rock cancel, D-068b) is shown here, informative and never blocking. */
  function openReasonPanel(taskId, kind) {
    var row = dom.mainEl.querySelector('.todo-row[data-task-id="' + cssEscape(taskId) + '"]');
    if (!row) return;
    var panel = row.querySelector(".todo-reason-panel");
    if (!panel) return;

    var maxLen = CFG().MAX_NOTE_LEN;
    var cascadeHtml = "";
    if (kind === "cancel") {
      var cascade = getThisWeek().cascadeOf(state.plan, taskId);
      cascadeHtml = cascade.length
        ? '<p class="todo-cascade">Also cancels the schedule for: ' +
          cascade.map(function (c) { return escapeHtml(c.id + " (" + c.owner + ")"); }).join(", ") +
          ". Informational \u2014 cancelling is not blocked (\u00a711.4, D-068b).</p>"
        : '<p class="todo-cascade">Nothing else depends on this task.</p>';
    }

    panel.innerHTML =
      cascadeHtml +
      '<textarea class="todo-reason-input" rows="2" placeholder="Reason (required)\u2026" ' +
        'aria-label="Reason"></textarea>' +
      '<div class="todo-reason-row">' +
        '<span class="todo-reason-count">0 / ' + maxLen + '</span>' +
        '<button type="button" class="todo-action-btn" data-action="todo-confirm-close" ' +
          'data-task-id="' + escapeAttr(taskId) + '" data-kind="' + kind + '" disabled>Confirm ' +
          (kind === "discard" ? "discard" : "cancel") + "</button>" +
        '<button type="button" class="todo-action-btn" data-action="todo-cancel-close-panel" ' +
          'data-task-id="' + escapeAttr(taskId) + '">Cancel</button>' +
      "</div>";
    panel.classList.remove("hidden");

    var textarea = panel.querySelector(".todo-reason-input");
    var counter = panel.querySelector(".todo-reason-count");
    var confirmBtn = panel.querySelector('[data-action="todo-confirm-close"]');

    // No maxlength attribute (D-075): a silently clipped paste is the exact
    // truncation the server's no-truncate rule forbids, just moved into the
    // browser. A live counter plus a disabled confirm button says so instead.
    textarea.addEventListener("input", function () {
      var len = textarea.value.length;
      counter.textContent = len + " / " + maxLen;
      counter.classList.toggle("todo-reason-over", len > maxLen);
      var trimmedEmpty = textarea.value.trim() === "";
      confirmBtn.disabled = trimmedEmpty || len > maxLen;
      confirmBtn.textContent = len > maxLen
        ? "Over by " + (len - maxLen) + " characters"
        : (kind === "discard" ? "Confirm discard" : "Confirm cancel");
    });
    textarea.focus();
  }

  function closeReasonPanel(taskId) {
    var row = dom.mainEl.querySelector('.todo-row[data-task-id="' + cssEscape(taskId) + '"]');
    if (!row) return;
    var panel = row.querySelector(".todo-reason-panel");
    if (panel) { panel.classList.add("hidden"); panel.innerHTML = ""; }
  }

  function onConfirmClose(taskId, kind) {
    var row = dom.mainEl.querySelector('.todo-row[data-task-id="' + cssEscape(taskId) + '"]');
    if (!row) return;
    var textarea = row.querySelector(".todo-reason-input");
    var note = textarea ? textarea.value.trim() : "";
    if (!note) return;
    if (note.length > CFG().MAX_NOTE_LEN) return; // confirm button was disabled; belt-and-braces

    var confirmBtn = row.querySelector('[data-action="todo-confirm-close"]');
    var cancelBtn = row.querySelector('[data-action="todo-cancel-close-panel"]');
    // Disabled for the round-trip: a double-click or a slow network must not
    // fire the same discard/cancel twice, and re-render() (on success) or the
    // re-enable below (on failure) is what lifts it either way.
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Saving…"; }
    if (cancelBtn) cancelBtn.disabled = true;
    if (textarea) textarea.disabled = true;

    var action = kind === "discard" ? "discard" : "cancel";
    var actor = requireActor();
    if (!actor) {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = kind === "discard" ? "Confirm discard" : "Confirm cancel"; }
      if (cancelBtn) cancelBtn.disabled = false;
      if (textarea) textarea.disabled = false;
      return;
    }

    getEvents().postEvent(action, taskId, "", actor, note)
      .then(function (result) {
        if (!result.ok) {
          toast(describeWriteError(result), "error");
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = kind === "discard" ? "Confirm discard" : "Confirm cancel"; }
          if (cancelBtn) cancelBtn.disabled = false;
          if (textarea) textarea.disabled = false;
          return;
        }
        return refreshFromServer().then(function () {
          toast((kind === "discard" ? "Discarded " : "Cancelled ") + taskId + ".", "success");
        });
      })
      .catch(function (err) {
        toast("Could not save: " + err.message, "error");
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = kind === "discard" ? "Confirm discard" : "Confirm cancel"; }
        if (cancelBtn) cancelBtn.disabled = false;
        if (textarea) textarea.disabled = false;
      });
  }

  function onAddAdHoc(person, wrap, opts) {
    var actor = requireActor();
    if (!actor) return;

    var descEl = wrap.querySelector(".todo-adhoc-desc");
    var workDaysEl = wrap.querySelector(".todo-adhoc-workdays");
    var deadline = wrap.querySelector(".todo-adhoc-deadline").value;
    var owner = wrap.querySelector(".todo-adhoc-owner").value;
    var desc = descEl.value.trim();
    var workDaysRaw = workDaysEl.value;

    if (!desc) { toast("Description is required.", "error"); descEl.focus(); return; }
    var workDays = Number(workDaysRaw);
    if (!(workDays > 0)) {
      toast("workDays must be a number greater than 0.", "error");
      workDaysEl.focus();
      return;
    }

    var addBtn = wrap.querySelector('[data-action="todo-add-adhoc"]');
    var inputs = wrap.querySelectorAll("input, select, button");
    // Same round-trip guard as the discard/cancel confirm: a slow request
    // must not let a second click create a duplicate ad-hoc task.
    inputs.forEach(function (el) { el.disabled = true; });
    if (addBtn) addBtn.textContent = "Adding…";

    // Both read off the form element, so the SAME handler serves the §11.5
    // form (no attributes — the selected week, no issue) and §13.3's reuse of
    // it from the Issues view (an explicit week, a locked issue id). One
    // write path, one set of validations, one in-flight guard.
    var formWeek = wrap.getAttribute("data-week");
    var sourceIssueId = wrap.getAttribute("data-source-issue-id") || undefined;
    var week = formWeek || currentWindow().mondayKey;

    postCreateTask({
      sprintId: (root.OpsDashConfig && root.OpsDashConfig.SPRINT_ID) || "",
      desc: desc, owner: owner, workDays: workDays, week: week,
      deadline: deadline || undefined, sourceIssueId: sourceIssueId, actor: actor
    }).then(function (result) {
      if (!result.ok) {
        toast(describeWriteError(result), "error");
        inputs.forEach(function (el) { el.disabled = false; });
        if (addBtn) addBtn.textContent = "Add";
        return;
      }
      // The Issues view owns its own refresh (it has to re-read the Tasks tab
      // to recount §13.4), so it passes a callback instead of letting this
      // module's refreshFromServer run against a view that is not on screen.
      if (opts && typeof opts.onCreated === "function") {
        return opts.onCreated(result);
      }
      return refreshFromServer().then(function () {
        toast("Added " + result.id + ".", "success");
      });
    }).catch(function (err) {
      toast("Could not add the to-do: " + err.message, "error");
      inputs.forEach(function (el) { el.disabled = false; });
      if (addBtn) addBtn.textContent = "Add";
    });
  }

  function onConfirmWeek(mondayKey) {
    var actor = requireActor();
    if (!actor) return;

    var win = currentWindow();
    // The frozen denominator is exactly what people COMMITTED to this week
    // (D-091: nothing arrives on its own), read through the same
    // committedIdsForPerson the capacity counter uses, so the number shown
    // on screen and the number frozen here can never disagree.
    var ids = {};
    state.people.forEach(function (p) {
      committedIdsForPerson(p.name, win).forEach(function (id) { ids[id] = true; });
    });
    var frozen = Object.keys(ids).sort();
    var note = JSON.stringify(frozen);

    if (note.length > CFG().MAX_NOTE_LEN) {
      toast("The frozen list is too long to save (" + note.length + " / " + CFG().MAX_NOTE_LEN +
        " characters). This needs a design decision, not a silent truncation.", "error");
      return;
    }

    var btn = dom.mainEl.querySelector('[data-action="todo-confirm-week"]');
    var originalLabel = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Confirming…"; }

    getEvents().postEvent("confirmWeek", "WEEK-" + mondayKey, mondayKey, actor, note)
      .then(function (result) {
        if (!result.ok) {
          toast(describeWriteError(result), "error");
          if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
          return;
        }
        return refreshFromServer().then(function () {
          toast("Confirmed the week (" + frozen.length + " task" + (frozen.length === 1 ? "" : "s") + ").", "success");
        });
      })
      .catch(function (err) {
        toast("Could not save: " + err.message, "error");
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      });
  }

  /* ------------------------------------------------------------------ *
   * Event delegation — this module's own #main listeners, installed once
   * ------------------------------------------------------------------ */

  function onClick(e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var taskId = el.getAttribute("data-task-id");

    if (action === "todo-postpone") onPostpone(taskId);
    else if (action === "todo-pull") onPull(taskId, el.getAttribute("data-person"));
    else if (action === "todo-unpin-build") onUnpinBuild(taskId);
    else if (action === "todo-undo") onUndo(taskId, el.getAttribute("data-origin"));
    else if (action === "todo-discard-open") openReasonPanel(taskId, "discard");
    else if (action === "todo-cancel-open") openReasonPanel(taskId, "cancel");
    else if (action === "todo-cancel-close-panel") closeReasonPanel(taskId);
    else if (action === "todo-confirm-close") onConfirmClose(taskId, el.getAttribute("data-kind"));
    else if (action === "todo-add-adhoc") {
      var wrap = el.closest(".todo-adhoc-form");
      if (wrap) onAddAdHoc(el.getAttribute("data-person"), wrap);
    } else if (action === "todo-confirm-week") {
      onConfirmWeek(el.getAttribute("data-monday"));
    }
  }

  function onChange(e) {
    var el = e.target;
    var action = el.getAttribute("data-action");

    if (action === "todo-set-status") {
      onSetStatus(el.getAttribute("data-task-id"), el.value, el);
    } else if (action === "todo-week") {
      state.weekOffset = Number(el.value);
      render();
    } else if (action === "todo-person") {
      state.personFilter = el.value;
      render();
    } else if (action === "todo-origin") {
      state.originFilter = el.value;
      render();
    }
  }

  /* ------------------------------------------------------------------ *
   * mount — called once by app.js after bootstrap; render() is called
   * separately by board.js whenever the "To-dos" segment becomes active.
   * ------------------------------------------------------------------ */

  /**
   * @param initial {
   *   plan, currentState, deliverables, pins, pinEvents, discards, cancels,
   *   tasks, people, opsWeekStartDay, folded
   * }
   */
  function mount(initial) {
    state.plan = initial.plan;
    state.index = getValidate().buildIndex(initial.plan);
    state.currentState = initial.currentState || {};
    state.deliverables = initial.deliverables || {};
    state.pins = initial.pins || {};
    state.pinEvents = initial.pinEvents || {};
    state.discards = initial.discards || {};
    state.cancels = initial.cancels || {};
    state.tasksAdHoc = initial.tasks || {};
    state.people = initial.people || [];
    state.opsWeekStartDay = initial.opsWeekStartDay || "Friday";
    state.folded = initial.folded || { byTask: {}, events: [], warnings: [] };

    state.weekOffset = defaultWeekOffset(); // §11.1 — never persisted (D-081c)
    state.personFilter = "";
    state.originFilter = "all";

    dom.mainEl = document.getElementById("main");
    dom.toastContainer = document.getElementById("toast-container");
    if (dom.mainEl) {
      dom.mainEl.addEventListener("click", onClick);
      dom.mainEl.addEventListener("change", onChange);
    }

    recompute();
  }

  root.OpsDashTodos = {
    mount: mount,
    render: render,

    /**
     * The §11.5 ad-hoc form, exported so §13.3 can open "the ad-hoc form of
     * §11.5 with sourceIssueId pre-filled and locked" — its words — instead
     * of a second form that would drift from this one. The Issues view
     * renders adHocFormHtml() into its own markup and calls submitAdHoc()
     * from its own click handler; validation, the in-flight disable and the
     * createTask call all stay here.
     *
     * @param opts.sourceIssueId  locked onto the created task (§13.3)
     * @param opts.week           the ISO Monday to create into. REQUIRED from
     *        the Issues view, which has no week selector of its own — see
     *        the note in issues.js on which week it picks and why.
     * @param opts.onCreated      called instead of this module's refresh
     */
    adHocFormHtml: buildAdHocFormHtml,
    submitAdHoc: onAddAdHoc,
    _internals: {
      getState: function () { return state; },
      recompute: recompute,
      cardHtml: cardHtml,
      // Exposed for tests (D-022 plain-Node harness): these are the pure
      // decisions D-092 turns on — which mode a week is in, and how a
      // position is labelled — so they can be verified without a DOM.
      weekModeFor: weekModeFor,
      weekHasEnded: weekHasEnded,
      weekIsConfirmed: weekIsConfirmed,
      formatWindowRange: formatWindowRange,
      defaultWeekOffset: defaultWeekOffset,
      windowAt: windowAt,
      committedIdsForPerson: committedIdsForPerson,
      WEEK_POSITIONS: WEEK_POSITIONS
    }
  };
})(typeof window !== "undefined" ? window : this);
