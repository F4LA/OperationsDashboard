/**
 * Operations Dashboard — Apps Script Web App (backend, spec §3)
 *
 * Single file for v1 (D-035). Paste this into the Apps Script editor of the
 * Operations Dashboard spreadsheet and deploy it as a Web App.
 *
 * Exposes ONLY doPost (D-038). There is deliberately no doGet and no read
 * endpoint: every read (People, the Events fold) goes straight from the
 * frontend to Sheets API v4 with a referrer-restricted key, per §3's
 * architecture diagram.
 *
 * ---------------------------------------------------------------------------
 * Request shape
 * ---------------------------------------------------------------------------
 * POST body is JSON (sent as text/plain so it stays a CORS "simple request"
 * and never triggers the preflight OPTIONS that Apps Script cannot answer —
 * see §3 "Write path"). Four accepted forms. All unambiguous: "appendEvent",
 * "createTask" and "createIssue" are RPC actions, never members of
 * EVENT_ACTIONS, so a bare action string always resolves to one branch:
 *
 *   { "action": "appendEvent", "eventAction": "setStatus", ... }   // spec-literal
 *   { "action": "setStatus", ... }                                 // shorthand
 *   { "action": "createTask", "desc": ..., "owner": ..., ... }     // D-066, own RPC
 *   { "action": "createIssue", "title": ..., "desc": ... }         // D-096, own RPC
 *
 * Fields (appendEvent / shorthand):
 *   action       required  "appendEvent" (then eventAction is required), or one
 *                          of EVENT_ACTIONS directly (setStatus, setDeliverable,
 *                          pin, unpin, discard, undiscard, cancel, uncancel,
 *                          confirmWeek — §3)
 *   eventAction  required only when action === "appendEvent"
 *   taskId       required  non-empty; goes to the "Task ID" column. discard/
 *                          undiscard require the T-NNNN namespace (D-067);
 *                          cancel/uncancel forbid it (D-068); confirmWeek
 *                          requires "WEEK-<ISO Monday>" (D-070); resolveIssue/
 *                          unresolveIssue require the I-NNNN namespace (§13.2)
 *   actor        required  must match an active row in the People tab
 *   value        per-action, see validateValue_ below
 *   sprintId     optional  recorded as-is; not validated (the spec's rejection
 *                          list is explicit and does not include it)
 *   note         optional free text, capped at MAX_NOTE_LEN for EVERY action
 *                          (D-075) and rejected — never truncated — over it.
 *                          EXCEPT: mandatory (the reason) on discard and
 *                          cancel; a JSON array of strings on confirmWeek
 *                          (D-069, D-070)
 *
 * Fields (createTask, D-066 — a sibling RPC, writes the Tasks tab + a pin
 * event under the same lock, never the Events log directly):
 *   sprintId       optional, recorded on the pin event only (Tasks has no
 *                            sprintId column)
 *   desc           required non-empty
 *   owner          required exactly one active Person; "Both" is rejected by
 *                            its own named code (OWNER_BOTH_NOT_ALLOWED),
 *                            never folded into OWNER_UNKNOWN
 *   workDays       required numeric > 0, fractions allowed
 *   week           required ISO Monday — validated with the SAME validator
 *                            pin uses, and appended as that task's first pin
 *                            event inside the same lock (§11.6: no task is
 *                            ever born without a week)
 *   deadline       optional ISO date
 *   sourceIssueId  optional I-NNNN; when present it must name a row that
 *                            actually exists in the Issues tab (§13.2, D-096)
 *   actor          required, same People-tab check as every other write
 *   note           optional
 *
 * Fields (createIssue, §13.2 / D-096 — a sibling RPC, writes one row in the
 * Issues tab and nothing else; an issue has no week, no owner and no
 * schedule, §13.5):
 *   title          required non-empty, capped at MAX_NOTE_LEN
 *   desc           optional, capped at MAX_NOTE_LEN
 *   sprintId       optional, stamped on the row so sprint-end counting needs
 *                            no inference from timestamps (§13.1)
 *   actor          required, same People-tab check; becomes raisedBy
 *   (id, raisedBy and raisedAt are ALL server-generated — the client never
 *    sends them, §13.1)
 *
 * ---------------------------------------------------------------------------
 * Response
 * ---------------------------------------------------------------------------
 * Always JSON, always HTTP 200 — Apps Script's ContentService cannot set status
 * codes, so callers MUST branch on the `ok` field, never on the HTTP status:
 *
 *   { "ok": true,  "eventId": "E-...", "timestamp": "...", "row": 12, ... }
 *   { "ok": false, "code": "ACTOR_UNKNOWN", "message": "..." }
 *
 * Never returns an opaque or HTML body: every path, including an unexpected
 * exception, is funnelled through json_() so the frontend can always parse it.
 * (That is the D-009 / testimonial-dashboard scar restated — an opaque failure
 * that looks like success is the bug this shape exists to prevent.)
 */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/** Leave blank when the script is bound to the spreadsheet (the normal setup). */
var SPREADSHEET_ID = "";

var TAB_PEOPLE = "People";
var TAB_EVENTS = "Events";
var TAB_TASKS = "Tasks"; // ad-hoc tasks (§3 v2, §11, D-066)
var TAB_ISSUES = "Issues"; // §13, D-096

/** Column schemas fixed by D-033 (and, for Tasks, D-066). Order matters — the
 *  header guard is positional. */
var PEOPLE_HEADERS = ["Name", "Slack/Email", "Active"];
var EVENTS_HEADERS = [
  "Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"
];
var TASKS_HEADERS = [
  "id", "desc", "owner", "workDays", "deadline", "sourceIssueId", "createdBy", "createdAt"
];
/**
 * §13.1. Note what is NOT here: `status` and `resolution` are state, so they
 * live in the Events log like every other piece of state — the same rule that
 * keeps a task's status out of the Tasks row. (§3's tab summary still lists
 * the pre-v2.1 column set with status/resolution/resolvedBy/resolvedAt
 * inline; §13.1 is the newer text and states the exclusion explicitly, so it
 * governs. Reported as a spec inconsistency for the PUSH session.)
 */
var ISSUES_HEADERS = ["id", "sprintId", "title", "desc", "raisedBy", "raisedAt"];

var EVENTS_COL_TIMESTAMP = 7; // 1-based index of "Timestamp" in EVENTS_HEADERS

var RPC_APPEND = "appendEvent";
var RPC_CREATE_TASK = "createTask";   // D-066 — a sibling RPC, not a 5th event action
var RPC_CREATE_ISSUE = "createIssue"; // §13.2, D-096 — same reasoning: it CREATES an
                                      // object rather than changing one
