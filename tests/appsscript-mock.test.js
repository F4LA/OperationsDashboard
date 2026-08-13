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
  return {
    People: new FakeSheet("People", [
      peopleHeader,
      ["Bernardo", "bernardo@fit4lifeacademy.health", true],
      ["Brent", "brent@example.com", true],
      ["Ghost", "ghost@example.com", false],
      ["NoFlag", "noflag@example.com", ""]
    ]),
    Events: new FakeSheet("Events", [eventsHeader])
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

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
