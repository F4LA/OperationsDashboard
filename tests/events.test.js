#!/usr/bin/env node
/**
 * dashboard/events.js fold — unit + integration test (D-022 convention: plain Node,
 * no framework). Proves the (Task ID, Action) fold (D-009) and, critically, that its
 * setStatus projection round-trips through OpsDashEngine.liveMode() to exactly the
 * frozen Phase 2 fixture (tests/expected-live-mode.json) — the shape D-027 fixed
 * before this module existed.
 *
 *     node tests/events.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

var OpsDashValidate = require(path.join(REPO, "dashboard", "validate.js")).OpsDashValidate;
globalThis.OpsDashValidate = OpsDashValidate;
var OpsDashEngine = require(path.join(REPO, "dashboard", "engine.js")).OpsDashEngine;
var OpsDashEvents = require(path.join(REPO, "dashboard", "events.js")).OpsDashEvents;

var E = OpsDashEvents;
var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

var HEADER = ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"];
function ev(id, task, action, value, actor, ts) {
  return [id, "S3-2026", task, action, value, actor, ts, ""];
}

/* ================= fold basics ================= */
console.log("\n=== fold: latest wins ===\n");

var values = [HEADER,
  ev("E-1", "M1-t1", "setStatus", "open", "Brent", "2026-08-01T09:00:00-04:00"),
  ev("E-2", "M1-t1", "setStatus", "in_progress", "Brent", "2026-08-03T10:00:00-04:00"),
  ev("E-3", "M1-t1", "setStatus", "done", "Brent", "2026-08-05T16:00:00-04:00")
];
var cs = E.toCurrentState(values);
check("latest setStatus wins", cs["M1-t1"].status === "done", JSON.stringify(cs));
check("statusChangedAt is the winning row's timestamp",
  cs["M1-t1"].statusChangedAt === "2026-08-05T16:00:00-04:00", cs["M1-t1"].statusChangedAt);

// out-of-order rows must not change the outcome
values = [HEADER,
  ev("E-3", "M1-t1", "setStatus", "done", "Brent", "2026-08-05T16:00:00-04:00"),
  ev("E-1", "M1-t1", "setStatus", "open", "Brent", "2026-08-01T09:00:00-04:00"),
  ev("E-2", "M1-t1", "setStatus", "in_progress", "Brent", "2026-08-03T10:00:00-04:00")
];
cs = E.toCurrentState(values);
check("rows out of order still fold to the newest", cs["M1-t1"].status === "done", JSON.stringify(cs));

// identical timestamps -> later sheet row wins
values = [HEADER,
  ev("E-1", "T", "setStatus", "open", "Brent", "2026-08-05T10:00:00-04:00"),
  ev("E-2", "T", "setStatus", "done", "Brent", "2026-08-05T10:00:00-04:00")
];
cs = E.toCurrentState(values);
check("timestamp tie broken by later row", cs["T"].status === "done", JSON.stringify(cs));

/* ================= D-027 shape ================= */
console.log("\n=== D-027 shape ===\n");

values = [HEADER,
  ev("E-1", "A", "setStatus", "done", "Brent", "2026-08-05T10:00:00-04:00"),
  ev("E-2", "B", "setDeliverable", "https://x.com/a", "Brent", "2026-08-05T10:00:00-04:00")
];
cs = E.toCurrentState(values);
check("entry has exactly {status, statusChangedAt}",
  JSON.stringify(Object.keys(cs["A"]).sort()) === '["status","statusChangedAt"]',
  JSON.stringify(Object.keys(cs["A"])));
check("task with only a deliverable is absent from currentState",
  cs["B"] === undefined, JSON.stringify(cs));

var empty = E.toCurrentState([HEADER]);
check("log with no data rows yields an empty currentState",
  JSON.stringify(empty) === "{}", JSON.stringify(empty));

/* ================= deliverables & pins ================= */
console.log("\n=== deliverables & pins ===\n");