var EVENT_ACTIONS = [
  "setStatus", "setDeliverable", "pin", "unpin",
  "discard", "undiscard", "cancel", "uncancel", "confirmWeek", // v2, §3
  "resolveIssue", "unresolveIssue" // §13.2, D-096 — a reversal pair (D-069)
];
var STATUS_VALUES = ["open", "in_progress", "done"];

/** §13.2: the resolution is MANDATORY on resolveIssue and is exactly one of
 *  these two. A resolve without a valid one is rejected, never defaulted —
 *  this single constraint is what makes the IDS measurable at sprint end
 *  ("closed with no action" vs. "produced work"), and a default would quietly
 *  invent that answer. */
var ISSUE_RESOLUTIONS = ["discussed_no_action", "todo_created"];

/** Namespace rules that let the server enforce §11.4's asymmetry without
 *  knowing the plan (D-067, D-068): an ad-hoc id always looks like T-NNNN;
 *  a plan-task id never does. §13 adds a third namespace, I-NNNN, which is
 *  how resolveIssue/unresolveIssue can be namespace-checked without reading
 *  the Issues tab — the same shape of rule, one tab wider. */
var ADHOC_ID_RE = /^T-\d{4}$/;
var ISSUE_ID_RE = /^I-\d{4}$/;

var LOCK_WAIT_MS = 30000;
var MAX_VALUE_LEN = 2000;

/**
 * The cap on EVERY Note, whatever the action (D-075). Two things ride on it:
 *
 *   - confirmWeek's Note carries the JSON array of frozen task ids for that
 *     week, and a truncated denominator would read as "everyone did double
 *     the work" rather than "broken" (D-070);
 *   - discard/cancel reasons are free text a person pastes, and a Sheets cell
 *     cuts at 50,000 characters, which would surface as a raw exception
 *     instead of a named rejection.
 *
 * Over the cap is REJECTED, never shortened, in both cases.
 *
 * 5000 is a deliberately generous bound — comfortably a week of 100+ task ids
 * with JSON-array overhead. This is the single source of that number: D-075
 * requires the frontend to read it from here and never define its own, and
 * forbids a `maxlength` attribute on the reason input, because a paste that
 * silently arrives clipped is the same truncation moved into the browser.
 */
