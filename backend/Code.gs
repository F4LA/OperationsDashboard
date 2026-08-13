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
 * see §3 "Write path"). Two accepted forms, both unambiguous because
 * "appendEvent" and the four event actions are disjoint sets:
 *
 *   { "action": "appendEvent", "eventAction": "setStatus", ... }   // spec-literal
 *   { "action": "setStatus", ... }                                 // shorthand
 *
 * Fields:
 *   action       required  "appendEvent" (then eventAction is required), or one
 *                          of setStatus | setDeliverable | pin | unpin directly
 *   eventAction  required only when action === "appendEvent"
 *   taskId       required  non-empty; goes to the "Task ID" column
 *   actor        required  must match an active row in the People tab
 *   value        per-action, see validateValue_ below
 *   sprintId     optional  recorded as-is; not validated (the spec's rejection
 *                          list is explicit and does not include it)
 *   note         optional  free text
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

/** Column schemas fixed by D-033. Order matters — the header guard is positional. */
var PEOPLE_HEADERS = ["Name", "Slack/Email", "Active"];
var EVENTS_HEADERS = [
  "Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"
];

var EVENTS_COL_TIMESTAMP = 7; // 1-based index of "Timestamp" in EVENTS_HEADERS

var RPC_APPEND = "appendEvent";
var EVENT_ACTIONS = ["setStatus", "setDeliverable", "pin", "unpin"];
var STATUS_VALUES = ["open", "in_progress", "done"];

var LOCK_WAIT_MS = 30000;
var MAX_VALUE_LEN = 2000;

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

    /* ---- 2. which event action ---- */
    var resolved = resolveAction_(payload);
    if (resolved.error) return json_(resolved.error);
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

    /* ---- 5. value, per action ---- */
    var valueCheck = validateValue_(eventAction, payload.value);
    if (valueCheck.error) return json_(valueCheck.error);
    var value = valueCheck.value;

    var sprintId = trimStr_(payload.sprintId);
    var note = trimStr_(payload.note);

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
 * Action resolution
 * ------------------------------------------------------------------ */

/**
 * Accepts both the spec-literal envelope ({action:"appendEvent", eventAction:X})
 * and the shorthand ({action:X}). Unambiguous because "appendEvent" is not one
 * of the four event actions.
 */
function resolveAction_(payload) {
  var action = trimStr_(payload.action);

  if (!action) {
    return { error: {
      ok: false, code: "UNKNOWN_RPC_ACTION",
      message: 'action is required. Use "' + RPC_APPEND + '" with an eventAction, ' +
        "or one of [" + EVENT_ACTIONS.join(", ") + "] directly."
    } };
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

  return { eventAction: eventAction };
}

/* ------------------------------------------------------------------ *
 * Value validation, per action (§3)
 * ------------------------------------------------------------------ */

function validateValue_(eventAction, rawValue) {
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
    var ms = parseIsoDateUtc_(value);
    if (ms === null) {
      return { error: {
        ok: false, code: "BAD_VALUE_PIN",
        message: 'pin value must be an ISO date (YYYY-MM-DD), got "' + value + '".'
      } };
    }
    if (new Date(ms).getUTCDay() !== 1) {
      return { error: {
        ok: false, code: "BAD_VALUE_PIN",
        message: 'pin value must be a MONDAY (the ISO Monday of the target week), ' +
          'got "' + value + '" which is a ' + dayName_(new Date(ms).getUTCDay()) + "."
      } };
    }
    return { value: value };
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

  // resolveAction_ already gated the enum; this is belt-and-braces.
  return { error: {
    ok: false, code: "UNKNOWN_ACTION",
    message: 'Unknown action "' + eventAction + '".'
  } };
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
  var lastRow = peopleSheet.getLastRow();
  if (lastRow < 2) {
    return { error: {
      ok: false, code: "ACTOR_UNKNOWN",
      message: "The People tab has no people in it; no actor can be accepted."
    } };
  }

  var values = peopleSheet.getRange(2, 1, lastRow - 1, PEOPLE_HEADERS.length).getValues();
  var wanted = actor.toLowerCase();
  var known = [];

  for (var i = 0; i < values.length; i++) {
    var name = trimStr_(values[i][0]);
    if (!name) continue;
    known.push(name);

    if (name.toLowerCase() !== wanted) continue;

    if (!isActive_(values[i][2])) {
      return { error: {
        ok: false, code: "ACTOR_INACTIVE",
        message: 'Actor "' + name + '" is listed in People but marked inactive.'
      } };
    }
    return { name: name };
  }

  return { error: {
    ok: false, code: "ACTOR_UNKNOWN",
    message: 'Actor "' + actor + '" is not in the People tab. Known: [' +
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