values = [HEADER,
  ev("E-1", "A", "setDeliverable", "https://old.com/x", "Brent", "2026-08-01T10:00:00-04:00"),
  ev("E-2", "A", "setDeliverable", "https://new.com/y", "Brent", "2026-08-04T10:00:00-04:00")
];
check("latest deliverable wins", E.deliverables(values)["A"] === "https://new.com/y",
  JSON.stringify(E.deliverables(values)));

values = [HEADER,
  ev("E-1", "A", "pin", "2026-08-10", "Brent", "2026-08-05T10:00:00-04:00"),
  ev("E-2", "A", "unpin", "", "Brent", "2026-08-06T10:00:00-04:00")
];
check("unpin after pin clears the pin", E.pins(values)["A"] === undefined,
  JSON.stringify(E.pins(values)));

values = [HEADER,
  ev("E-1", "A", "unpin", "", "Brent", "2026-08-05T10:00:00-04:00"),
  ev("E-2", "A", "pin", "2026-08-10", "Brent", "2026-08-06T10:00:00-04:00")
];
check("pin after unpin restores the pin", E.pins(values)["A"] === "2026-08-10",
  JSON.stringify(E.pins(values)));

/* ================= robustness ================= */
console.log("\n=== robustness ===\n");

values = [HEADER, ev("E-1", "A", "setStatus", "done", "Brent", "not-a-timestamp")];
var folded = E.fold(values);
cs = E.toCurrentState(folded);
check("unreadable timestamp -> statusChangedAt null", cs["A"].statusChangedAt === null,
  JSON.stringify(cs));
check("unreadable timestamp warns", folded.warnings.some(function (w) {
  return w.code === "ROW_BAD_TIMESTAMP";
}), JSON.stringify(folded.warnings));

// this is exactly the D-032 path in liveMode
values = [HEADER, ev("E-1", "A", "setStatus", "bogus", "Brent", "2026-08-05T10:00:00-04:00")];
folded = E.fold(values);
cs = E.toCurrentState(folded);
check("out-of-enum status passed through", cs["A"].status === "bogus", JSON.stringify(cs));
check("out-of-enum status warns", folded.warnings.some(function (w) {
  return w.code === "UNKNOWN_STATUS";
}), JSON.stringify(folded.warnings));

values = [HEADER,
  ["E-1", "S", "", "setStatus", "done", "Brent", "2026-08-05T10:00:00-04:00", ""],
  ["E-2", "S", "A", "", "done", "Brent", "2026-08-05T10:00:00-04:00", ""],
  ["", "", "", "", "", "", "", ""],
  ev("E-3", "A", "setStatus", "done", "Brent", "2026-08-05T10:00:00-04:00")
];
folded = E.fold(values);
check("row without Task ID skipped + warned",
  folded.warnings.some(function (w) { return w.code === "ROW_NO_TASK_ID"; }));
check("row without Action skipped + warned",
  folded.warnings.some(function (w) { return w.code === "ROW_NO_ACTION"; }));
check("blank spacer row ignored silently", folded.events.length === 3, folded.events.length);

// Sheets trims trailing empties on a read
values = [HEADER, ["E-1", "S3", "A", "setStatus", "done", "Brent", "2026-08-05T10:00:00-04:00"]];
cs = E.toCurrentState(values);
check("row with trailing Note cell trimmed off still folds", cs["A"].status === "done",
  JSON.stringify(cs));

// columns mapped by name, not position
var shuffled = [
  ["Task ID", "Action", "Value", "Timestamp", "Event ID", "Sprint ID", "Actor", "Note"],
  ["A", "setStatus", "done", "2026-08-05T10:00:00-04:00", "E-1", "S3", "Brent", ""]
];
cs = E.toCurrentState(shuffled);
check("columns resolved by header name, not position", cs["A"] && cs["A"].status === "done",
  JSON.stringify(cs));

// a real Date object in the cell (Sheets coerced it) must still work
values = [HEADER,
  ["E-1", "S3", "A", "setStatus", "done", "Brent", new Date(Date.UTC(2026, 7, 5, 14, 0, 0)), ""]];