var MAX_NOTE_LEN = 5000;

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function doPost(e) {
  var lock = null;

  try {
    /* ---- 1. body ---- */
    if (!e || !e.postData || !e.postData.contents) {
      return json_({
        ok: false, code: "BAD_REQUEST",
        message: "Empty request body. POST a JSON payload."
      });
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return json_({
        ok: false, code: "BAD_REQUEST",
        message: "Body is not valid JSON: " + parseErr.message
      });
    }

    if (!payload || typeof payload !== "object" || Object.prototype.toString.call(payload) === "[object Array]") {
      return json_({
        ok: false, code: "BAD_REQUEST",
        message: "Payload must be a JSON object."
      });
    }

    /* ---- 2. which RPC / event action (createTask and createIssue are sibling
       RPCs, D-066 / D-096) ---- */
    var resolved = resolveAction_(payload);
    if (resolved.error) return json_(resolved.error);

    if (resolved.rpc === RPC_CREATE_TASK) {
      return doCreateTask_(payload);
    }

    if (resolved.rpc === RPC_CREATE_ISSUE) {
      return doCreateIssue_(payload);
    }

    var eventAction = resolved.eventAction;

    /* ---- 3. task id (§3: reject an empty Task ID) ---- */
    var taskId = trimStr_(payload.taskId);
    if (!taskId) {
      return json_({
        ok: false, code: "MISSING_TASK_ID",
        message: "taskId is required and cannot be empty."
      });
    }

    /* ---- 4. actor present (existence is checked against People below) ---- */
    var actor = trimStr_(payload.actor);
    if (!actor) {
      return json_({
        ok: false, code: "MISSING_ACTOR",
        message: "actor is required and cannot be empty."
      });
    }

    /* ---- 5. value, per action (namespace rules for discard/cancel/confirmWeek
       need taskId, so it's threaded through here rather than re-derived) ---- */
    var valueCheck = validateValue_(eventAction, payload.value, taskId);
    if (valueCheck.error) return json_(valueCheck.error);
    var value = valueCheck.value;

    /* ---- 5b. note, per action (mandatory reason on discard/cancel, D-069;
       JSON-array-of-strings + MAX_NOTE_LEN on confirmWeek, D-070) ---- */
    var noteCheck = validateNote_(eventAction, payload.note);
    if (noteCheck.error) return json_(noteCheck.error);
    var note = noteCheck.note;

    var sprintId = trimStr_(payload.sprintId);

    /* ---- 6. serialize concurrent writes (§3) ---- */
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (lockErr) {
      lock = null; // nothing to release
      return json_({
        ok: false, code: "LOCK_TIMEOUT",
        message: "Another write is in progress; could not acquire the lock within " +
          (LOCK_WAIT_MS / 1000) + "s. Retry."
      });
    }

    /* ---- 7. tabs + header guard (§3) ---- */
    var ss = getSpreadsheet_();

    var peopleSheet = ss.getSheetByName(TAB_PEOPLE);
    if (!peopleSheet) {
      return json_({
        ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_PEOPLE + '" not found in this spreadsheet.'
      });
    }

    var eventsSheet = ss.getSheetByName(TAB_EVENTS);
    if (!eventsSheet) {
      return json_({
        ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_EVENTS + '" not found in this spreadsheet.'
      });
    }

    var peopleGuard = checkHeaders_(peopleSheet, PEOPLE_HEADERS, TAB_PEOPLE);
    if (peopleGuard.error) return json_(peopleGuard.error);

    var eventsGuard = checkHeaders_(eventsSheet, EVENTS_HEADERS, TAB_EVENTS);
    if (eventsGuard.error) return json_(eventsGuard.error);

    /* ---- 8. actor must be an active person (§3: the REAL enforcement) ---- */
    var actorCheck = checkActor_(peopleSheet, actor);
    if (actorCheck.error) return json_(actorCheck.error);

    /* ---- 9. server-generated identity + time ---- */
    var now = new Date();
    var eventId = makeEventId_(now.getTime());          // D-034
    var timestamp = formatTimestamp_(ss, now);          // D-033, sheet timezone

    var row = [
      eventId,
      sprintId,
      taskId,
      eventAction,
      value,
      actorCheck.name,   // canonical spelling from the People tab
      timestamp,
      note
    ];

    eventsSheet.appendRow(row);
    var rowNumber = eventsSheet.getLastRow();

    // Force the Timestamp cell to stay TEXT. Sheets happily auto-coerces an ISO
    // datetime string into a date value, after which a Sheets API read returns a
    // locale-formatted string instead of what we wrote — which would silently
    // break the fold's timestamp parsing in events.js.
    try {
      var tsCell = eventsSheet.getRange(rowNumber, EVENTS_COL_TIMESTAMP);
      tsCell.setNumberFormat("@");
      tsCell.setValue(timestamp);
    } catch (fmtErr) {
      // Non-fatal: the row is already written. Surface it rather than hide it.
      return json_({
        ok: true, code: "OK_TIMESTAMP_FORMAT_WARNING",
        message: "Row appended, but the Timestamp cell could not be forced to text: " +
          fmtErr.message,
        eventId: eventId, timestamp: timestamp, row: rowNumber,
        taskId: taskId, action: eventAction, value: value, actor: actorCheck.name
      });
    }

    return json_({
      ok: true,
      code: "OK",
      message: "Event appended.",
      eventId: eventId,
      timestamp: timestamp,
      row: rowNumber,
      sprintId: sprintId,
      taskId: taskId,
      action: eventAction,
      value: value,
      actor: actorCheck.name,
      note: note
    });

  } catch (err) {
    return json_({
      ok: false, code: "INTERNAL",
      message: String((err && err.message) || err)
    });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (releaseErr) { /* nothing useful to do */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * createTask (D-066) — a sibling RPC of appendEvent, not a 10th event
 * action: it writes a row in a DIFFERENT tab with a different schema, and
 * additionally appends one ordinary `pin` event so the new task is born
 * inside a week (§11.6 — there is deliberately no backlog to find it in).
 *
 * Write ORDER inside the lock is deliberate and load-bearing. Apps Script
 * has no transactions, so one of the two appends can land without the
 * other. The pin is written FIRST so that the orphan, if there is one, is
 * the pin and never the task:
 *
 *   - an orphaned pin points at a task id that does not exist. The fold is
 *     by (Task ID, Action), so it simply never joins to anything and is
 *     inert.
 *   - an orphaned TASK, by contrast, would exist with no week — invisible in
 *     every view, and unrecoverable, because §11.6 decided there is no
 *     backlog to go looking in. That is the exact failure D-066(b) exists to
 *     prevent, so it is the one that must not be possible.
 *
 * If the Tasks append then fails, the response says so and names the loose
 * event, rather than reporting a success the sheet doesn't contain.
 * ------------------------------------------------------------------ */

function doCreateTask_(payload) {
  var lock = null;

  try {
    /* ---- 1. shape checks that need no sheet read ---- */
    var actor = trimStr_(payload.actor);
    if (!actor) {
      return json_({
        ok: false, code: "MISSING_ACTOR",
        message: "actor is required and cannot be empty."
      });
    }

    var desc = trimStr_(payload.desc);
    if (!desc) {
      return json_({
        ok: false, code: "MISSING_DESC",
        message: "desc is required and cannot be empty."
      });
    }

    var ownerRaw = trimStr_(payload.owner);
    if (!ownerRaw) {
      return json_({
        ok: false, code: "OWNER_UNKNOWN",
        message: "owner is required: exactly one active person from the People tab."
      });
    }
    // Its own code, never folded into OWNER_UNKNOWN: "Both" IS a legal owner
    // for a plan task, so the frontend needs to say "emergent work has one
    // owner", not "who is Both?" (§1 v2, D-066c).
    if (ownerRaw.toLowerCase() === "both") {
      return json_({
        ok: false, code: "OWNER_BOTH_NOT_ALLOWED",
        message: '"Both" is not a valid owner for an ad-hoc task — emergent work has ' +
          "exactly one owner (§1, D-066). Create two tasks, or pick one owner."
      });
    }

    var workDaysCheck = validateWorkDays_(payload.workDays);
    if (workDaysCheck.error) return json_(workDaysCheck.error);
    var workDays = workDaysCheck.value;

    var weekRaw = trimStr_(payload.week);
    if (!weekRaw) {
      return json_({
        ok: false, code: "MISSING_WEEK",
        message: "week is required (the ISO Monday of the target week). An ad-hoc task " +
          "is never created without one — there is no backlog to find it in (§11.6, D-066b)."
      });
    }
    // Same validator pin uses, per D-066 — one definition of "is a Monday".
    // BAD_VALUE_WEEK, not MISSING_WEEK: a week WAS supplied, it is just not a
    // Monday, and reporting "week is required" for a present-but-malformed
    // value would send the frontend looking for the wrong bug. Beyond the
    // error codes the Phase 8 brief lists as its minimum, following this
    // file's own MISSING_* / BAD_VALUE_* split.
    var weekCheck = validateMondayIso_(weekRaw, "BAD_VALUE_WEEK", "week");
    if (weekCheck.error) return json_(weekCheck.error);
    var week = weekCheck.value;

    var deadline = trimStr_(payload.deadline);
    if (deadline && parseIsoDateUtc_(deadline) === null) {
      return json_({
        ok: false, code: "BAD_VALUE_DEADLINE",
        message: 'deadline must be an ISO date (YYYY-MM-DD) when present, got "' +
          deadline + '".'
      });
    }

    // §13 exists now (D-096), so this stops being a pass-through. Shape is
    // checked here; EXISTENCE is checked below, inside the lock, because it
    // needs a sheet read. Blank stays legal — most ad-hoc work comes from
    // nowhere in particular.
    var sourceIssueId = trimStr_(payload.sourceIssueId);
    if (sourceIssueId && !ISSUE_ID_RE.test(sourceIssueId)) {
      return json_({
        ok: false, code: "BAD_VALUE_SOURCE_ISSUE",
        message: 'sourceIssueId must be an issue id (I-NNNN) when present, got "' +
          sourceIssueId + '" (§13.2).'
      });
    }

    var sprintId = trimStr_(payload.sprintId);
    var note = trimStr_(payload.note);

    /* ---- 2. serialize (§3) — everything below is inside the lock ---- */
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (lockErr) {
      lock = null;
      return json_({
        ok: false, code: "LOCK_TIMEOUT",
        message: "Another write is in progress; could not acquire the lock within " +
          (LOCK_WAIT_MS / 1000) + "s. Retry."
      });
    }

    /* ---- 3. tabs + header guard on ALL THREE tabs ---- */
    var ss = getSpreadsheet_();

    var peopleSheet = ss.getSheetByName(TAB_PEOPLE);
    if (!peopleSheet) {
      return json_({ ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_PEOPLE + '" not found in this spreadsheet.' });
    }
    var eventsSheet = ss.getSheetByName(TAB_EVENTS);
    if (!eventsSheet) {
      return json_({ ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_EVENTS + '" not found in this spreadsheet.' });
    }
    var tasksSheet = ss.getSheetByName(TAB_TASKS);
    if (!tasksSheet) {
      return json_({ ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_TASKS + '" not found in this spreadsheet.' });
    }

    var peopleGuard = checkHeaders_(peopleSheet, PEOPLE_HEADERS, TAB_PEOPLE);
    if (peopleGuard.error) return json_(peopleGuard.error);
    var eventsGuard = checkHeaders_(eventsSheet, EVENTS_HEADERS, TAB_EVENTS);
    if (eventsGuard.error) return json_(eventsGuard.error);
    var tasksGuard = checkHeaders_(tasksSheet, TASKS_HEADERS, TAB_TASKS);
    if (tasksGuard.error) return json_(tasksGuard.error);

    /* ---- 3b. sourceIssueId must name a REAL issue (§13.2, D-096). Only
       reached when one was supplied, so a deployment with no Issues tab keeps
       serving ordinary ad-hoc creation instead of failing on a tab it never
       needed. Inside the lock, like every other read that a write depends
       on. ---- */
    if (sourceIssueId) {
      var issuesSheetForCheck = ss.getSheetByName(TAB_ISSUES);
      if (!issuesSheetForCheck) {
        return json_({ ok: false, code: "MISSING_TAB",
          message: 'Tab "' + TAB_ISSUES + '" not found, but sourceIssueId "' +
            sourceIssueId + '" was supplied (§13.1).' });
      }
      var issuesGuardForCheck = checkHeaders_(issuesSheetForCheck, ISSUES_HEADERS, TAB_ISSUES);
      if (issuesGuardForCheck.error) return json_(issuesGuardForCheck.error);
      if (!issueExists_(issuesSheetForCheck, sourceIssueId)) {
        return json_({
          ok: false, code: "SOURCE_ISSUE_NOT_FOUND",
          message: 'sourceIssueId "' + sourceIssueId + '" does not match any row in the ' +
            TAB_ISSUES + " tab. A to-do cannot point at an issue that does not exist " +
            "(§13.2) — that is the unread-field defect D-080 found with the Tasks tab."
        });
      }
    }

    /* ---- 4. actor, then owner — both live against People ---- */
    var actorCheck = checkActor_(peopleSheet, actor);
    if (actorCheck.error) return json_(actorCheck.error);

    var ownerCheck = checkPerson_(peopleSheet, ownerRaw, "OWNER");
    if (ownerCheck.error) return json_(ownerCheck.error);

    /* ---- 5. id assignment, under the same lock (D-066a) ---- */
    var taskId = nextTaskId_(tasksSheet);

    /* ---- 6. server identity + time ---- */
    var now = new Date();
    var timestamp = formatTimestamp_(ss, now);
    var eventId = makeEventId_(now.getTime());

    /* ---- 7. the pin FIRST — see this section's header for why ---- */
    eventsSheet.appendRow([
      eventId, sprintId, taskId, "pin", week, actorCheck.name, timestamp, note
    ]);
    var eventRow = eventsSheet.getLastRow();

    try {
      var tsCell = eventsSheet.getRange(eventRow, EVENTS_COL_TIMESTAMP);
      tsCell.setNumberFormat("@");
      tsCell.setValue(timestamp);
    } catch (fmtErr) {
      // Non-fatal — the pin row exists. Keep going; the warning rides along
      // on the success response below.
    }

    /* ---- 8. then the Tasks row ---- */
    try {
      tasksSheet.appendRow([
        taskId, desc, ownerCheck.name, workDays, deadline, sourceIssueId,
        actorCheck.name, timestamp
      ]);
    } catch (taskErr) {
      return json_({
        ok: false, code: "TASK_ROW_APPEND_FAILED",
        message: "The week's pin event was written but the Tasks row was not: " +
          String((taskErr && taskErr.message) || taskErr) +
          ' — event ' + eventId + " (taskId " + taskId + ") is now orphaned in the " +
          "Events log. It is inert (it folds onto a task id that does not exist), " +
          "but retry the creation; the id will be reassigned.",
        orphanedEventId: eventId, taskId: taskId, eventRow: eventRow
      });
    }
    var taskRow = tasksSheet.getLastRow();

    // Same TEXT coercion guard the Events timestamp gets: createdAt is an ISO
    // string, and Sheets would otherwise turn it into a locale-formatted date
    // value on the way back out through the API.
    try {
      var createdAtCell = tasksSheet.getRange(taskRow, TASKS_HEADERS.length);
      createdAtCell.setNumberFormat("@");
      createdAtCell.setValue(timestamp);
    } catch (fmtErr2) { /* non-fatal, reported below via verify */ }

    /* ---- 9. write-then-verify, re-reading the tail of Tasks (D-066e) ---- */
    var verify = verifyTaskRow_(tasksSheet, taskId);

    return json_({
      ok: true,
      code: verify.found ? "OK" : "OK_UNVERIFIED",
      message: verify.found
        ? "Task created and pinned to " + week + "."
        : "Task and pin were appended, but re-reading the Tasks tail did not find the " +
          "row. Re-read before assuming it is missing.",
      id: taskId,
      taskId: taskId,
      row: taskRow,
      eventId: eventId,
      eventRow: eventRow,
      week: week,
      desc: desc,
      owner: ownerCheck.name,
      workDays: workDays,
      deadline: deadline,
      sourceIssueId: sourceIssueId,
      createdBy: actorCheck.name,
      createdAt: timestamp,
      verified: verify.found
    });

  } catch (err) {
    return json_({
      ok: false, code: "INTERNAL",
      message: String((err && err.message) || err)
    });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (releaseErr) { /* nothing useful to do */ }
    }
  }
}

/**
 * Server-side half of write-then-verify for Tasks (D-066e): re-reads the tail
 * of column A and confirms the id landed. This is the same-process read, so
 * unlike the frontend's version it needs no backoff — appendRow is already
 * committed by the time it returns. The frontend still does its own
 * cross-process verify through the Sheets API.
 */
function verifyTaskRow_(tasksSheet, taskId) {
  var lastRow = tasksSheet.getLastRow();
  if (lastRow < 2) return { found: false };

  var from = Math.max(2, lastRow - 40);
  var ids = tasksSheet.getRange(from, 1, lastRow - from + 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (trimStr_(ids[i][0]) === taskId) return { found: true, row: from + i };
  }
  return { found: false };
}

/* ------------------------------------------------------------------ *
 * createIssue (§13.2, D-096) — a sibling RPC of appendEvent for the same
 * reason createTask is one: it creates an object rather than changing one.
 *
 * Strictly simpler than doCreateTask_, and the difference is worth naming.
 * createTask has to write TWO rows (the task and its week's pin) because
 * §11.6 left no backlog for a weekless task to be found in, which is where
 * all of its ordering care comes from. An issue has no week, no owner and no
 * schedule (§13.5) — one row, one append, so there is no partial-write
 * window to design around here at all.
 *
 * raisedBy and raisedAt are generated HERE and never read from the payload:
 * §3's rule that identity and time are server-side, applied to a third tab.
 * ------------------------------------------------------------------ */

function doCreateIssue_(payload) {
  var lock = null;

  try {
    /* ---- 1. shape checks that need no sheet read ---- */
    var actor = trimStr_(payload.actor);
    if (!actor) {
      return json_({
        ok: false, code: "MISSING_ACTOR",
        message: "actor is required and cannot be empty."
      });
    }

    var title = trimStr_(payload.title);
    if (!title) {
      return json_({
        ok: false, code: "MISSING_TITLE",
        message: "title is required and cannot be empty (§13.1)."
      });
    }

    // desc is optional: §13.1 calls it "the context needed to discuss it
    // later", and an issue raised mid-week in one line is still an issue.
    // Both fields are capped by the same MAX_NOTE_LEN as every other free
    // text this backend accepts (D-075) — rejected, never truncated.
    var desc = trimStr_(payload.desc);
    if (title.length > MAX_NOTE_LEN) {
      return json_({
        ok: false, code: "TITLE_TOO_LONG",
        message: "title exceeds " + MAX_NOTE_LEN + " characters (" + title.length +
          "). Rejected, never truncated (D-075)."
      });
    }
    if (desc.length > MAX_NOTE_LEN) {
      return json_({
        ok: false, code: "DESC_TOO_LONG",
        message: "desc exceeds " + MAX_NOTE_LEN + " characters (" + desc.length +
          "). Rejected, never truncated (D-075)."
      });
    }

    var sprintId = trimStr_(payload.sprintId);

    /* ---- 2. serialize (§3) ---- */
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (lockErr) {
      lock = null;
      return json_({
        ok: false, code: "LOCK_TIMEOUT",
        message: "Another write is in progress; could not acquire the lock within " +
          (LOCK_WAIT_MS / 1000) + "s. Retry."
      });
    }

    /* ---- 3. tabs + header guard ---- */
    var ss = getSpreadsheet_();

    var peopleSheet = ss.getSheetByName(TAB_PEOPLE);
    if (!peopleSheet) {
      return json_({ ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_PEOPLE + '" not found in this spreadsheet.' });
    }
    var issuesSheet = ss.getSheetByName(TAB_ISSUES);
    if (!issuesSheet) {
      return json_({ ok: false, code: "MISSING_TAB",
        message: 'Tab "' + TAB_ISSUES + '" not found in this spreadsheet.' });
    }

    var peopleGuard = checkHeaders_(peopleSheet, PEOPLE_HEADERS, TAB_PEOPLE);
    if (peopleGuard.error) return json_(peopleGuard.error);
    var issuesGuard = checkHeaders_(issuesSheet, ISSUES_HEADERS, TAB_ISSUES);
    if (issuesGuard.error) return json_(issuesGuard.error);

    /* ---- 4. actor must be an active person (§3) ---- */
    var actorCheck = checkActor_(peopleSheet, actor);
    if (actorCheck.error) return json_(actorCheck.error);

    /* ---- 5. id assignment, under the same lock (§13.1: never reused) ---- */
    var issueId = nextIssueId_(issuesSheet);

    /* ---- 6. server identity + time (§13.1: the client sends neither) ---- */
    var now = new Date();
    var raisedAt = formatTimestamp_(ss, now);

    issuesSheet.appendRow([
      issueId, sprintId, title, desc, actorCheck.name, raisedAt
    ]);
    var issueRow = issuesSheet.getLastRow();

    // Same TEXT coercion guard createdAt gets in Tasks: raisedAt is an ISO
    // string and Sheets would otherwise hand it back as a locale-formatted
    // date value through the read API.
    try {
      var raisedAtCell = issuesSheet.getRange(issueRow, ISSUES_HEADERS.length);
      raisedAtCell.setNumberFormat("@");
      raisedAtCell.setValue(raisedAt);
    } catch (fmtErr) { /* non-fatal — the row exists; verify reports below */ }

    /* ---- 7. write-then-verify, same contract as createTask (D-066e) ---- */
    var verify = verifyIssueRow_(issuesSheet, issueId);

    return json_({
      ok: true,
      code: verify.found ? "OK" : "OK_UNVERIFIED",
      message: verify.found
        ? "Issue " + issueId + " raised."
        : "The Issues row was appended, but re-reading the tail did not find it. " +
          "Re-read before assuming it is missing.",
      id: issueId,
      issueId: issueId,
      row: issueRow,
      sprintId: sprintId,
      title: title,
      desc: desc,
      raisedBy: actorCheck.name,
      raisedAt: raisedAt,
      verified: verify.found
    });

  } catch (err) {
    return json_({
      ok: false, code: "INTERNAL",
      message: String((err && err.message) || err)
    });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (releaseErr) { /* nothing useful to do */ }
    }
  }
}

/** Server-side half of write-then-verify for Issues — the Tasks version,
 *  one tab over (D-066e). */
function verifyIssueRow_(issuesSheet, issueId) {
  var lastRow = issuesSheet.getLastRow();
  if (lastRow < 2) return { found: false };

  var from = Math.max(2, lastRow - 40);
  var ids = issuesSheet.getRange(from, 1, lastRow - from + 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (trimStr_(ids[i][0]) === issueId) return { found: true, row: from + i };
  }
  return { found: false };
}

/**
 * Next I-NNNN id: MAX of existing issue ids + 1, the same rule nextTaskId_
 * uses for T-NNNN and for the same reason — the max, never the row count, so
 * a deleted row or a hand-sorted sheet can never reassign a live id (§13.1:
 * "never reused").
 */
function nextIssueId_(issuesSheet) {
  var lastRow = issuesSheet.getLastRow();
  var max = 0;

  if (lastRow >= 2) {
    var ids = issuesSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = trimStr_(ids[i][0]);
      if (ISSUE_ID_RE.test(id)) {
        var n = parseInt(id.slice(2), 10);
        if (n > max) max = n;
      }
    }
  }

  var next = max + 1;
  var s = String(next);
  while (s.length < 4) s = "0" + s;
  return "I-" + s;
}

