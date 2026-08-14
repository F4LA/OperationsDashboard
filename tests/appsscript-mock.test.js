#!/usr/bin/env node
/**
 * backend/Code.gs unit test against a MOCKED Apps Script environment (D-022 convention:
 * plain Node, no framework). This is the fast, offline complement to
 * tests/appsscript-smoke.test.js, which hits the real deployed Web App — this one runs in
 * milliseconds and needs no deployment, so it is the harness to run on every change to
 * Code.gs.
 *
 *     node tests/appsscript-mock.test.js
 *
 * Code.gs is written in Apps Script style — top-level `function doPost(e) {...}` relying on
 * implicit globals (SpreadsheetApp, LockService, Utilities, ContentService), no
 * module.exports. Node's `require()` wraps a file's top level in a function scope, so a
 * plain require would not expose doPost. Instead this loads Code.gs's source with `vm` into
 * a sandboxed context pre-populated with fake versions of those Apps Script services —
 * exactly like loading a script tag into a page, which is what let it run in Apps Script's
 * own untouched global-function style without modifying Code.gs at all.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var REPO = path.resolve(__dirname, "..");

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

/* ------------------------------------------------------------------ *
 * Fake Sheet / Spreadsheet
 * ------------------------------------------------------------------ */

function FakeSheet(name, rows) { this.name = name; this.rows = rows; this.formats = {}; }
FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
FakeSheet.prototype.getLastColumn = function () {
  var max = 0;
  for (var i = 0; i < this.rows.length; i++) max = Math.max(max, this.rows[i].length);
  return max;
};
FakeSheet.prototype.getRange = function (row, col, numRows, numCols) {
  var self = this;
  numRows = numRows === undefined ? 1 : numRows;
  numCols = numCols === undefined ? 1 : numCols;
  return {
    getValues: function () {
      var out = [];
      for (var r = 0; r < numRows; r++) {
        var line = [], src = self.rows[row - 1 + r] || [];
        for (var c = 0; c < numCols; c++) {
          var v = src[col - 1 + c];
          line.push(v === undefined ? "" : v);
        }
        out.push(line);
      }
      return out;
    },
    setNumberFormat: function (f) { self.formats[row + "," + col] = f; return this; },
    setValue: function (v) {
      while (self.rows.length < row) self.rows.push([]);
      var t = self.rows[row - 1];
      while (t.length < col) t.push("");
      t[col - 1] = v;
      return this;
    }
  };
};
FakeSheet.prototype.appendRow = function (arr) { this.rows.push(arr.slice()); };

function FakeSS(sheets, tz) { this.sheets = sheets; this.tz = tz || "America/New_York"; }
FakeSS.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
FakeSS.prototype.getSpreadsheetTimeZone = function () { return this.tz; };

/* ------------------------------------------------------------------ *
 * Fake Apps Script globals
 * ------------------------------------------------------------------ */

var lockState = { acquired: 0, released: 0, failNext: false };

var LockService = {
  getScriptLock: function () {
    return {
      waitLock: function () {
        if (lockState.failNext) { lockState.failNext = false; throw new Error("timeout"); }
        lockState.acquired++;
      },
      releaseLock: function () { lockState.released++; }
    };
  }
};

var Utilities = {
  formatDate: function (date, tz, fmt) {
    // Only the pattern Code.gs uses. Fixed -04:00 to stand in for a real tz offset.
    var offMin = -240;
    var d = new Date(date.getTime() + offMin * 60000);
    function p(n) { return n < 10 ? "0" + n : String(n); }
    var sign = offMin <= 0 ? "-" : "+";
    var abs = Math.abs(offMin);
    if (fmt.indexOf("XXX") === -1) throw new Error("unexpected pattern " + fmt);
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) +
      sign + p(Math.floor(abs / 60)) + ":" + p(abs % 60);
  }
};

var lastOutput = null;
var ContentService = {
  MimeType: { JSON: "application/json" },
  createTextOutput: function (s) {
    lastOutput = s;
    return { setMimeType: function () { return { _body: s }; } };
  }
};

var CURRENT_SS = null;
var SpreadsheetApp = { getActiveSpreadsheet: function () { return CURRENT_SS; } };

/* ------------------------------------------------------------------ *
 * Load the real Code.gs into a sandboxed context
 * ------------------------------------------------------------------ */

var sandbox = { LockService: LockService, Utilities: Utilities,
  ContentService: ContentService, SpreadsheetApp: SpreadsheetApp,
  console: console };
