/**
 * Operations Dashboard — Issues (View §13, Phase 9)
 *
 * The L10's IDS step produces two things: issues that get talked through and
 * closed, and issues that generate work. Today both disappear into the
 * meeting. This view is where they live.
 *
 * Its OWN screen, the third segment beside Sprint board and To-dos, not a
 * panel inside the week (D-096a). Two reasons, both from §13: issues are
 * raised DURING the week and not only in the meeting, so the view has to
 * stand on its own; and IDS is a different L10 step from the to-dos one.
 *
 * Independent module for the same reason todos.js is one (D-077): board.js
 * owns the shared topbar and the Sprint Board, todos.js owns §11, and this
 * owns #main whenever the "Issues" segment is active — board.js's render()
 * calls OpsDashIssues.render() at that point.
 *
 * WHAT THIS FILE DOES NOT DO (§13.5), so nobody adds it back by reflex:
 *   - no ranking or priority beyond age. The list is oldest-first and shows
 *     the age; a three-week-old issue reaches the top on its own. A manual
 *     priority field was considered and rejected as a knob nobody maintains
 *     (D-096c).
 *   - no owner on an issue. Issues are the team's; the to-do that comes out
 *     of one has an owner.
 *   - no scheduling. An issue never enters the engine — only the to-dos it
 *     produces do, as ordinary ad-hoc tasks (§11).
 *
 * State lives in the event log, never in the Issues row (§13.1): the row
 * carries id/sprintId/title/desc/raisedBy/raisedAt, and open-vs-resolved plus
 * the resolution come from folding resolveIssue/unresolveIssue. Same rule
 * that keeps a task's status out of the Tasks row.
 */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Module state
   * ------------------------------------------------------------------ */

  var state = {
    issues: {},           // parseIssues() output, keyed by id
    tasksAdHoc: {},       // parseTasks() output — the §13.4 join lives here
    currentState: {},     // D-027 map, for the generated to-dos' status
    resolutions: {},      // OpsDashEvents.issueResolutions(folded)
    people: [],
    folded: null,
    opsWeekStartDay: "Friday",
    expanded: {},         // issueId -> true; view-only, never persisted
    creatingFor: null,    // issueId whose "create a to-do" form is open
    resolveChoice: {}     // issueId -> the resolution picked but not yet sent
  };

  var dom = {};

  /* ------------------------------------------------------------------ *
   * Small helpers — own copies, this module is independent of board.js
   * and todos.js (neither exports them)
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
    if (!cfg) throw new Error("OpsDashIssues requires OpsDashConfig to be loaded first.");
    return cfg;
  }

  function getEvents() { return root.OpsDashEvents; }
  function getEngine() { return root.OpsDashEngine; }
  function getThisWeek() { return root.OpsDashThisWeek; }

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
   *  the one localStorage key (§3). Whoever clicked is who gets recorded. */
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
      toast("Select who you are (\u201cActing as\u201d) before writing.", "error");
      return null;
    }
    return actor;
  }

  /* ------------------------------------------------------------------ *
   * Dates — same discipline as the rest of the app (D-027): "today" is
   * always CFG().todayISO(), never Date.now(), and every arithmetic step
   * goes through the engine's own UTC-midnight parser so a browser west of
   * Greenwich cannot shift an age by a day.
   * ------------------------------------------------------------------ */

  var MS_PER_DAY = 86400000;

  /** Whole days between two ISO dates (date parts only — the time of day an
   *  issue was raised is not what "how long has this been open" means). */
  function daysBetween(fromIso, toIso) {
    var parseISO = getEngine()._internals.parseISO;
    var a = parseISO(String(fromIso).slice(0, 10));
    var b = parseISO(String(toIso).slice(0, 10));
    if (a === null || b === null) return null;
    return Math.round((b - a) / MS_PER_DAY);
  }

  function ageInDays(issue) {
    return daysBetween(issue.raisedAt, CFG().todayISO());
  }

  /** "today" / "1 day" / "12 days". Null when raisedAt is unparseable, which
   *  the caller renders as an explicit unknown rather than as 0 — a
   *  zero-day age on a corrupt timestamp would read as "raised today". */
  function ageLabel(days) {
    if (days === null) return null;
    if (days <= 0) return "today";
    return days === 1 ? "1 day" : days + " days";
  }

  function weeksSince(iso) {
    var d = daysBetween(iso, CFG().todayISO());
    if (d === null) return null;
    return Math.floor(d / 7);
  }

  /* ------------------------------------------------------------------ *
   * Derived data
   * ------------------------------------------------------------------ */

  function resolutionOf(issueId) {
    var r = state.resolutions[issueId];
    return r ? r.value : null;
  }

  function isResolved(issueId) {
    return Object.prototype.hasOwnProperty.call(state.resolutions, issueId);
  }

  /** Every ad-hoc task created from this issue, with its live status. The
   *  §13.4 join, and the entire reason sourceIssueId exists (§2) — without a
   *  reader the field would be written by the server and read by nobody,
   *  which is the defect D-080 found with the Tasks tab. */
  function todosOfIssue(issueId) {
    var out = [];
    // An empty id is not an issue. Without this guard the join below would
    // match every UNLINKED ad-hoc task (their sourceIssueId is ""), so a
    // caller passing a blank id would be handed the whole backlog of
    // issue-less work as if one issue had produced it.
    if (!issueId) return out;
    for (var id in state.tasksAdHoc) {
      if (!Object.prototype.hasOwnProperty.call(state.tasksAdHoc, id)) continue;
      var t = state.tasksAdHoc[id];
      if (t.sourceIssueId !== issueId) continue;
      var cs = state.currentState[id];
      out.push({
        id: id,
        desc: t.desc,
        owner: t.owner,
        status: cs && cs.status ? cs.status : "open"
      });
    }
    return out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  }

  /**
   * §13.4 — the case that disappears today.
   *
   * A resolved issue is not finished work. An issue closed as `todo_created`
   * whose to-dos are not ALL done gets flagged, stating how long ago it was
   * resolved and how many of its to-dos are still open.
   *
   * Only todo_created is checked: an issue closed as discussed_no_action
   * produced no work by definition, so there is nothing to follow through on.
   *
   * The zero-to-dos case is deliberately flagged too, with its own wording.
   * "Closed as todo_created and produced nothing" is not a clean close — it
   * is the same promise broken one step earlier, and silently treating it as
   * complete (0 of 0 done) would hide exactly what this section exists to
   * surface.
   *
   * @returns null when there is nothing to flag, otherwise
   *          {openCount, total, weeks, none}
   */
  function followUp(issueId) {
    if (resolutionOf(issueId) !== "todo_created") return null;

    var todos = todosOfIssue(issueId);
    var open = todos.filter(function (t) { return t.status !== "done"; });
    if (todos.length && !open.length) return null; // all done — nothing to chase

    var r = state.resolutions[issueId];
    return {
      openCount: open.length,
      total: todos.length,
      weeks: r ? weeksSince(r.timestamp) : null,
      none: todos.length === 0
    };
  }

  /** Open issues, OLDEST FIRST — the whole ordering rule (§13.3, D-096c).
   *  Ties and unparseable timestamps fall back to the id, which is itself
   *  assigned in creation order, so the order is always total and stable. */
  function openIssuesOldestFirst() {
    var out = [];
    for (var id in state.issues) {
      if (!Object.prototype.hasOwnProperty.call(state.issues, id)) continue;
      if (isResolved(id)) continue;
      out.push(state.issues[id]);
    }
    return out.sort(compareByRaisedAtThenId);
  }

  /** Resolved issues, most recently resolved first — the mirror of the open
   *  list's rule: there, the longest-waiting matters most; here, what just
   *  closed is what the meeting was talking about. The §13.4 flags are what
   *  pull an older one back into view. */
  function resolvedIssuesNewestFirst() {
    var out = [];
    for (var id in state.issues) {
      if (!Object.prototype.hasOwnProperty.call(state.issues, id)) continue;
      if (!isResolved(id)) continue;
      out.push(state.issues[id]);
    }
    return out.sort(function (a, b) {
      var ra = state.resolutions[a.id], rb = state.resolutions[b.id];
      var ta = ra ? String(ra.timestamp || "") : "";
      var tb = rb ? String(rb.timestamp || "") : "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  }

  function compareByRaisedAtThenId(a, b) {
    var ta = String(a.raisedAt || "");
    var tb = String(b.raisedAt || "");
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /**
   * The week a to-do created from here lands in.
   *
   * OPEN QUESTION, reported rather than decided quietly: §13.3 says the
   * ad-hoc form opens with "owner, workDays and the optional deadline filled
   * normally" and never mentions the week, but §11.6/D-066(b) make a week
   * mandatory on every ad-hoc task — the server rejects a createTask without
   * one, because there is no backlog for a weekless task to be found in. The
   * Issues view has no week selector of its own (§13.5: it does not
   * schedule), so a week has to come from somewhere.
   *
   * Chosen: the CURRENT ops week — work coming out of an issue is work for
   * now, and during the L10 that is the week being discussed. The form says
   * which week it will land in, so the choice is visible rather than
   * implied.
   */
  function targetWeek() {
    return getThisWeek().opsWeek(CFG().todayISO(), state.opsWeekStartDay, 0);
  }

  /* ------------------------------------------------------------------ *
   * Markup
   * ------------------------------------------------------------------ */

  var RESOLUTION_LABEL = {
    discussed_no_action: "Discussed, no action",
    todo_created: "To-do created"
  };

  var STATUS_LABEL = { open: "Open", in_progress: "In progress", done: "Done" };

  function todoListHtml(issueId) {
    var todos = todosOfIssue(issueId);
    if (!todos.length) {
      return '<p class="issue-empty">No to-dos created from this issue yet.</p>';
    }
    return '<ul class="issue-todos">' + todos.map(function (t) {
      return '<li class="issue-todo' + (t.status === "done" ? " is-done" : "") + '">' +
        '<span class="issue-todo-id">' + escapeHtml(t.id) + "</span>" +
        '<span class="issue-todo-desc">' + escapeHtml(t.desc) + "</span>" +
        '<span class="issue-todo-owner">' + escapeHtml(t.owner) + "</span>" +
        '<span class="issue-todo-status">' +
          escapeHtml(STATUS_LABEL[t.status] || t.status) + "</span>" +
      "</li>";
    }).join("") + "</ul>";
  }

  /** The resolve control. §13.3: the button stays DISABLED until a
   *  resolution is chosen — that single constraint is what makes the IDS
   *  measurable at sprint end, so it is enforced here and again on the
   *  server (which rejects a resolve with no valid resolution rather than
   *  defaulting one). */
  function resolveControlHtml(issueId) {
    var chosen = state.resolveChoice[issueId] || "";
    var opts = ['<option value="">— How did it close? —</option>'];
    for (var key in RESOLUTION_LABEL) {
      if (!Object.prototype.hasOwnProperty.call(RESOLUTION_LABEL, key)) continue;
      opts.push('<option value="' + key + '"' + (chosen === key ? " selected" : "") + ">" +
        escapeHtml(RESOLUTION_LABEL[key]) + "</option>");
    }
    // aria-describedby, not just `disabled`: a disabled control with no
    // stated reason is a dead end for a screen-reader user, who cannot see
    // that the select beside it is still empty. The hint says WHY, and it is
    // the same sentence the constraint is written in (§13.3).
    var hintId = "issue-resolve-hint-" + issueId;
    return (
      '<div class="issue-resolve">' +
        '<select class="issue-resolve-select" data-action="issue-resolve-pick" ' +
          'data-issue-id="' + escapeAttr(issueId) + '" ' +
          'aria-label="Resolution for ' + escapeAttr(issueId) + '">' +
          opts.join("") +
        "</select>" +
        '<button type="button" class="todo-action-btn" data-action="issue-resolve" ' +
          'data-issue-id="' + escapeAttr(issueId) + '" ' +
          'aria-describedby="' + escapeAttr(hintId) + '"' + (chosen ? "" : " disabled") + ">" +
          "Resolve</button>" +
        '<span class="issue-resolve-hint" id="' + escapeAttr(hintId) + '">' +
          "Choose how it closed first." +
        "</span>" +
      "</div>"
    );
  }

  function createTodoHtml(issue) {
    if (state.creatingFor !== issue.id) {
      return '<button type="button" class="todo-action-btn" ' +
        'data-action="issue-create-todo-open" data-issue-id="' + escapeAttr(issue.id) + '">' +
        "Create a to-do\u2026</button>";
    }

    var win = targetWeek();
    var todos = root.OpsDashTodos;
    // §13.3: "Opens the ad-hoc form of §11.5 with sourceIssueId pre-filled
    // and locked." Literally that form, exported from todos.js — not a
    // second one that would drift from it.
    var formHtml = todos && todos.adHocFormHtml
      ? todos.adHocFormHtml(state.people.length ? state.people[0].name : "", {
          sourceIssueId: issue.id,
          week: win.mondayKey
        })
      : '<p class="issue-empty">The to-dos module is not loaded.</p>';

    return (
      '<div class="issue-create-todo">' +
        '<p class="issue-create-note">Creating a to-do from <strong>' +
          escapeHtml(issue.id) + "</strong>, into the week of " +
          escapeHtml(win.start) + " \u2013 " + escapeHtml(win.end) + ". " +
          "Creating a to-do does not resolve the issue.</p>" +
        formHtml +
        '<button type="button" class="todo-action-btn" ' +
          'data-action="issue-create-todo-close" data-issue-id="' + escapeAttr(issue.id) + '">' +
          "Cancel</button>" +
      "</div>"
    );
  }

  function openIssueHtml(issue) {
    var expanded = !!state.expanded[issue.id];
    var days = ageInDays(issue);
    var age = ageLabel(days);

    var body = expanded
      ? '<div class="issue-body">' +
          (issue.desc
            ? '<p class="issue-desc">' + escapeHtml(issue.desc) + "</p>"
            : '<p class="issue-empty">No description.</p>') +
          '<h4 class="issue-subhead">To-dos from this issue</h4>' +
          todoListHtml(issue.id) +
          '<div class="issue-actions">' +
            createTodoHtml(issue) +
            resolveControlHtml(issue.id) +
          "</div>" +
        "</div>"
      : "";

    return (
      '<li class="issue-row" data-issue-id="' + escapeAttr(issue.id) + '">' +
        '<button type="button" class="issue-head" data-action="issue-toggle" ' +
          'data-issue-id="' + escapeAttr(issue.id) + '" aria-expanded="' + expanded + '">' +
          '<span class="issue-id">' + escapeHtml(issue.id) + "</span>" +
          '<span class="issue-title">' + escapeHtml(issue.title) + "</span>" +
          '<span class="issue-meta">' +
            escapeHtml(issue.raisedBy || "unknown") + " \u00b7 " +
            (age === null
              ? "age unknown"
              : "open " + escapeHtml(age)) +
          "</span>" +
        "</button>" +
        body +
      "</li>"
    );
  }

  function followUpHtml(issueId) {
    var f = followUp(issueId);
    if (!f) return "";

    var when = f.weeks === null
      ? "resolved"
      : f.weeks <= 0
        ? "resolved this week"
        : f.weeks === 1 ? "resolved 1 week ago" : "resolved " + f.weeks + " weeks ago";

    var what = f.none
      ? "closed as \u201cto-do created\u201d but no to-do was ever created"
      : f.openCount + " of " + f.total + " to-do" + (f.total === 1 ? "" : "s") + " still open";

    // aria-hidden on the glyph: it is decoration, the sentence beside it
    // already says everything. Announced, it would read as "warning sign"
    // in front of every flagged row for no added meaning.
    return '<p class="issue-followup"><span aria-hidden="true">\u26a0</span> ' +
      escapeHtml(when) + " \u2014 " + escapeHtml(what) + ".</p>";
  }

  function resolvedIssueHtml(issue) {
    var expanded = !!state.expanded[issue.id];
    var res = resolutionOf(issue.id);
    var r = state.resolutions[issue.id];

    var body = expanded
      ? '<div class="issue-body">' +
          (issue.desc
            ? '<p class="issue-desc">' + escapeHtml(issue.desc) + "</p>"
            : '<p class="issue-empty">No description.</p>') +
          (r && r.note ? '<p class="issue-resolve-note">' + escapeHtml(r.note) + "</p>" : "") +
          '<h4 class="issue-subhead">To-dos from this issue</h4>' +
          todoListHtml(issue.id) +
        "</div>"
      : "";

    return (
      '<li class="issue-row is-resolved" data-issue-id="' + escapeAttr(issue.id) + '">' +
        '<button type="button" class="issue-head" data-action="issue-toggle" ' +
          'data-issue-id="' + escapeAttr(issue.id) + '" aria-expanded="' + expanded + '">' +
          '<span class="issue-id">' + escapeHtml(issue.id) + "</span>" +
          '<span class="issue-title">' + escapeHtml(issue.title) + "</span>" +
          '<span class="issue-resolution">' +
            escapeHtml(RESOLUTION_LABEL[res] || res || "resolved") + "</span>" +
        "</button>" +
        followUpHtml(issue.id) +
        body +
        '<div class="issue-actions">' +
          '<button type="button" class="todo-action-btn" data-action="issue-unresolve" ' +
            'data-issue-id="' + escapeAttr(issue.id) + '">Undo resolve</button>' +
        "</div>" +
      "</li>"
    );
  }

  /** Raise an issue — §13.3: available from this view at any time, not gated
   *  to the meeting and not gated to a week. An issue has no owner and no
   *  week (§13.5), so this form is exactly two fields. */
  function raiseFormHtml() {
    return (
      '<div class="issue-raise" data-role="issue-raise">' +
        "<h3>Raise an issue</h3>" +
        '<input type="text" class="issue-raise-title" placeholder="What is the issue?" ' +
          'aria-label="Issue title" autocomplete="off" />' +
        '<textarea class="issue-raise-desc" rows="2" ' +
          'placeholder="Context needed to discuss it later (optional)" ' +
          'aria-label="Issue description"></textarea>' +
        // .btn-primary, NOT .btn-secondary: the latter is scoped to the dark
        // top bar and renders white-on-white here (1.06:1 — invisible).
        '<button type="button" class="btn btn-primary" data-action="issue-raise">' +
          "Raise issue</button>" +
      "</div>"
    );
  }

  function render() {
    dom.mainEl = dom.mainEl || document.getElementById("main");
    if (!dom.mainEl) return;

    var open = openIssuesOldestFirst();
    var resolved = resolvedIssuesNewestFirst();

    var openHtml = open.length
      ? '<ul class="issue-list">' + open.map(openIssueHtml).join("") + "</ul>"
      : '<p class="issue-empty">No open issues.</p>';

    var resolvedHtml = resolved.length
      ? '<ul class="issue-list">' + resolved.map(resolvedIssueHtml).join("") + "</ul>"
      : '<p class="issue-empty">Nothing resolved yet.</p>';

    dom.mainEl.innerHTML =
      '<div class="issue-header">' +
        "<h2>Issues</h2>" +
        '<span class="issue-header-note">Oldest first \u2014 the ones open ' +
          "longest come first.</span>" +
      "</div>" +
      raiseFormHtml() +
      '<div class="issue-section">' +
        "<h3>Open (" + open.length + ")</h3>" +
        openHtml +
      "</div>" +
      '<div class="issue-section">' +
        "<h3>Resolved (" + resolved.length + ")</h3>" +
        resolvedHtml +
      "</div>";
  }

  /* ------------------------------------------------------------------ *
   * Refresh after any write — full refetch + refold, the same choice
   * todos.js made and for the same reason: these are infrequent meeting
   * clicks, not a hot path, and re-reading is simpler to keep correct than
   * patching four maps by hand.
   *
   * Re-reads the Issues AND Tasks tabs, not just Events: raising an issue
   * and creating a to-do both write ROWS, which no amount of event folding
   * would reveal.
   * ------------------------------------------------------------------ */

  function refreshFromServer() {
    var cfg = CFG();
    return Promise.all([
      getEvents().fetchEvents(),
      root.OpsDashApp.fetchSheetValues(cfg, cfg.TABS.ISSUES),
      root.OpsDashApp.fetchSheetValues(cfg, cfg.TABS.TASKS)
    ]).then(function (results) {
      var folded = getEvents().fold(results[0]);
      state.folded = folded;
      state.currentState = getEvents().toCurrentState(folded);
      state.resolutions = getEvents().issueResolutions(folded);
      state.issues = root.OpsDashApp.parseIssues(results[1]);
      state.tasksAdHoc = root.OpsDashApp.parseTasks(results[2]);
      render();
    });
  }

  /* ------------------------------------------------------------------ *
   * Writes
   * ------------------------------------------------------------------ */

  function postAndRefresh(action, issueId, value, note, successMsg) {
    var actor = requireActor();
    if (!actor) return;
    getEvents().postEvent(action, issueId, value, actor, note || "")
      .then(function (result) {
        if (!result.ok) { toast(describeWriteError(result), "error"); return; }
        return refreshFromServer().then(function () {
          if (successMsg) toast(successMsg, "success");
        });
      })
      .catch(function (err) { toast("Could not save: " + err.message, "error"); });
  }

  /**
   * createIssue is a sibling RPC, not an Events action (§13.2) — the same
   * shape as todos.js's postCreateTask, following the §3 write-path rules:
   * text/plain "simple request", no-cors ONLY on a TypeError, and the
   * backend does its own write-then-verify (returning `verified`).
   */
  function postCreateIssue(payload) {
    // Same write gate as postEvent and createTask (D-109) — one overlay for
    // every write in the app, raised in exactly one place.
    return getEvents().guardedWrite("Raising the issue…", function () {
      return postCreateIssueUnguarded(payload);
    });
  }

  function postCreateIssueUnguarded(payload) {
    var cfg = CFG();
    var body = JSON.stringify(Object.assign({ action: "createIssue" }, payload));
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
              return { ok: false, code: "UNVERIFIED",
                message: "Sent, but the network blocked reading the response — check the Issues tab." };
            })
            .catch(function () {
              return { ok: false, code: "POST_FAILED", message: "Could not reach the server." };
            });
        }
        return { ok: false, code: "POST_FAILED", message: String((err && err.message) || err) };
      });
  }

  function onRaiseIssue(btn) {
    var actor = requireActor();
    if (!actor) return;

    var wrap = btn.closest("[data-role='issue-raise']");
    if (!wrap) return;
    var titleEl = wrap.querySelector(".issue-raise-title");
    var descEl = wrap.querySelector(".issue-raise-desc");
    var title = titleEl.value.trim();

    if (!title) { toast("A title is required.", "error"); titleEl.focus(); return; }

    // Same in-flight guard every other write in this app uses: a slow request
    // must not let a second click raise the same issue twice.
    var fields = wrap.querySelectorAll("input, textarea, button");
    fields.forEach(function (el) { el.disabled = true; });
    btn.textContent = "Raising\u2026";

    postCreateIssue({
      sprintId: (root.OpsDashConfig && root.OpsDashConfig.SPRINT_ID) || "",
      title: title, desc: descEl.value.trim(), actor: actor
    }).then(function (result) {
      if (!result.ok) {
        toast(describeWriteError(result), "error");
        fields.forEach(function (el) { el.disabled = false; });
        btn.textContent = "Raise issue";
        return;
      }
      return refreshFromServer().then(function () {
        toast("Raised " + result.id + ".", "success");
      });
    }).catch(function (err) {
      toast("Could not raise the issue: " + err.message, "error");
      fields.forEach(function (el) { el.disabled = false; });
      btn.textContent = "Raise issue";
    });
  }

  function onResolve(issueId) {
    var choice = state.resolveChoice[issueId];
    // Belt and braces behind the disabled button — and the server rejects a
    // resolve with no valid resolution anyway (§13.2). Three layers, because
    // a defaulted resolution would silently corrupt the one number §13 exists
    // to produce.
    if (!choice) {
      toast("Choose how the issue closed before resolving.", "error");
      return;
    }
    postAndRefresh("resolveIssue", issueId, choice, "",
      "Resolved " + issueId + " (" + (RESOLUTION_LABEL[choice] || choice) + ").");
  }

  function onUnresolve(issueId) {
    postAndRefresh("unresolveIssue", issueId, "", "", "Reopened " + issueId + ".");
  }

  function onCreateTodo(btn) {
    var wrap = btn.closest(".todo-adhoc-form");
    if (!wrap) return;
    var todos = root.OpsDashTodos;
    if (!todos || !todos.submitAdHoc) {
      toast("The to-dos module is not loaded.", "error");
      return;
    }
    // Reuses §11.5's own validation, in-flight disable and createTask call
    // (todos.js), and only takes back the refresh — this view has to re-read
    // the Tasks tab to recount §13.4, which todos.js's own refresh does not.
    todos.submitAdHoc(btn.getAttribute("data-person"), wrap, {
      onCreated: function (result) {
        state.creatingFor = null;
        return refreshFromServer().then(function () {
          toast("Added " + result.id + ".", "success");
        });
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Event delegation — this module's own #main listeners, installed once
   * ------------------------------------------------------------------ */

  /** After a re-render, put keyboard focus back on the row the person was
   *  operating, so expanding an issue does not send them to the top of the
   *  page. Silent when the row is gone (it was resolved and moved section) —
   *  a missing row is a normal outcome, not an error. */
  function restoreFocusToIssue(issueId) {
    if (!dom.mainEl) return;
    var head = dom.mainEl.querySelector(
      '.issue-row[data-issue-id="' + cssEscape(issueId) + '"] .issue-head');
    if (head && typeof head.focus === "function") head.focus();
  }

  function onClick(e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var issueId = el.getAttribute("data-issue-id");

    if (action === "issue-toggle") {
      if (state.expanded[issueId]) delete state.expanded[issueId];
      else state.expanded[issueId] = true;
      render();
      // render() replaces all of #main, which destroys the very button that
      // was just activated — a keyboard user would be dropped back to the
      // top of the document on every expand. Put focus back on the row they
      // are on. Found by the web-design-guidelines pass.
      restoreFocusToIssue(issueId);
    } else if (action === "issue-raise") {
      onRaiseIssue(el);
    } else if (action === "issue-resolve") {
      onResolve(issueId);
    } else if (action === "issue-unresolve") {
      onUnresolve(issueId);
    } else if (action === "issue-create-todo-open") {
      state.creatingFor = issueId;
      state.expanded[issueId] = true;
      render();
      // Straight into the field they came to fill, rather than back to the
      // top of the page — the one place in this view where moving focus
      // forward is what the person actually asked for.
      var descField = dom.mainEl.querySelector(
        '.issue-row[data-issue-id="' + cssEscape(issueId) + '"] .todo-adhoc-desc');
      if (descField && typeof descField.focus === "function") descField.focus();
      else restoreFocusToIssue(issueId);
    } else if (action === "issue-create-todo-close") {
      state.creatingFor = null;
      render();
      restoreFocusToIssue(issueId);
    } else if (action === "todo-add-adhoc") {
      onCreateTodo(el);
    }
  }

  function onChange(e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    if (el.getAttribute("data-action") !== "issue-resolve-pick") return;

    var issueId = el.getAttribute("data-issue-id");
    var value = el.value;
    if (value) state.resolveChoice[issueId] = value;
    else delete state.resolveChoice[issueId];

    // Enable/disable in place rather than re-rendering: a full render would
    // close the <select> the person is still looking at and lose their place
    // in a list being walked live in a meeting.
    var row = dom.mainEl.querySelector('.issue-row[data-issue-id="' + cssEscape(issueId) + '"]');
    var btn = row && row.querySelector('[data-action="issue-resolve"]');
    if (btn) btn.disabled = !value;
  }

  /* ------------------------------------------------------------------ *
   * Mount
   * ------------------------------------------------------------------ */

  function mount(initial) {
    state.issues = initial.issues || {};
    state.tasksAdHoc = initial.tasks || {};
    state.currentState = initial.currentState || {};
    state.people = initial.people || [];
    state.opsWeekStartDay = initial.opsWeekStartDay || "Friday";
    state.folded = initial.folded || { byTask: {}, events: [], warnings: [] };
    state.resolutions = initial.resolutions ||
      getEvents().issueResolutions(state.folded);

    state.expanded = {};
    state.creatingFor = null;
    state.resolveChoice = {};

    dom.mainEl = document.getElementById("main");
    dom.toastContainer = document.getElementById("toast-container");
    // Listeners are NOT attached here — see setActive(). This module adding
    // a second listener to the shared #main at mount time is what caused the
    // double createTask; the full reasoning is in todos.js's setActive().
  }

  /** Attach this view's #main listeners only while it is the visible view.
   *  Same contract and same reasoning as todos.js's setActive(), including
   *  the remove-before-add idempotence. */
  function setActive(active) {
    if (!dom.mainEl) dom.mainEl = document.getElementById("main");
    if (!dom.mainEl) return;
    dom.mainEl.removeEventListener("click", onClick);
    dom.mainEl.removeEventListener("change", onChange);
    if (active) {
      dom.mainEl.addEventListener("click", onClick);
      dom.mainEl.addEventListener("change", onChange);
    }
  }

  root.OpsDashIssues = {
    mount: mount,
    render: render,
    setActive: setActive,
    _internals: {
      getState: function () { return state; },
      postCreateIssue: postCreateIssue, // tests/write-overlay.test.js
      openIssuesOldestFirst: openIssuesOldestFirst,
      resolvedIssuesNewestFirst: resolvedIssuesNewestFirst,
      todosOfIssue: todosOfIssue,
      followUp: followUp,
      ageInDays: ageInDays,
      ageLabel: ageLabel,
      weeksSince: weeksSince,
      isResolved: isResolved,
      resolutionOf: resolutionOf,
      targetWeek: targetWeek,
      openIssueHtml: openIssueHtml,
      resolvedIssueHtml: resolvedIssueHtml,
      followUpHtml: followUpHtml
    }
  };
})(typeof window !== "undefined" ? window : this);
