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

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