cs = E.toCurrentState(values);
check("Date-typed timestamp cell normalised to ISO",
  /^2026-08-05T/.test(cs["A"].statusChangedAt), cs["A"].statusChangedAt);

check("accepts a Sheets API {values:[...]} envelope",
  E.toCurrentState({
    values: [HEADER, ev("E-1", "A", "setStatus", "done", "B", "2026-08-05T10:00:00-04:00")]
  })["A"] !== undefined);

/* ================= ROUND TRIP: Events -> fold -> liveMode ================= */
console.log("\n=== round trip into liveMode (Phase 2 fixture) ===\n");

var plan = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "scenario-live-mode.json"), "utf8"));
var expected = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "expected-live-mode.json"), "utf8"));

// An Events log that should fold to exactly the Phase-2 currentState fixture,
// including superseded rows and deliberately shuffled order.
var log = [HEADER,
  ev("E-a", "T1", "setStatus", "in_progress", "Brent", "2026-08-03T08:00:00Z"),
  ev("E-b", "T2", "setStatus", "in_progress", "Bernardo", "2026-08-05T09:00:00Z"),
  ev("E-c", "T1", "setStatus", "done", "Brent", "2026-08-03T22:10:00Z"),
  ev("E-d", "T4", "setStatus", "open", "Brent", "2026-08-09T08:00:00Z"),
  ev("E-e", "T4", "setStatus", "done", "Brent", "2026-08-10T18:45:00Z"),
  ev("E-f", "T1", "setDeliverable", "https://drive.google.com/file/d/x", "Brent", "2026-08-04T08:00:00Z")
];

var currentState = E.toCurrentState(log);
var reference = JSON.parse(
  fs.readFileSync(path.join(REPO, "tests", "current-state-live-mode.json"), "utf8"));

check("folded currentState equals the Phase-2 fixture",
  JSON.stringify(currentState, Object.keys(currentState).sort()) ===
  JSON.stringify(reference, Object.keys(reference).sort()),
  "folded=" + JSON.stringify(currentState) + "  fixture=" + JSON.stringify(reference));

var result = OpsDashEngine.liveMode(plan, currentState, expected.today);
check("liveMode ok on the folded state", result.ok === true, JSON.stringify(result.errors));

var mismatches = [];
Object.keys(expected.tasks).forEach(function (id) {
  var w = expected.tasks[id], g = result.tasks[id];
  ["status", "plannedStart", "plannedFinish", "clamped"].forEach(function (f) {
    if (g[f] !== w[f]) mismatches.push(id + "." + f + ": want " + w[f] + " got " + g[f]);
  });
});
Object.keys(expected.milestones).forEach(function (id) {
  var w = expected.milestones[id], g = result.milestones[id];
  if (g.plannedFinish !== w.plannedFinish || g.red !== w.red) mismatches.push("milestone " + id);
});
Object.keys(expected.rocks).forEach(function (id) {
  var w = expected.rocks[id], g = result.rocks[id];
  if (g.plannedFinish !== w.plannedFinish || g.red !== w.red) mismatches.push("rock " + id);
});
check("liveMode from the folded log matches expected-live-mode.json exactly",
  mismatches.length === 0, mismatches.join(" · "));

check("deliverable survived the same fold",
  E.deliverables(log)["T1"] === "https://drive.google.com/file/d/x");

/* ================= v2 projections (D-067, D-068, D-069, D-070) ================= */

function evn(id, task, action, value, actor, ts, note) {
  return [id, "S3-2026", task, action, value, actor, ts, note === undefined ? "" : note];
}

console.log("\n=== discards / cancels: the positive-negative pair (D-069) ===\n");

var dLog = [HEADER,
  evn("E-D1", "T-0001", "discard", "", "Bernardo", "2026-08-10T09:00:00-04:00", "client cancelled"),
  evn("E-D2", "T-0002", "discard", "", "Brent", "2026-08-10T10:00:00-04:00", "duplicate"),
  evn("E-D3", "T-0002", "undiscard", "", "Brent", "2026-08-11T10:00:00-04:00", ""),
  evn("E-C1", "M2-t1", "cancel", "", "Bernardo", "2026-08-10T09:00:00-04:00", "scope dropped"),
  evn("E-C2", "M2-t2", "cancel", "", "Bernardo", "2026-08-10T09:00:00-04:00", "oops"),
  evn("E-C3", "M2-t2", "uncancel", "", "Bernardo", "2026-08-12T09:00:00-04:00", "")
];