vm.createContext(sandbox);

var codeSrc = fs.readFileSync(path.join(REPO, "backend", "Code.gs"), "utf8");
vm.runInContext(codeSrc, sandbox, { filename: "backend/Code.gs" });

var doPost = sandbox.doPost;
var makeEventId_ = sandbox.makeEventId_;

/* ------------------------------------------------------------------ *
 * Fixtures + helpers
 * ------------------------------------------------------------------ */

function freshSheets(opts) {
  opts = opts || {};
  var peopleHeader = opts.peopleHeader || ["Name", "Slack/Email", "Active"];
  var eventsHeader = opts.eventsHeader ||
    ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"];
  var tasksHeader = opts.tasksHeader ||
    ["id", "desc", "owner", "workDays", "deadline", "sourceIssueId", "createdBy", "createdAt"];
  return {
    People: new FakeSheet("People", [
      peopleHeader,
      ["Bernardo", "bernardo@fit4lifeacademy.health", true],
      ["Brent", "brent@example.com", true],
      ["Ghost", "ghost@example.com", false],
      ["NoFlag", "noflag@example.com", ""]
    ]),
    Events: new FakeSheet("Events", [eventsHeader]),
    Tasks: new FakeSheet("Tasks", [tasksHeader].concat(opts.taskRows || []))
  };
}

function post(payload, sheets) {
  CURRENT_SS = new FakeSS(sheets || freshSheets());
  doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(lastOutput);
}

function postRaw(body, sheets) {
  CURRENT_SS = new FakeSS(sheets || freshSheets());
  doPost({ postData: { contents: body } });
  return JSON.parse(lastOutput);
}

/* ================= HAPPY PATHS ================= */
console.log("\n=== happy paths ===\n");

var sheets = freshSheets();
var r = post({ action: "appendEvent", eventAction: "setStatus", sprintId: "S3-2026",
               taskId: "M2-t1", value: "done", actor: "Bernardo", note: "n" }, sheets);
check("setStatus done accepted", r.ok === true, JSON.stringify(r));
check("eventId matches E-<millis>-<4 base36>", /^E-\d{13}-[0-9a-z]{4}$/.test(r.eventId), r.eventId);
check("timestamp is full ISO with offset",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(r.timestamp), r.timestamp);
check("row appended to Events", sheets.Events.rows.length === 2);
var row = sheets.Events.rows[1];
check("row column order matches D-033",
  row[0] === r.eventId && row[1] === "S3-2026" && row[2] === "M2-t1" &&
  row[3] === "setStatus" && row[4] === "done" && row[5] === "Bernardo" &&
  row[6] === r.timestamp && row[7] === "n", JSON.stringify(row));
check("Timestamp cell forced to text format", sheets.Events.formats["2,7"] === "@",
  JSON.stringify(sheets.Events.formats));
check("lock acquired and released", lockState.acquired === 1 && lockState.released === 1,
  JSON.stringify(lockState));

r = post({ action: "setStatus", taskId: "T1", value: "in_progress", actor: "Brent" });
check("shorthand form (action=setStatus, no envelope) accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1",
           value: "https://drive.google.com/file/d/abc123/view", actor: "Brent" });