/** Does this issue id have a row? Used only by createTask's sourceIssueId
 *  check — see the note in validateValue_ on why the event actions do not
 *  need the same lookup. */
function issueExists_(issuesSheet, issueId) {
  var lastRow = issuesSheet.getLastRow();
  if (lastRow < 2) return false;

  var ids = issuesSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (trimStr_(ids[i][0]) === issueId) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Action resolution
 * ------------------------------------------------------------------ */

/**
 * Accepts the spec-literal envelope ({action:"appendEvent", eventAction:X}),
 * the shorthand ({action:X}), and the createTask / createIssue RPCs
 * ({action:"createTask"|"createIssue", ...}, D-066, D-096). Unambiguous
 * because those two are RPC actions, never members of EVENT_ACTIONS.
 */
function resolveAction_(payload) {
  var action = trimStr_(payload.action);

  if (!action) {
    return { error: {
      ok: false, code: "UNKNOWN_RPC_ACTION",
      message: 'action is required. Use "' + RPC_APPEND + '" with an eventAction, "' +
        RPC_CREATE_TASK + '", "' + RPC_CREATE_ISSUE + '", or one of [' +
        EVENT_ACTIONS.join(", ") + "] directly."
    } };
  }

  if (action === RPC_CREATE_TASK) {
    return { rpc: RPC_CREATE_TASK };
  }

  if (action === RPC_CREATE_ISSUE) {
    return { rpc: RPC_CREATE_ISSUE };
  }

  var eventAction;

  if (action === RPC_APPEND) {
    eventAction = trimStr_(payload.eventAction);
    if (!eventAction) {
      return { error: {
        ok: false, code: "UNKNOWN_ACTION",
        message: 'action "' + RPC_APPEND + '" requires an eventAction, one of [' +
          EVENT_ACTIONS.join(", ") + "]."
      } };
    }
  } else {
    eventAction = action;
  }

  if (indexOf_(EVENT_ACTIONS, eventAction) === -1) {
    return { error: {
      ok: false, code: "UNKNOWN_ACTION",
      message: 'Unknown action "' + eventAction + '". Expected one of [' +
        EVENT_ACTIONS.join(", ") + "]."
    } };
  }

  return { rpc: RPC_APPEND, eventAction: eventAction };
}

/* ------------------------------------------------------------------ *
 * Value validation, per action (§3)
 * ------------------------------------------------------------------ */

function validateValue_(eventAction, rawValue, taskId) {
  var value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();

  if (value.length > MAX_VALUE_LEN) {
    return { error: {
      ok: false, code: "VALUE_TOO_LONG",
      message: "value exceeds " + MAX_VALUE_LEN + " characters (" + value.length + ")."
    } };
  }

  if (eventAction === "setStatus") {
    if (indexOf_(STATUS_VALUES, value) === -1) {
      return { error: {
        ok: false, code: "BAD_VALUE_STATUS",
        message: 'setStatus value must be one of [' + STATUS_VALUES.join(", ") +
          '], got "' + value + '".'
      } };
    }
    return { value: value };
  }

  if (eventAction === "setDeliverable") {
    // http/https only. Rejecting other schemes is deliberate: this value is
    // rendered as a clickable link on the board (§6), so a javascript: URL here
    // would be stored XSS.
    if (!/^https?:\/\/[^\s\/?#]+[^\s]*$/i.test(value)) {
      return { error: {
        ok: false, code: "BAD_VALUE_URL",
        message: 'setDeliverable value must be a well-formed http(s) URL, got "' +
          value + '".'
      } };
    }
    return { value: value };
  }

  if (eventAction === "pin") {
    return validateMondayIso_(value, "BAD_VALUE_PIN", "pin");
  }

  if (eventAction === "unpin") {
    if (value !== "") {
      return { error: {
        ok: false, code: "BAD_VALUE_UNPIN",
        message: 'unpin value must be blank, got "' + value + '".'
      } };
    }
    return { value: "" };
  }

  /* ---- v2: discard/undiscard — ad-hoc only (T-NNNN), D-067 ---- */
  if (eventAction === "discard" || eventAction === "undiscard") {
    if (!ADHOC_ID_RE.test(taskId)) {
      return { error: {
        ok: false, code: "DISCARD_NOT_ADHOC",
        message: eventAction + ' is only valid for ad-hoc task ids (T-NNNN); got "' +
          taskId + '". Rock tasks use cancel/uncancel instead (D-068).'
      } };
    }
    if (value !== "") {
      var discardCode = eventAction === "discard" ? "BAD_VALUE_DISCARD" : "BAD_VALUE_UNDISCARD";
      return { error: {
        ok: false, code: discardCode,
        message: eventAction + ' value must be blank, got "' + value + '".'
      } };
    }
    return { value: "" };
  }

  /* ---- v2: cancel/uncancel — plan tasks only, i.e. NOT the T-NNNN namespace,
     the mirror-image rule of discard/undiscard (D-068) ---- */
  if (eventAction === "cancel" || eventAction === "uncancel") {
    if (ADHOC_ID_RE.test(taskId)) {
      return { error: {
        ok: false, code: "CANCEL_NOT_PLAN_TASK",
        message: eventAction + ' is only valid for plan-task ids (not the ad-hoc ' +
          'T-NNNN namespace); got "' + taskId + '". Ad-hoc tasks use discard/undiscard instead (D-067).'
      } };
    }
    if (value !== "") {
      var cancelCode = eventAction === "cancel" ? "BAD_VALUE_CANCEL" : "BAD_VALUE_UNCANCEL";
      return { error: {
        ok: false, code: cancelCode,
        message: eventAction + ' value must be blank, got "' + value + '".'
      } };
    }
    return { value: "" };
  }

  /* ---- §13.2: resolveIssue/unresolveIssue — a reversal pair (D-069) over the
     I-NNNN namespace. The Task ID column carries the issue id: the same
     generic use D-070 already made of it for WEEK-<Monday>, not a new abuse
     of the column.

     Unlike discard/cancel, resolveIssue's Value is MANDATORY and enumerated.
     Existence of the issue is NOT checked here, deliberately: discard and
     cancel don't read the Tasks tab to confirm their target either, the
     namespace regex is the same class of guard, and an event that folds onto
     an id nothing else references is inert (the same reasoning D-066 gives
     for tolerating an orphaned pin). createTask's sourceIssueId is the one
     place a real lookup is required, because there the id is COPIED into a
     durable row rather than folded. ---- */
  if (eventAction === "resolveIssue" || eventAction === "unresolveIssue") {
    if (!ISSUE_ID_RE.test(taskId)) {
      return { error: {
        ok: false, code: "NOT_AN_ISSUE_ID",
        message: eventAction + ' is only valid for issue ids (I-NNNN); got "' +
          taskId + '" (§13.2).'
      } };
    }
    if (eventAction === "unresolveIssue") {
      if (value !== "") {
        return { error: {
          ok: false, code: "BAD_VALUE_UNRESOLVE_ISSUE",
          message: 'unresolveIssue value must be blank, got "' + value + '".'
        } };
      }
      return { value: "" };
    }
    // resolveIssue: the resolution is required and enumerated. Both the empty
    // case and the wrong-word case are rejected loudly; neither is defaulted.
    if (indexOf_(ISSUE_RESOLUTIONS, value) === -1) {
      return { error: {
        ok: false, code: "BAD_VALUE_RESOLUTION",
        message: value === ""
          ? "resolveIssue requires a resolution in Value, one of [" +
            ISSUE_RESOLUTIONS.join(", ") + "]. An issue cannot be closed without " +
            "stating how it closed — that constraint is what makes the IDS " +
            "measurable at sprint end (§13.2, §2)."
          : 'resolveIssue value must be one of [' + ISSUE_RESOLUTIONS.join(", ") +
            '], got "' + value + '".'
      } };
    }
    return { value: value };
  }

  /* ---- v2: confirmWeek — Task ID = WEEK-<ISO Monday>, Value = the same Monday,
     freezes §12's denominator (D-070) ---- */
  if (eventAction === "confirmWeek") {
    var weekMatch = /^WEEK-(\d{4}-\d{2}-\d{2})$/.exec(taskId);
    if (!weekMatch) {
      return { error: {
        ok: false, code: "BAD_VALUE_CONFIRM_WEEK",
        message: 'confirmWeek Task ID must look like "WEEK-<ISO Monday>", got "' + taskId + '".'
      } };
    }
    var mondayCheck = validateMondayIso_(value, "BAD_VALUE_CONFIRM_WEEK", "confirmWeek");
    if (mondayCheck.error) return mondayCheck;
    if (weekMatch[1] !== value) {
      return { error: {
        ok: false, code: "BAD_VALUE_CONFIRM_WEEK",
        message: 'confirmWeek Task ID date (' + weekMatch[1] + ') must match Value (' + value + ').'
      } };
    }
    return { value: value };
  }

  // resolveAction_ already gated the enum; this is belt-and-braces.
  return { error: {
    ok: false, code: "UNKNOWN_ACTION",
    message: 'Unknown action "' + eventAction + '".'
  } };
}

/**
 * Shared Monday-ISO validator — used by pin's own branch above, by
 * confirmWeek's Value (same rule, D-070), and reused verbatim by createTask's
 * `week` field (D-066, "reusá el validador de pin").
 */
function validateMondayIso_(value, code, label) {
  var ms = parseIsoDateUtc_(value);
  if (ms === null) {
    return { error: {
      ok: false, code: code,
      message: label + ' value must be an ISO date (YYYY-MM-DD), got "' + value + '".'
    } };
  }
  if (new Date(ms).getUTCDay() !== 1) {
    return { error: {
      ok: false, code: code,
      message: label + ' value must be a MONDAY (the ISO Monday of the target week), ' +
        'got "' + value + '" which is a ' + dayName_(new Date(ms).getUTCDay()) + "."
    } };
  }
  return { value: value };
}

/**
 * Note validation (v2). MAX_NOTE_LEN applies to EVERY Note, whatever the
 * action (D-075) — checked first, before any per-action branch, so a
 * pasted wall of text in a discard/cancel reason is refused by name
 * instead of reaching a Sheets cell that silently cuts at 50,000. The
 * no-truncation rule of D-070 is unchanged and now simply covers more
 * ground: over the cap is rejected, never shortened.
 *
 * Per-action rules on top of that: mandatory reason on discard/cancel
 * (D-069); a JSON array of strings on confirmWeek (D-070). Every other
 * action's note stays free, optional text — now merely length-bounded.
 */
function validateNote_(eventAction, rawNote) {
  var note = trimStr_(rawNote);

  // D-075: one cap, one error code, every action. Deliberately ahead of the
  // branches — this used to live inside the confirmWeek branch, which left
  // pin/unpin/discard/undiscard/cancel/uncancel notes unbounded.
  if (note.length > MAX_NOTE_LEN) {
    return { error: {
      ok: false, code: "NOTE_TOO_LONG",
      message: "Note exceeds " + MAX_NOTE_LEN + " characters (" + note.length +
        "). Rejected, never truncated: a silently shortened note loses the very " +
        "content it was written to record (D-070, D-075)."
    } };
  }

  if (eventAction === "discard" && !note) {
    return { error: {
      ok: false, code: "MISSING_DISCARD_REASON",
      message: "discard requires a Note (the reason) — §11.4."
    } };
  }
  if (eventAction === "cancel" && !note) {
    return { error: {
      ok: false, code: "MISSING_CANCEL_REASON",
      message: "cancel requires a Note (the reason) — §11.4, D-068."
    } };
  }

  if (eventAction === "confirmWeek") {
    // The length cap that used to live here now runs for every action, above.
    // An ABSENT note is rejected rather than read as "[]". D-070 requires the
    // Note to BE the JSON array, and an empty denominator arrived at by
    // accident (the frontend forgot the payload) is indistinguishable from
    // one arrived at on purpose (a week where nothing was committed) — the
    // same silent-wrong-denominator failure the no-truncation rule exists to
    // prevent. An intentionally empty week sends "[]" explicitly.
    if (note === "") {
      return { error: {
        ok: false, code: "BAD_VALUE_CONFIRM_WEEK",
        message: "confirmWeek requires a Note carrying the JSON array of frozen task ids. " +
          'Send "[]" explicitly for a week with no commitments (D-070).'
      } };
    }

    var parsed;
    try {
      parsed = JSON.parse(note);
    } catch (parseErr) {
      return { error: {
        ok: false, code: "BAD_VALUE_CONFIRM_WEEK",
        message: "confirmWeek Note must be valid JSON (an array of task id strings): " +
          parseErr.message
      } };
    }
    var isArrayOfStrings = Object.prototype.toString.call(parsed) === "[object Array]" &&
      parsed.every(function (x) { return typeof x === "string"; });
    if (!isArrayOfStrings) {
      return { error: {
        ok: false, code: "BAD_VALUE_CONFIRM_WEEK",
        message: "confirmWeek Note must be a JSON array of strings (the frozen task ids)."
      } };
    }
  }

  return { note: note };
}

/** workDays: required, numeric, > 0, fractions allowed (createTask, D-066). */
function validateWorkDays_(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { error: {
      ok: false, code: "BAD_VALUE_WORKDAYS",
      message: "workDays is required and must be a number > 0."
    } };
  }
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) {
    return { error: {
      ok: false, code: "BAD_VALUE_WORKDAYS",
      message: "workDays must be a finite number > 0 (fractions allowed), got " +
        JSON.stringify(raw) + "."
    } };
  }
  return { value: n };
}