var d = E.discards(dLog);
check("a discarded task appears in discards()", !!d["T-0001"], JSON.stringify(d));
check("discards() carries the reason, actor and timestamp",
  d["T-0001"].note === "client cancelled" && d["T-0001"].actor === "Bernardo" &&
  /^2026-08-10T09:00:00/.test(d["T-0001"].timestamp), JSON.stringify(d["T-0001"]));
check("a later undiscard REMOVES the key rather than recording a false entry",
  !("T-0002" in d), JSON.stringify(d));

var c = E.cancels(dLog);
check("a cancelled task appears in cancels()", !!c["M2-t1"], JSON.stringify(c));
check("cancels() carries its own reason", c["M2-t1"].note === "scope dropped", JSON.stringify(c));
check("a later uncancel removes the key", !("M2-t2" in c), JSON.stringify(c));
check("discards and cancels are separate maps — a discard is not a cancel",
  !("T-0001" in c) && !("M2-t1" in d), JSON.stringify({ d: Object.keys(d), c: Object.keys(c) }));

/* An undiscard BEFORE the discard must not win — order is by timestamp, not by
   which action happens to be scanned first. */
var reLog = [HEADER,
  evn("E-R1", "T-0003", "undiscard", "", "Brent", "2026-08-09T09:00:00-04:00", ""),
  evn("E-R2", "T-0003", "discard", "", "Brent", "2026-08-10T09:00:00-04:00", "re-discarded")
];
check("a re-discard after an undiscard wins (latest timestamp, not action order)",
  !!E.discards(reLog)["T-0003"], JSON.stringify(E.discards(reLog)));

/* Same timestamp on both members: the later ROW wins, matching fold()'s own rule. */
var tieLog = [HEADER,
  evn("E-T1", "T-0004", "discard", "", "Brent", "2026-08-10T09:00:00-04:00", "r"),
  evn("E-T2", "T-0004", "undiscard", "", "Brent", "2026-08-10T09:00:00-04:00", "")
];
check("on an identical timestamp the later row wins (rowIndex tie-break)",
  !("T-0004" in E.discards(tieLog)), JSON.stringify(E.discards(tieLog)));

var tieLogRev = [HEADER,
  evn("E-T3", "T-0005", "undiscard", "", "Brent", "2026-08-10T09:00:00-04:00", ""),
  evn("E-T4", "T-0005", "discard", "", "Brent", "2026-08-10T09:00:00-04:00", "r")
];
check("...and the tie-break is genuinely by row, not a fixed preference",
  !!E.discards(tieLogRev)["T-0005"], JSON.stringify(E.discards(tieLogRev)));

check("a task with no discard/cancel event is simply absent from both maps",
  !("M9-t9" in E.discards(dLog)) && !("M9-t9" in E.cancels(dLog)));

/* D-067: discarded/cancelled are DERIVED, never setStatus values. The fold must
   not have grown them as statuses. */
var cs = E.toCurrentState(dLog);
check("discard does NOT appear as a status in currentState (D-067: one way to discard)",
  !cs["T-0001"] || cs["T-0001"].status !== "discarded", JSON.stringify(cs["T-0001"]));
check("currentState entries still carry exactly the two D-027 keys",
  Object.keys(E.toCurrentState([HEADER,
    evn("E-S1", "X1", "setStatus", "done", "Brent", "2026-08-10T09:00:00-04:00")
  ])["X1"]).sort().join(",") === "status,statusChangedAt");

console.log("\n=== weekCommitment: the frozen denominator (D-070) ===\n");