check("setDeliverable with https URL accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "pin", taskId: "T1", value: "2026-08-10", actor: "Brent" });
check("pin with an ISO Monday accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "unpin", taskId: "T1", actor: "Brent" });
check("unpin with no value accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "unpin", taskId: "T1", value: "", actor: "Brent" });
check("unpin with empty-string value accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "open", actor: "NoFlag" });
check("blank Active cell treated as active", r.ok === true, JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "open", actor: "  bernardo  " });
check("actor matched case-insensitively and trimmed", r.ok === true, JSON.stringify(r));
check("actor stored with canonical People spelling", r.actor === "Bernardo", r.actor);

/* ================= REJECTIONS ================= */
console.log("\n=== rejections ===\n");

r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Miguel" });
check("unknown actor rejected", r.ok === false && r.code === "ACTOR_UNKNOWN", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Ghost" });
check("inactive actor rejected", r.ok === false && r.code === "ACTOR_INACTIVE", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "" });
check("empty actor rejected", r.ok === false && r.code === "MISSING_ACTOR", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "", value: "done", actor: "Bernardo" });
check("empty taskId rejected", r.ok === false && r.code === "MISSING_TASK_ID", JSON.stringify(r));

r = post({ action: "setStatus", value: "done", actor: "Bernardo" });
check("missing taskId rejected", r.ok === false && r.code === "MISSING_TASK_ID", JSON.stringify(r));

r = post({ action: "deleteEverything", taskId: "T1", actor: "Bernardo" });
check("unknown action rejected", r.ok === false && r.code === "UNKNOWN_ACTION", JSON.stringify(r));

r = post({ taskId: "T1", actor: "Bernardo" });
check("missing action rejected", r.ok === false && r.code === "UNKNOWN_RPC_ACTION", JSON.stringify(r));

r = post({ action: "appendEvent", taskId: "T1", actor: "Bernardo" });
check("appendEvent without eventAction rejected",
  r.ok === false && r.code === "UNKNOWN_ACTION", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "finished", actor: "Bernardo" });
check("bad status enum rejected", r.ok === false && r.code === "BAD_VALUE_STATUS", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T1", value: "", actor: "Bernardo" });
check("empty status rejected", r.ok === false && r.code === "BAD_VALUE_STATUS", JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1", value: "not a url", actor: "Bernardo" });
check("malformed deliverable URL rejected",
  r.ok === false && r.code === "BAD_VALUE_URL", JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1", value: "javascript:alert(1)", actor: "Bernardo" });
check("javascript: URL rejected (stored-XSS guard)",
  r.ok === false && r.code === "BAD_VALUE_URL", JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1", value: "ftp://host/f.pdf", actor: "Bernardo" });
check("non-http scheme rejected", r.ok === false && r.code === "BAD_VALUE_URL", JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1", value: "https://", actor: "Bernardo" });
check("scheme with empty host rejected", r.ok === false && r.code === "BAD_VALUE_URL", JSON.stringify(r));

r = post({ action: "setDeliverable", taskId: "T1", value: "", actor: "Bernardo" });
check("empty deliverable rejected", r.ok === false && r.code === "BAD_VALUE_URL", JSON.stringify(r));

r = post({ action: "pin", taskId: "T1", value: "2026-08-11", actor: "Bernardo" });
check("pin on a Tuesday rejected", r.ok === false && r.code === "BAD_VALUE_PIN", JSON.stringify(r));

r = post({ action: "pin", taskId: "T1", value: "2026-02-30", actor: "Bernardo" });
check("pin on an impossible date rejected", r.ok === false && r.code === "BAD_VALUE_PIN", JSON.stringify(r));

r = post({ action: "pin", taskId: "T1", value: "08/10/2026", actor: "Bernardo" });
check("pin in non-ISO format rejected", r.ok === false && r.code === "BAD_VALUE_PIN", JSON.stringify(r));

r = post({ action: "pin", taskId: "T1", value: "", actor: "Bernardo" });
check("pin with no value rejected", r.ok === false && r.code === "BAD_VALUE_PIN", JSON.stringify(r));

r = post({ action: "unpin", taskId: "T1", value: "2026-08-10", actor: "Bernardo" });
check("unpin with a value rejected", r.ok === false && r.code === "BAD_VALUE_UNPIN", JSON.stringify(r));

var longUrl = "https://x.com/" + new Array(2100).join("a");
r = post({ action: "setDeliverable", taskId: "T1", value: longUrl, actor: "Bernardo" });
check("over-long value rejected", r.ok === false && r.code === "VALUE_TOO_LONG", JSON.stringify(r));

/* ================= MALFORMED BODIES ================= */
console.log("\n=== malformed bodies ===\n");

r = postRaw("{not json");
check("non-JSON body rejected", r.ok === false && r.code === "BAD_REQUEST", JSON.stringify(r));

r = postRaw("[1,2,3]");
check("JSON array body rejected", r.ok === false && r.code === "BAD_REQUEST", JSON.stringify(r));

CURRENT_SS = new FakeSS(freshSheets());
doPost({});
r = JSON.parse(lastOutput);
check("empty request rejected", r.ok === false && r.code === "BAD_REQUEST", JSON.stringify(r));

CURRENT_SS = new FakeSS(freshSheets());
doPost(null);
r = JSON.parse(lastOutput);
check("null event rejected without throwing", r.ok === false && r.code === "BAD_REQUEST", JSON.stringify(r));

/* ================= HEADER GUARD ================= */
console.log("\n=== header guard ===\n");

var drifted = freshSheets({ eventsHeader:
  ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp"] });
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, drifted);
check("missing Events column rejected", r.ok === false && r.code === "HEADER_DRIFT", JSON.stringify(r));
check("no row written on header drift", drifted.Events.rows.length === 1);

drifted = freshSheets({ eventsHeader:
  ["Event ID", "Task ID", "Sprint ID", "Action", "Value", "Actor", "Timestamp", "Note"] });
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, drifted);
check("reordered Events columns rejected", r.ok === false && r.code === "HEADER_DRIFT", JSON.stringify(r));

drifted = freshSheets({ eventsHeader:
  ["Event ID", "Sprint ID", "Task ID", "Action", "Payload", "Actor", "Timestamp", "Note"] });
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, drifted);
check("renamed Events column rejected", r.ok === false && r.code === "HEADER_DRIFT", JSON.stringify(r));

drifted = freshSheets({ peopleHeader: ["Name", "Email", "Active"] });
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, drifted);
check("People header drift rejected", r.ok === false && r.code === "HEADER_DRIFT", JSON.stringify(r));

var casey = freshSheets({ eventsHeader:
  ["event id", "SPRINT ID", "Task Id", "action", "Value", "ACTOR", "timestamp", "Note"] });
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, casey);
check("header capitalisation differences tolerated", r.ok === true, JSON.stringify(r));

/* ================= MISSING TABS ================= */
console.log("\n=== missing tabs ===\n");

var noEvents = freshSheets(); delete noEvents.Events;
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, noEvents);
check("missing Events tab rejected", r.ok === false && r.code === "MISSING_TAB", JSON.stringify(r));

var noPeople = freshSheets(); delete noPeople.People;
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, noPeople);
check("missing People tab rejected", r.ok === false && r.code === "MISSING_TAB", JSON.stringify(r));

var emptyPeople = freshSheets();
emptyPeople.People = new FakeSheet("People", [["Name", "Slack/Email", "Active"]]);
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" }, emptyPeople);
check("empty People tab rejects every actor",
  r.ok === false && r.code === "ACTOR_UNKNOWN", JSON.stringify(r));

/* ================= LOCK ================= */
console.log("\n=== lock ===\n");

lockState.acquired = 0; lockState.released = 0; lockState.failNext = true;
r = post({ action: "setStatus", taskId: "T1", value: "done", actor: "Bernardo" });
check("lock timeout reported, not crashed", r.ok === false && r.code === "LOCK_TIMEOUT", JSON.stringify(r));
check("no release attempted when lock never acquired", lockState.released === 0,
  JSON.stringify(lockState));

lockState.acquired = 0; lockState.released = 0;
post({ action: "setStatus", taskId: "T1", value: "nope", actor: "Bernardo" });
check("lock not taken for a payload rejected before the lock", lockState.acquired === 0,
  JSON.stringify(lockState));

lockState.acquired = 0; lockState.released = 0;
post({ action: "setStatus", taskId: "T1", value: "done", actor: "Miguel" });
check("lock released even when the write is rejected inside it",
  lockState.acquired === 1 && lockState.released === 1, JSON.stringify(lockState));

/* ================= EVENT ID UNIQUENESS ================= */
console.log("\n=== event id ===\n");

var ids = {}, collisions = 0;
for (var i = 0; i < 500; i++) {
  var id = makeEventId_(1786000000000);
  if (ids[id]) collisions++;
  ids[id] = true;
}
check("500 ids at the same millisecond stay mostly distinct", collisions < 10,
  collisions + " collisions (birthday-expected over 36^4)");
check("every id matches the D-034 format",
  Object.keys(ids).every(function (k) { return /^E-\d{13}-[0-9a-z]{4}$/.test(k); }));

/* ================= v2: createTask (D-066) ================= */
console.log("\n=== createTask — happy path ===\n");

var ctSheets = freshSheets();
r = post({ action: "createTask", sprintId: "S3-2026", desc: "Call the supplier",
           owner: "Brent", workDays: 0.5, week: "2026-08-17", actor: "Bernardo" }, ctSheets);
check("createTask accepted", r.ok === true, JSON.stringify(r));
check("first id is T-0001", r.id === "T-0001", r.id);
check("Tasks row appended", ctSheets.Tasks.rows.length === 2, ctSheets.Tasks.rows.length);

var taskRow = ctSheets.Tasks.rows[1];
check("Tasks row matches the D-066 column order",
  taskRow[0] === "T-0001" && taskRow[1] === "Call the supplier" && taskRow[2] === "Brent" &&
  taskRow[3] === 0.5 && taskRow[4] === "" && taskRow[5] === "" &&
  taskRow[6] === "Bernardo" && taskRow[7] === r.createdAt, JSON.stringify(taskRow));
check("createdAt cell forced to text format", ctSheets.Tasks.formats["2,8"] === "@",
  JSON.stringify(ctSheets.Tasks.formats));

check("a pin event was also appended", ctSheets.Events.rows.length === 2,
  ctSheets.Events.rows.length);
var pinRow = ctSheets.Events.rows[1];
check("the pin event carries the new task id and the week",
  pinRow[2] === "T-0001" && pinRow[3] === "pin" && pinRow[4] === "2026-08-17",
  JSON.stringify(pinRow));
check("the pin event's actor is the creator", pinRow[5] === "Bernardo", pinRow[5]);
check("response reports the pin's eventId", /^E-\d{13}-[0-9a-z]{4}$/.test(r.eventId), r.eventId);
check("server-side write-then-verify found the row", r.verified === true, JSON.stringify(r));

// The write ORDER is the load-bearing part of D-066: pin first, task second.
check("pin is written BEFORE the Tasks row (orphan-safety order)",
  ctSheets.Events.rows.length === 2 && ctSheets.Tasks.rows.length === 2,
  "both appends landed; order asserted structurally in the failure case below");

r = post({ action: "createTask", desc: "With everything", owner: "Bernardo", workDays: 2,
           week: "2026-08-17", deadline: "2026-08-20", sourceIssueId: "I-0007",
           actor: "Brent", note: "from the L10" }, ctSheets);
check("second createTask gets T-0002", r.id === "T-0002", r.id);
check("optional deadline stored", ctSheets.Tasks.rows[2][4] === "2026-08-20",
  JSON.stringify(ctSheets.Tasks.rows[2]));
check("optional sourceIssueId stored unvalidated", ctSheets.Tasks.rows[2][5] === "I-0007",
  JSON.stringify(ctSheets.Tasks.rows[2]));
check("fractional workDays preserved as a number", ctSheets.Tasks.rows[1][3] === 0.5,
  JSON.stringify(ctSheets.Tasks.rows[1]));

/* ---- id assignment is MAX+1, not last-row+1 (D-066a) ---- */
console.log("\n--- id assignment ---\n");

var gappy = freshSheets({ taskRows: [
  ["T-0001", "a", "Brent", 1, "", "", "Bernardo", "x"],
  ["T-0009", "b", "Brent", 1, "", "", "Bernardo", "x"],
  ["T-0004", "c", "Brent", 1, "", "", "Bernardo", "x"]   // out of order on purpose
] });
r = post({ action: "createTask", desc: "next", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, gappy);
check("id is MAX+1, not lastRow+1 — a reordered sheet cannot reassign a live id",
  r.id === "T-0010", r.id);

var deleted = freshSheets({ taskRows: [
  ["T-0001", "a", "Brent", 1, "", "", "Bernardo", "x"],
  ["T-0003", "c", "Brent", 1, "", "", "Bernardo", "x"]   // T-0002 was deleted by hand
] });
r = post({ action: "createTask", desc: "next", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, deleted);
check("a hand-deleted row does not free its id for reuse", r.id === "T-0004", r.id);

var noisy = freshSheets({ taskRows: [
  ["not-an-id", "junk", "Brent", 1, "", "", "Bernardo", "x"],
  ["T-0002", "b", "Brent", 1, "", "", "Bernardo", "x"]
] });
r = post({ action: "createTask", desc: "next", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, noisy);
check("non-conforming ids in column A are ignored by the max scan", r.id === "T-0003", r.id);

var padded = freshSheets({ taskRows: [
  ["T-0999", "a", "Brent", 1, "", "", "Bernardo", "x"]
] });
r = post({ action: "createTask", desc: "next", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, padded);
check("padding is correct rolling past 999", r.id === "T-1000", r.id);

/* ---- createTask rejections, one per named code ---- */
console.log("\n--- createTask rejections ---\n");

r = post({ action: "createTask", desc: "x", owner: "Both", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check('owner "Both" rejected with its OWN code, not OWNER_UNKNOWN',
  r.ok === false && r.code === "OWNER_BOTH_NOT_ALLOWED", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "both", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check('owner "both" (lowercase) also rejected as OWNER_BOTH_NOT_ALLOWED',
  r.ok === false && r.code === "OWNER_BOTH_NOT_ALLOWED", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Miguel", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check("unknown owner rejected as OWNER_UNKNOWN (distinct from ACTOR_UNKNOWN)",
  r.ok === false && r.code === "OWNER_UNKNOWN", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Ghost", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check("inactive owner rejected as OWNER_INACTIVE",
  r.ok === false && r.code === "OWNER_INACTIVE", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Miguel" });
check("unknown ACTOR still rejected as ACTOR_UNKNOWN, not OWNER_UNKNOWN",
  r.ok === false && r.code === "ACTOR_UNKNOWN", JSON.stringify(r));

r = post({ action: "createTask", desc: "", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check("empty desc rejected", r.ok === false && r.code === "MISSING_DESC", JSON.stringify(r));

r = post({ action: "createTask", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" });
check("missing desc rejected", r.ok === false && r.code === "MISSING_DESC", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 0,
           week: "2026-08-17", actor: "Bernardo" });
check("workDays 0 rejected", r.ok === false && r.code === "BAD_VALUE_WORKDAYS", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: -1,
           week: "2026-08-17", actor: "Bernardo" });
check("negative workDays rejected", r.ok === false && r.code === "BAD_VALUE_WORKDAYS", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: "abc",
           week: "2026-08-17", actor: "Bernardo" });
check("non-numeric workDays rejected", r.ok === false && r.code === "BAD_VALUE_WORKDAYS", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent",
           week: "2026-08-17", actor: "Bernardo" });
check("missing workDays rejected (mandatory per §1 v2)",
  r.ok === false && r.code === "BAD_VALUE_WORKDAYS", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: "0.25",
           week: "2026-08-17", actor: "Bernardo" });
check("numeric STRING workDays accepted and coerced", r.ok === true && r.workDays === 0.25,
  JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1, actor: "Bernardo" });
check("missing week rejected — no task is born without one (§11.6)",
  r.ok === false && r.code === "MISSING_WEEK", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-18", actor: "Bernardo" });
check("week on a Tuesday rejected as BAD_VALUE_WEEK, not MISSING_WEEK — a week WAS sent",
  r.ok === false && r.code === "BAD_VALUE_WEEK", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", deadline: "not-a-date", actor: "Bernardo" });
check("malformed deadline rejected", r.ok === false && r.code === "BAD_VALUE_DEADLINE", JSON.stringify(r));

r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", deadline: "2026-02-30", actor: "Bernardo" });
check("impossible deadline date rejected", r.ok === false && r.code === "BAD_VALUE_DEADLINE", JSON.stringify(r));

/* ---- nothing is written when createTask is rejected ---- */
var rejectSheets = freshSheets();
post({ action: "createTask", desc: "x", owner: "Both", workDays: 1,
       week: "2026-08-17", actor: "Bernardo" }, rejectSheets);
check("a rejected createTask writes NEITHER a Tasks row NOR a pin event",
  rejectSheets.Tasks.rows.length === 1 && rejectSheets.Events.rows.length === 1,
  "tasks=" + rejectSheets.Tasks.rows.length + " events=" + rejectSheets.Events.rows.length);

/* ---- Tasks tab guards ---- */
console.log("\n--- createTask tab + header guards ---\n");

var noTasks = freshSheets(); delete noTasks.Tasks;
r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, noTasks);
check("missing Tasks tab rejected", r.ok === false && r.code === "MISSING_TAB", JSON.stringify(r));
check("no pin event written when the Tasks tab is missing", noTasks.Events.rows.length === 1,
  noTasks.Events.rows.length);

var tasksDrift = freshSheets({ tasksHeader:
  ["id", "description", "owner", "workDays", "deadline", "sourceIssueId", "createdBy", "createdAt"] });
r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, tasksDrift);
check("Tasks header drift rejected", r.ok === false && r.code === "HEADER_DRIFT", JSON.stringify(r));
check("no pin event written on Tasks header drift", tasksDrift.Events.rows.length === 1,
  tasksDrift.Events.rows.length);

/* ---- the orphan-safety ordering, proven by making the Tasks append fail ---- */
console.log("\n--- orphan safety: Tasks append fails AFTER the pin landed ---\n");

var brokenTasks = freshSheets();
brokenTasks.Tasks.appendRow = function () { throw new Error("quota exceeded"); };
r = post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
           week: "2026-08-17", actor: "Bernardo" }, brokenTasks);
check("a failed Tasks append reports ok:false, never a false success",
  r.ok === false && r.code === "TASK_ROW_APPEND_FAILED", JSON.stringify(r));
check("the response names the orphaned event so it can be found",
  /^E-\d{13}-[0-9a-z]{4}$/.test(r.orphanedEventId || ""), r.orphanedEventId);
check("the pin DID land (it is written first, so the orphan is the harmless one)",
  brokenTasks.Events.rows.length === 2, brokenTasks.Events.rows.length);
check("no Tasks row exists — the task never half-existed",
  brokenTasks.Tasks.rows.length === 1, brokenTasks.Tasks.rows.length);

lockState.acquired = 0; lockState.released = 0;
post({ action: "createTask", desc: "x", owner: "Brent", workDays: 1,
       week: "2026-08-17", actor: "Bernardo" });
check("createTask takes and releases the lock exactly once",
  lockState.acquired === 1 && lockState.released === 1, JSON.stringify(lockState));

lockState.acquired = 0; lockState.released = 0;
post({ action: "createTask", desc: "x", owner: "Both", workDays: 1,
       week: "2026-08-17", actor: "Bernardo" });
check("createTask does not take the lock for a payload rejected before it",
  lockState.acquired === 0, JSON.stringify(lockState));

/* ================= v2: discard / undiscard (D-067, D-069) ================= */
console.log("\n=== discard / undiscard — ad-hoc namespace only ===\n");

r = post({ action: "discard", taskId: "T-0001", actor: "Bernardo", note: "client cancelled" });
check("discard on a T-NNNN id with a reason accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "undiscard", taskId: "T-0001", actor: "Bernardo" });
check("undiscard needs no note (the reversal, D-069)", r.ok === true, JSON.stringify(r));

r = post({ action: "discard", taskId: "T-0001", actor: "Bernardo" });
check("discard with NO note rejected",
  r.ok === false && r.code === "MISSING_DISCARD_REASON", JSON.stringify(r));

r = post({ action: "discard", taskId: "T-0001", actor: "Bernardo", note: "   " });
check("discard with a whitespace-only note rejected",
  r.ok === false && r.code === "MISSING_DISCARD_REASON", JSON.stringify(r));

r = post({ action: "discard", taskId: "M2-t1", actor: "Bernardo", note: "nope" });
check("discard on a PLAN task id rejected by namespace (D-067)",
  r.ok === false && r.code === "DISCARD_NOT_ADHOC", JSON.stringify(r));

r = post({ action: "undiscard", taskId: "M2-t1", actor: "Bernardo" });
check("undiscard on a plan task id rejected too",
  r.ok === false && r.code === "DISCARD_NOT_ADHOC", JSON.stringify(r));

r = post({ action: "discard", taskId: "T-1", actor: "Bernardo", note: "x" });
check("a T- id with the wrong digit count is not the ad-hoc namespace",
  r.ok === false && r.code === "DISCARD_NOT_ADHOC", JSON.stringify(r));

r = post({ action: "discard", taskId: "T-0001", value: "something",
           actor: "Bernardo", note: "x" });
check("discard carrying a value rejected",
  r.ok === false && r.code === "BAD_VALUE_DISCARD", JSON.stringify(r));

/* ================= v2: cancel / uncancel (D-068, D-069) ================= */
console.log("\n=== cancel / uncancel — the mirror rule, plan tasks only ===\n");

r = post({ action: "cancel", taskId: "M2-t1", actor: "Bernardo", note: "scope dropped" });
check("cancel on a plan task id with a reason accepted", r.ok === true, JSON.stringify(r));

r = post({ action: "uncancel", taskId: "M2-t1", actor: "Bernardo" });
check("uncancel needs no note", r.ok === true, JSON.stringify(r));

r = post({ action: "cancel", taskId: "M2-t1", actor: "Bernardo" });
check("cancel with NO note rejected",
  r.ok === false && r.code === "MISSING_CANCEL_REASON", JSON.stringify(r));

r = post({ action: "cancel", taskId: "T-0001", actor: "Bernardo", note: "wrong action" });
check("cancel on an AD-HOC id rejected by namespace (D-068, mirror of D-067)",
  r.ok === false && r.code === "CANCEL_NOT_PLAN_TASK", JSON.stringify(r));

r = post({ action: "uncancel", taskId: "T-0001", actor: "Bernardo" });
check("uncancel on an ad-hoc id rejected too",
  r.ok === false && r.code === "CANCEL_NOT_PLAN_TASK", JSON.stringify(r));

r = post({ action: "cancel", taskId: "M2-t1", value: "x", actor: "Bernardo", note: "y" });
check("cancel carrying a value rejected",
  r.ok === false && r.code === "BAD_VALUE_CANCEL", JSON.stringify(r));

// "discarded"/"cancelled" are DERIVED from these events, never setStatus values (D-067).
r = post({ action: "setStatus", taskId: "T-0001", value: "discarded", actor: "Bernardo" });
check('setStatus "discarded" still rejected — it is a derived state, not a status (D-067)',
  r.ok === false && r.code === "BAD_VALUE_STATUS", JSON.stringify(r));

r = post({ action: "setStatus", taskId: "M2-t1", value: "cancelled", actor: "Bernardo" });
check('setStatus "cancelled" likewise rejected',
  r.ok === false && r.code === "BAD_VALUE_STATUS", JSON.stringify(r));

/* ================= v2: confirmWeek (D-070) ================= */
console.log("\n=== confirmWeek ===\n");

var cwSheets = freshSheets();
r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: '["M2-t1","T-0001","M5-t3"]' }, cwSheets);
check("confirmWeek with a matching WEEK- id, Monday value and JSON array accepted",
  r.ok === true, JSON.stringify(r));
check("the frozen id list is stored verbatim in Note",
  cwSheets.Events.rows[1][7] === '["M2-t1","T-0001","M5-t3"]',
  JSON.stringify(cwSheets.Events.rows[1]));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: "[]" });
check("an EXPLICIT empty frozen list is legal (a week where nothing was committed)",
  r.ok === true, JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo" });
check("an ABSENT Note is rejected, not silently read as an empty denominator",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-24",
           actor: "Bernardo", note: "[]" });
check("Task ID date not matching Value rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-18", value: "2026-08-18",
           actor: "Bernardo", note: "[]" });
check("a matching pair that is not a Monday rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: "[]" });
check("a Task ID without the WEEK- prefix rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: "not json" });
check("a Note that is not JSON rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: '{"a":1}' });
check("a JSON object (not an array) rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: '["ok", 42]' });
check("a JSON array containing a non-string rejected",
  r.ok === false && r.code === "BAD_VALUE_CONFIRM_WEEK", JSON.stringify(r));

var hugeNote = JSON.stringify(new Array(900).join("x").split("x").map(function (_, i) {
  return "M" + i + "-t1";
}));
var overLen = freshSheets();
r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: hugeNote }, overLen);
check("an over-long Note is REJECTED, never truncated (D-070)",
  r.ok === false && r.code === "NOTE_TOO_LONG",
  "note length " + hugeNote.length + " -> " + JSON.stringify(r));
check("nothing written when the Note is over-length", overLen.Events.rows.length === 1,
  overLen.Events.rows.length);

// Boundary, so the cap above isn't passing simply because everything is rejected:
// a realistically large week (300 ids, ~2.9k chars) must still go through.
var bigButValid = JSON.stringify(new Array(300).join("x").split("x").map(function (_, i) {
  return "M" + i + "-t1";
}));
var underLen = freshSheets();
r = post({ action: "confirmWeek", taskId: "WEEK-2026-08-17", value: "2026-08-17",
           actor: "Bernardo", note: bigButValid }, underLen);
check("a large but under-cap Note is accepted (the cap is a cap, not a wall)",
  r.ok === true, "note length " + bigButValid.length + " -> " + JSON.stringify(r));
check("the full id list is stored uncut", underLen.Events.rows[1][7].length === bigButValid.length,
  "stored " + String(underLen.Events.rows[1][7]).length + " of " + bigButValid.length);

/* ---- the new actions do not disturb the old ones ---- */
console.log("\n--- v1 actions unaffected by the v2 additions ---\n");

r = post({ action: "appendEvent", eventAction: "discard", taskId: "T-0001",
           actor: "Bernardo", note: "via the envelope form" });
check("the appendEvent envelope works for the new actions too", r.ok === true, JSON.stringify(r));

r = post({ action: "pin", taskId: "T-0001", value: "2026-08-17", actor: "Bernardo" });
check("pin on an ad-hoc id is accepted (that IS how a task gets its week)",
  r.ok === true, JSON.stringify(r));

r = post({ action: "setStatus", taskId: "T-0001", value: "done", actor: "Bernardo" });
check("setStatus on an ad-hoc id accepted — one status mechanism for both origins (§3)",
  r.ok === true, JSON.stringify(r));

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