/**
 * Next T-NNNN id: the MAX of existing ad-hoc ids in Tasks column A, +1,
 * padded to 4 digits — the max, not the last row, so a deleted row or a
 * hand-reordered sheet can never reassign a live id (D-066).
 */
function nextTaskId_(tasksSheet) {
  var lastRow = tasksSheet.getLastRow();
  var max = 0;

  if (lastRow >= 2) {
    var ids = tasksSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var m = ADHOC_ID_RE.exec(trimStr_(ids[i][0]));
      if (m) {
        var n = parseInt(trimStr_(ids[i][0]).slice(2), 10);
        if (n > max) max = n;
      }
    }
  }

  var next = max + 1;
  var s = String(next);
  while (s.length < 4) s = "0" + s;
  return "T-" + s;
}

/* ------------------------------------------------------------------ *
 * People / actor
 * ------------------------------------------------------------------ */

/**
 * Reads the People tab live on every write — this, not the frontend dropdown,
 * is the real enforcement (§3).
 *
 * Active semantics: TRUE / "true" / "yes" / "y" / "1" / "si" / "sí" are active,
 * and so is a BLANK cell — a People tab where nobody filled Active in should not
 * lock the whole team out. An explicit falsey value deactivates.
 */
function checkActor_(peopleSheet, actor) {
  return checkPerson_(peopleSheet, actor, "ACTOR");
}