var wLog = [HEADER,
  evn("E-W1", "WEEK-2026-08-17", "confirmWeek", "2026-08-17", "Bernardo",
    "2026-08-14T17:00:00-04:00", '["M2-t1","T-0001"]'),
  evn("E-W2", "WEEK-2026-08-24", "confirmWeek", "2026-08-24", "Bernardo",
    "2026-08-21T17:00:00-04:00", "[]")
];

check("a confirmed week returns its frozen id array",
  JSON.stringify(E.weekCommitment(wLog, "2026-08-17")) === '["M2-t1","T-0001"]',
  JSON.stringify(E.weekCommitment(wLog, "2026-08-17")));

/* The distinction D-072(a) made the server enforce has to survive the fold. */
var emptyWeek = E.weekCommitment(wLog, "2026-08-24");
check("a week confirmed EMPTY returns [] — a real denominator of zero",
  isArrayOf(emptyWeek) && emptyWeek.length === 0, JSON.stringify(emptyWeek));
check("an UNCONFIRMED week returns null, which is not the same value as []",
  E.weekCommitment(wLog, "2026-09-07") === null, JSON.stringify(E.weekCommitment(wLog, "2026-09-07")));
check("null and [] are distinguishable by the caller (the whole point of D-070)",
  E.weekCommitment(wLog, "2026-09-07") !== emptyWeek &&
  JSON.stringify(emptyWeek) !== JSON.stringify(null));

function isArrayOf(v) { return Object.prototype.toString.call(v) === "[object Array]"; }

/* Re-confirming replaces, with no new fold machinery: the generic fold already
   keeps the latest per (Task ID, Action). */
var reconfirm = [HEADER,
  evn("E-W3", "WEEK-2026-08-17", "confirmWeek", "2026-08-17", "Bernardo",
    "2026-08-14T17:00:00-04:00", '["A","B","C"]'),
  evn("E-W4", "WEEK-2026-08-17", "confirmWeek", "2026-08-17", "Bernardo",
    "2026-08-14T18:30:00-04:00", '["A","B"]')
];
check("re-confirming a week REPLACES its denominator (latest wins)",
  JSON.stringify(E.weekCommitment(reconfirm, "2026-08-17")) === '["A","B"]',
  JSON.stringify(E.weekCommitment(reconfirm, "2026-08-17")));

/* Corrupt Note: only reachable by hand-editing the Sheet, since the server
   rejects it. Must warn and report UNCONFIRMED, never throw, never silently
   manufacture a zero denominator. */
var warned = [];
var realWarn = console.warn;
console.warn = function () { warned.push(Array.prototype.join.call(arguments, " ")); };

var badLog = [HEADER,
  evn("E-W5", "WEEK-2026-09-14", "confirmWeek", "2026-09-14", "Bernardo",
    "2026-09-11T17:00:00-04:00", "M2-t1, M2-t2")
];
var badResult = E.weekCommitment(badLog, "2026-09-14");
check("an unparseable Note yields null (UNCONFIRMED), not []", badResult === null,
  JSON.stringify(badResult));
check("...and says so on console.warn, naming the WEEK key",
  warned.length === 1 && warned[0].indexOf("WEEK-2026-09-14") !== -1, JSON.stringify(warned));

warned = [];
var objLog = [HEADER,
  evn("E-W6", "WEEK-2026-09-21", "confirmWeek", "2026-09-21", "Bernardo",
    "2026-09-18T17:00:00-04:00", '{"ids":["A"]}')
];
check("a JSON object rather than an array is also UNCONFIRMED",
  E.weekCommitment(objLog, "2026-09-21") === null);
check("...and warns too", warned.length === 1, JSON.stringify(warned));

warned = [];
var mixedLog = [HEADER,
  evn("E-W7", "WEEK-2026-09-28", "confirmWeek", "2026-09-28", "Bernardo",
    "2026-09-25T17:00:00-04:00", '["A",42]')
];
check("an array holding a non-string is UNCONFIRMED", E.weekCommitment(mixedLog, "2026-09-28") === null);
check("...and warns", warned.length === 1, JSON.stringify(warned));

console.warn = realWarn;

check("weekCommitment never throws on a corrupt Note", true);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
