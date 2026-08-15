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
 * Week selector (§11.1, D-081c): THREE positions — closing (-1) / current
 * (0) / opening (+1) — computed fresh on every mount from today vs.
 * opsWeekStartDay, NEVER persisted (a Wednesday load must not reopen on a
 * week that closed days ago). Person and Origin filters are equally
 * unpersisted (D-081d), defaulting to Everyone / all every time.
 *
 * Two templates, one per "mode" (a reading of §11.1/§11.4/§11.5 flagged as
 * an open question in the build report — the spec names distinct behavior
 * for "closing" and "opening" but never separately describes "current"):
 *   REVIEW  (closing, current) — §11.4: one mixed list per person, actions
 *           on unfinished rows only (D-078d), discard/cancel with a
 *           mandatory reason, an undo on anything already discarded/
 *           cancelled (D-081f), a move-count marker (§11.4).
 *   BUILD   (opening)          — §11.5: proposed Rock tasks with
 *           keep/remove, the availableToPull dropdown (now showing blocked
 *           tasks, D-071b), an add-ad-hoc form, a capacity warning
 *           (D-081b: 5 working days), and the single confirmWeek button
 *           (D-081a: Everyone only).
 *
 * §12's summary renders only on the CLOSING week, per this file's own brief.
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
    weekOffset: 0,            // -1 closing / 0 current / +1 opening — NOT persisted (D-081c)
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
    return getThisWeek().opsWeek(CFG().todayISO(), state.opsWeekStartDay, state.weekOffset);
  }

  /** §11.1 default: closing on the ops week's own start day, current any
   *  other day. Computed by comparing today against the offset-0 window's
   *  own start (which IS today exactly when today is the start day) rather
   *  than re-deriving a day-of-week name — one fewer place that has to agree
   *  with opsWeek's own day-name parsing. */
  function defaultWeekOffset() {
    var todayISO = CFG().todayISO();
    var cur = getThisWeek().opsWeek(todayISO, state.opsWeekStartDay, 0);
    return cur.start === todayISO ? -1 : 0;
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
   * Rock-task bucket membership for a window, INCLUDING the D-063(c) pin
   * override — re-expressed here (not thisweek.js) because it was always
   * this layer's job: the override is presentation policy on top of
   * buckets()'s pure math, exactly as board.js's retired applyPinOverride
   * said of itself.
   */
  function rockBucketsForWindow(win) {
    var b = getThisWeek().buckets(state.liveResult, state.currentState, win, state.plan.people);
    var pins = state.pins;
    var person, list, kept, i, id;

    for (person in b) {
      if (!Object.prototype.hasOwnProperty.call(b, person)) continue;
      list = b[person].notStarted;
      kept = [];
      for (i = 0; i < list.length; i++) {
        id = list[i];
        var pin = pins[id];
        if (pin !== undefined && pin !== win.mondayKey) continue; // pinned elsewhere
        kept.push(id);
      }
      b[person].notStarted = kept;
    }

    var tasks = state.liveResult.tasks;
    for (var taskId in tasks) {
      if (!Object.prototype.hasOwnProperty.call(tasks, taskId)) continue;
      if (pins[taskId] !== win.mondayKey) continue;
      var t = tasks[taskId];
      var cs = state.currentState[taskId];
      var status = cs && cs.status ? cs.status : "open";
      if (status !== "open") continue;
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

  function renderControls() {
    var weekOptions = [
      ["-1", "Closing"], ["0", "Current"], ["1", "Opening"]
    ].map(function (pair) {
      var sel = String(state.weekOffset) === pair[0] ? " selected" : "";
      return '<option value="' + pair[0] + '"' + sel + ">" + pair[1] + "</option>";
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
   *  never blocking. */
  function reviewActionsHtml(item) {
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

  function reviewRowHtml(item) {
    return (
      '<div class="todo-row" data-task-id="' + escapeAttr(item.id) + '" data-origin="' + item.origin + '">' +
        '<div class="todo-row-status">' + statusCtrlHtml(item.id, item.status, item.desc) + "</div>" +
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
        reviewActionsHtml(item) +
        closedBadgeHtml(item) +
        '<div class="todo-reason-panel hidden" data-task-id="' + escapeAttr(item.id) + '" aria-live="polite"></div>' +
      "</div>"
    );
  }

  function reviewSectionHtml(title, items) {
    if (!items.length) {
      return '<div class="todo-section"><h4>' + escapeHtml(title) + '</h4><p class="todo-section-empty">Nothing here.</p></div>';
    }
    var sorted = items.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return '<div class="todo-section"><h4>' + escapeHtml(title) + " (" + items.length + ")</h4>" +
      sorted.map(reviewRowHtml).join("") + "</div>";
  }

  function reviewCardBody(person, win) {
    var items = reviewItemsForPerson(person, win).filter(originPasses);
    var byKind = { done: [], workingOn: [], notStarted: [] };
    items.forEach(function (it) { byKind[it.bucketKind].push(it); });

    return (
      reviewSectionHtml("Done this week", byKind.done) +
      reviewSectionHtml("Working on", byKind.workingOn) +
      reviewSectionHtml("Not started", byKind.notStarted)
    );
  }

  /* ------------------------------------------------------------------ *
   * BUILD mode (opening, §11.5)
   * ------------------------------------------------------------------ */

  function buildProposedForPerson(person, win) {
    var rb = rockBucketsForWindow(win)[person] || { notStarted: [] };
    return rb.notStarted.slice().sort();
  }

  function buildProposedRowHtml(taskId, win) {
    var t = state.index.tasks[taskId];
    var pinned = state.pins[taskId] === win.mondayKey;
    return (
      '<div class="todo-row" data-task-id="' + escapeAttr(taskId) + '" data-origin="rock">' +
        '<div class="todo-row-main">' +
          '<div class="todo-row-top">' +
            '<span class="todo-origin-marker">' + escapeHtml(findRockOfMilestone(state.index.milestoneOfTask[taskId]) || "") +
              " \u00b7 " + escapeHtml(taskId) + "</span>" +
            '<span class="todo-row-desc">' + escapeHtml(t ? t.desc : taskId) + "</span>" +
            (pinned ? '<span class="pin-marker" title="Manually confirmed for this week">\ud83d\udccc</span>' : "") +
          "</div>" +
          '<div class="todo-row-meta"><span class="duration">' +
            escapeHtml(t ? (t.workDays === 1 ? "1 day" : t.workDays + " days") : "") + "</span></div>" +
        "</div>" +
        '<div class="todo-row-actions">' +
          '<button type="button" class="todo-action-btn" data-action="todo-remove-proposed" ' +
            'data-task-id="' + escapeAttr(taskId) + '">Take out of this week</button>' +
        "</div>" +
      "</div>"
    );
  }

  function buildPullDropdownHtml(person, win) {
    var candidates = getThisWeek().availableToPull(state.plan, state.currentState, cancelledIds())
      .filter(function (t) { return ownersOfPlain(t.owner).indexOf(person) !== -1; });

    var options = ['<option value="">+ pull a task into this week\u2026</option>'].concat(
      candidates.map(function (t) {
        var label = t.id + " \u2014 " + t.desc;
        if (t.blocked) {
          label += " (blocked by " + t.blockedBy.map(function (b) {
            return b.id + "/" + b.owner;
          }).join(", ") + ")";
        }
        return '<option value="' + escapeAttr(t.id) + '"' + (t.blocked ? " data-blocked=\"1\"" : "") + ">" +
          escapeHtml(label) + "</option>";
      })
    ).join("");

    return '<select class="todo-pull-select" data-action="todo-pull" data-person="' + escapeAttr(person) +
      '" aria-label="Pull a task into ' + escapeAttr(person) + '\u2019s week">' + options + "</select>";
  }

  function buildAdHocFormHtml(person) {
    var ownerOptions = state.people.map(function (p) {
      return '<option value="' + escapeAttr(p.name) + '"' + (p.name === person ? " selected" : "") + ">" +
        escapeHtml(p.name) + "</option>";
    }).join("");

    return (
      '<div class="todo-adhoc-form" data-person="' + escapeAttr(person) + '">' +
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

  function personWeekWorkDays(person, win) {
    var total = 0;
    buildProposedForPerson(person, win).forEach(function (id) {
      var t = state.index.tasks[id];
      if (t) total += t.workDays || 0;
    });
    for (var aid in state.tasksAdHoc) {
      if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, aid)) continue;
      var at = state.tasksAdHoc[aid];
      if (at.owner === person && state.pins[aid] === win.mondayKey) total += at.workDays || 0;
    }
    return total;
  }

  function capacityWarningHtml(person, win) {
    var total = personWeekWorkDays(person, win);
    if (total <= CAPACITY_WORKDAYS) return "";
    return '<p class="todo-capacity-warning">\u26a0 ' + escapeHtml(person) + " is at " + total +
      " work-days against a " + CAPACITY_WORKDAYS + "-day week. Input to the conversation, not a block (\u00a711.5).</p>";
  }

  function buildCardBody(person, win) {
    var proposed = buildProposedForPerson(person, win);
    return (
      '<div class="todo-section"><h4>Proposed (' + proposed.length + ")</h4>" +
        (proposed.length
          ? proposed.map(function (id) { return buildProposedRowHtml(id, win); }).join("")
          : '<p class="todo-section-empty">Nothing proposed.</p>') +
      "</div>" +
      '<div class="todo-section">' + buildPullDropdownHtml(person, win) + "</div>" +
      '<div class="todo-section"><h4>Add a to-do</h4>' + buildAdHocFormHtml(person) + "</div>" +
      capacityWarningHtml(person, win)
    );
  }

  function confirmWeekButtonHtml(win) {
    // D-081a: shown ONLY with the person filter on Everyone.
    if (state.personFilter !== "") return "";
    var commitment = getEvents().weekCommitment(state.folded, win.mondayKey);
    var already = commitment !== null;
    return (
      '<div class="todo-confirm-week">' +
        '<button type="button" class="btn btn-secondary" data-action="todo-confirm-week" ' +
          'data-monday="' + escapeAttr(win.mondayKey) + '">' +
          (already ? "Re-confirm this week" : "Confirm this week") +
        "</button>" +
        (already ? '<span class="todo-confirm-note">Already confirmed \u2014 re-confirming replaces the frozen list.</span>' : "") +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ *
   * Cards + full render
   * ------------------------------------------------------------------ */

  function cardHtml(person, win, mode) {
    var rateHtml = "";
    if (mode === "review" && win === state._closingWindowForRate && state._weeklyResult) {
      var t = state._weeklyResult.byPerson[person];
      if (t) rateHtml = '<span class="todo-card-rate">' + escapeHtml(rateText(t)) + "</span>";
    }
    return (
      '<div class="todo-card" data-person="' + escapeAttr(person) + '">' +
        '<div class="todo-card-header"><h3>' + escapeHtml(person) + "</h3>" + rateHtml + "</div>" +
        (mode === "review" ? reviewCardBody(person, win) : buildCardBody(person, win)) +
      "</div>"
    );
  }

  function render() {
    if (!state.plan) return; // not mounted yet
    dom.mainEl = dom.mainEl || document.getElementById("main");
    if (!dom.mainEl) return;

    var win = currentWindow();
    var mode = state.weekOffset === 1 ? "build" : "review";
    var people = state.personFilter ? [state.personFilter] : state.people.map(function (p) { return p.name; });

    var summaryHtml = "";
    if (mode === "review" && state.weekOffset === -1) {
      state._closingWindowForRate = win;
      summaryHtml = renderSummary(win);
    } else {
      state._weeklyResult = null;
    }

    var cardsHtml = people.map(function (p) { return cardHtml(p, win, mode); }).join("");
    var confirmHtml = mode === "build" ? confirmWeekButtonHtml(win) : "";

    dom.mainEl.innerHTML =
      '<div class="todo-header">' +
        "<h2>To-dos</h2>" +
        '<span class="todo-window">' + escapeHtml(win.start) + " \u2013 " + escapeHtml(win.end) + "</span>" +
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

  function onRemoveProposed(taskId) {
    var win = currentWindow();
    postAndRefresh("pin", taskId, nextMondayKey(win.mondayKey), "",
      "Took " + taskId + " out of this week.");
  }

  function onUndo(taskId, origin) {
    var action = origin === "adhoc" ? "undiscard" : "uncancel";
    postAndRefresh(action, taskId, "", "", "Undone.");
  }

  function onPull(taskId, person) {
    var win = currentWindow();
    postAndRefresh("pin", taskId, win.mondayKey, "", "Pulled " + taskId + " into " + person + "\u2019s week.");
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

  function onAddAdHoc(person, wrap) {
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

    var win = currentWindow();
    postCreateTask({
      sprintId: (root.OpsDashConfig && root.OpsDashConfig.SPRINT_ID) || "",
      desc: desc, owner: owner, workDays: workDays, week: win.mondayKey,
      deadline: deadline || undefined, actor: actor
    }).then(function (result) {
      if (!result.ok) {
        toast(describeWriteError(result), "error");
        inputs.forEach(function (el) { el.disabled = false; });
        if (addBtn) addBtn.textContent = "Add";
        return;
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
    var ids = {};
    state.people.forEach(function (p) {
      buildProposedForPerson(p.name, win).forEach(function (id) { ids[id] = true; });
      for (var aid in state.tasksAdHoc) {
        if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, aid)) continue;
        if (state.tasksAdHoc[aid].owner === p.name && state.pins[aid] === win.mondayKey) ids[aid] = true;
      }
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
    else if (action === "todo-remove-proposed") onRemoveProposed(taskId);
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
    } else if (action === "todo-pull") {
      var taskId = el.value;
      var person = el.getAttribute("data-person");
      if (!taskId) return;
      onPull(taskId, person);
      el.value = "";
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
    _internals: {
      getState: function () { return state; },
      recompute: recompute
    }
  };
})(typeof window !== "undefined" ? window : this);