/**
 * D-066 reuses this same People lookup for createTask's `owner`, but the
 * frontend has to tell "you aren't a real person" apart from "you can't be
 * the owner of an ad-hoc task", so the two roles get DISTINCT error codes
 * (ACTOR_UNKNOWN/ACTOR_INACTIVE vs OWNER_UNKNOWN/OWNER_INACTIVE) rather than
 * one shared code with the role buried in the message.
 *
 * @param rolePrefix "ACTOR" or "OWNER"
 */
function checkPerson_(peopleSheet, who, rolePrefix) {
  var label = rolePrefix === "OWNER" ? "Owner" : "Actor";
  var lastRow = peopleSheet.getLastRow();

  if (lastRow < 2) {
    return { error: {
      ok: false, code: rolePrefix + "_UNKNOWN",
      message: "The People tab has no people in it; no " + label.toLowerCase() +
        " can be accepted."
    } };
  }

  var values = peopleSheet.getRange(2, 1, lastRow - 1, PEOPLE_HEADERS.length).getValues();
  var wanted = who.toLowerCase();
  var known = [];

  for (var i = 0; i < values.length; i++) {
    var name = trimStr_(values[i][0]);
    if (!name) continue;
    known.push(name);

    if (name.toLowerCase() !== wanted) continue;

    if (!isActive_(values[i][2])) {
      return { error: {
        ok: false, code: rolePrefix + "_INACTIVE",
        message: label + ' "' + name + '" is listed in People but marked inactive.'
      } };
    }
    return { name: name };
  }

  return { error: {
    ok: false, code: rolePrefix + "_UNKNOWN",
    message: label + ' "' + who + '" is not in the People tab. Known: [' +
      known.join(", ") + "]."
  } };
}

