#!/usr/bin/env node
/**
 * Date engine regression test — LIVE MODE (spec §4.7, D-027–D-031).
 *
 * Loads a synthetic scenario (NOT the real sprint-plan.json — this scenario exists only
 * to exercise done/in_progress/open together, an overdue in_progress clamp, a wait on a
 * done task, and a cross-milestone join), runs OpsDashEngine.liveMode(), and compares
 * every task's status/plannedStart/plannedFinish/clamped plus milestone/rock roll-up
 * against the frozen fixture tests/expected-live-mode.json.
 *
 * Plain Node, no framework, no install step:
 *     node tests/live-engine.test.js
 *
 * The fixture is the arbiter (same rule as D-022 for plan mode) — if the engine and the
 * fixture disagree, that's reported to the design chat, never resolved by quietly
 * editing one of them.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

var OpsDashValidate = require(path.join(REPO, "dashboard", "validate.js")).OpsDashValidate;
globalThis.OpsDashValidate = OpsDashValidate;
var OpsDashEngine = require(path.join(REPO, "dashboard", "engine.js")).OpsDashEngine;

var plan = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario-live-mode.json"), "utf8"));
var currentState = JSON.parse(fs.readFileSync(path.join(__dirname, "current-state-live-mode.json"), "utf8"));
var expected = JSON.parse(fs.readFileSync(path.join(__dirname, "expected-live-mode.json"), "utf8"));

var failures = 0;
var passes = 0;

function fail(msg) {
  failures++;
  console.log("  FAIL  " + msg);
}

function pass(msg) {
  passes++;
  console.log("  PASS  " + msg);
}

function check(name, cond, detail) {
  if (cond) pass(name);
  else fail(name + (detail ? "  → " + detail : ""));
}

function pad(s) {
  var out = String(s);
  while (out.length < 6) out += " ";
  return out;
}

/* ------------------------------------------------------------------ */
console.log("\n=== scenario-live-mode.json validation (§7) ===\n");

var report = OpsDashValidate.validate(plan);
console.log(OpsDashValidate.formatReport(report) + "\n");
check("scenario validates with zero errors", report.ok, JSON.stringify(report.errors));

/* ------------------------------------------------------------------ */
console.log("=== engine: live mode, today=" + expected.today + " ===\n");

var result = OpsDashEngine.liveMode(plan, currentState, expected.today);

check("engine reports ok", result.ok, JSON.stringify(result.errors));
check("mode is \"live\"", result.mode === "live", "got " + result.mode);
check("today echoed back", result.today === expected.today, "got " + result.today);

/* ------------------------------------------------------------------ */
console.log("\n=== fixedTaskIds / order ===\n");

check("fixedTaskIds = " + JSON.stringify(expected.fixedTaskIds),
  JSON.stringify(result.fixedTaskIds) === JSON.stringify(expected.fixedTaskIds),
  "got " + JSON.stringify(result.fixedTaskIds));

check("order = " + JSON.stringify(expected.order),
  JSON.stringify(result.order) === JSON.stringify(expected.order),
  "got " + JSON.stringify(result.order));

/* ------------------------------------------------------------------ */
console.log("\n=== per-task comparison vs. expected-live-mode.json ===\n");

var expectedIds = Object.keys(expected.tasks).sort();
var actualIds = Object.keys(result.tasks).sort();

check("engine produced exactly the fixture's task set",
  expectedIds.join(",") === actualIds.join(","),
  "only in engine: [" + actualIds.filter(function (id) { return !expected.tasks[id]; }).join(", ") +
  "] · only in fixture: [" + expectedIds.filter(function (id) { return !result.tasks[id]; }).join(", ") + "]");

var fields = ["status", "plannedStart", "plannedFinish", "clamped"];
var mismatches = [];

expectedIds.forEach(function (id) {
  var want = expected.tasks[id];
  var got = result.tasks[id];

  if (!got) {
    fail(id + "  not present in engine output");
    mismatches.push({ id: id, field: "(missing)", want: JSON.stringify(want), got: "not scheduled" });
    return;
  }

  var lineOk = true;
  fields.forEach(function (f) {
    if (got[f] !== want[f]) {
      lineOk = false;
      mismatches.push({ id: id, field: f, want: JSON.stringify(want[f]), got: JSON.stringify(got[f]) });
    }
  });

  if (lineOk) {
    pass(pad(id) + "  status=" + got.status +
      "  start=" + got.plannedStart + "  finish=" + got.plannedFinish +
      "  clamped=" + got.clamped);
  } else {
    fail(pad(id) +
      "  expected " + JSON.stringify(want) +
      "   got status=" + got.status + " start=" + got.plannedStart +
      " finish=" + got.plannedFinish + " clamped=" + got.clamped);
  }
});

/* ------------------------------------------------------------------ */
console.log("\n=== milestone roll-up (§4.6) ===\n");

Object.keys(expected.milestones).forEach(function (mid) {
  var want = expected.milestones[mid];
  var got = result.milestones[mid];

  if (!got) {
    fail(mid + "  not present in engine output");
    mismatches.push({ id: mid, field: "(missing milestone)", want: JSON.stringify(want), got: "absent" });
    return;
  }

  var finishOk = got.plannedFinish === want.plannedFinish;
  var redOk = got.red === want.red;

  if (finishOk && redOk) {
    pass(pad(mid) + "  plannedFinish=" + got.plannedFinish + "  red=" + got.red);
  } else {
    fail(pad(mid) + "  expected finish=" + want.plannedFinish + " red=" + want.red +
      "   got finish=" + got.plannedFinish + " red=" + got.red);
    if (!finishOk) mismatches.push({ id: mid, field: "milestone.plannedFinish", want: want.plannedFinish, got: got.plannedFinish });
    if (!redOk) mismatches.push({ id: mid, field: "milestone.red", want: want.red, got: got.red });
  }
});

/* ------------------------------------------------------------------ */
console.log("\n=== rock roll-up (§4.6) ===\n");

Object.keys(expected.rocks).forEach(function (rid) {
  var want = expected.rocks[rid];
  var got = result.rocks[rid];

  if (!got) {
    fail(rid + "  not present in engine output");
    mismatches.push({ id: rid, field: "(missing rock)", want: JSON.stringify(want), got: "absent" });
    return;
  }

  var finishOk = got.plannedFinish === want.plannedFinish;
  var redOk = got.red === want.red;

  if (finishOk && redOk) {
    pass(pad(rid) + "  plannedFinish=" + got.plannedFinish + "  red=" + got.red);
  } else {
    fail(pad(rid) + "  expected finish=" + want.plannedFinish + " red=" + want.red +
      "   got finish=" + got.plannedFinish + " red=" + got.red);
    if (!finishOk) mismatches.push({ id: rid, field: "rock.plannedFinish", want: want.plannedFinish, got: got.plannedFinish });
    if (!redOk) mismatches.push({ id: rid, field: "rock.red", want: want.red, got: got.red });
  }
});

/* ------------------------------------------------------------------ */
console.log("\n=== summary ===\n");
console.log("  passed:   " + passes);
console.log("  failed:   " + failures);

if (mismatches.length) {
  console.log("\n  mismatches (engine vs. fixture):");
  mismatches.forEach(function (m) {
    console.log("    " + m.id + "." + m.field + ": expected " + m.want + ", got " + m.got);
  });
  console.log("\n  Per D-022's rule (applied here too): do NOT edit the fixture or force the");
  console.log("  engine to match. Report these to the design chat for a ruling.");
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