function isActive_(cell) {
  if (cell === true) return true;
  if (cell === false) return false;
  var s = trimStr_(cell).toLowerCase();
  if (s === "") return true; // blank = active, see checkActor_
  return s === "true" || s === "yes" || s === "y" || s === "1" || s === "si" || s === "sí";
}

/* ------------------------------------------------------------------ *
 * Header guard (§3)
 * ------------------------------------------------------------------ */

/**
 * Refuses the write if a tab's headers drifted. Compares positionally, trimmed
 * and case-insensitively: a rename, a reorder, an inserted column or a missing
 * column all fail; a capitalisation difference does not.
 */
function checkHeaders_(sheet, expected, tabName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    return { error: {
      ok: false, code: "HEADER_DRIFT",
      message: 'Tab "' + tabName + '" is empty; expected headers [' + expected.join(" | ") + "]."
    } };
  }

  var actual = sheet.getRange(1, 1, 1, Math.max(lastCol, expected.length)).getValues()[0];

  for (var i = 0; i < expected.length; i++) {
    var got = trimStr_(actual[i]);
    if (got.toLowerCase() !== expected[i].toLowerCase()) {
      return { error: {
        ok: false, code: "HEADER_DRIFT",
        message: 'Tab "' + tabName + '" header drift at column ' + (i + 1) +
          ': expected "' + expected[i] + '", found "' + got + '". ' +
          "Expected full header: [" + expected.join(" | ") + "]."
      } };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Identity + time
 * ------------------------------------------------------------------ */

/** D-034: E-<epochMillis>-<4 chars base36>. Never row position. */
function makeEventId_(epochMillis) {
  var rand = "";
  for (var i = 0; i < 4; i++) {
    rand += Math.floor(Math.random() * 36).toString(36);
  }
  return "E-" + epochMillis + "-" + rand;
}

/**
 * D-033: full ISO timestamp, generated server-side from the SPREADSHEET's own
 * timezone (the client clock is irrelevant). Emitted with a real offset, e.g.
 * 2026-08-13T14:30:00-05:00, so it is unambiguous — never a local wall-clock
 * time mislabelled as Z. Falls back to UTC if the pattern is unsupported.
 */
function formatTimestamp_(ss, date) {
  try {
    var tz = ss.getSpreadsheetTimeZone();
    return Utilities.formatDate(date, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  } catch (err) {
    return date.toISOString();
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function getSpreadsheet_() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function trimStr_(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function indexOf_(arr, v) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
  return -1;
}

/** Strict YYYY-MM-DD that must also be a real calendar date. Returns UTC ms or null. */
function parseIsoDateUtc_(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  var p = s.split("-");
  var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var ms = Date.UTC(y, m - 1, d);
  var probe = new Date(ms);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function dayName_(utcDay) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][utcDay];
}
