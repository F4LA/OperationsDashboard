#!/usr/bin/env node
/**
 * Date engine regression test — PLAN MODE (spec §4, D-020/D-021/D-022).
 *
 * Loads sprint-plan.json, runs the engine in plan mode, and compares every task's
 * plannedStart/plannedFinish against the frozen fixture tests/expected-plan-mode.json.
 *
 * Plain Node, no framework, no install step:
 *     node tests/engine.test.js
 *
 * Exits non-zero if anything fails. The fixture is the arbiter of date semantics —
 * if the engine and the fixture disagree, that is resolved in the design chat, never
 * by quietly editing one of them (D-022).
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

// validate.js and engine.js attach to `window` in the browser and to module.exports
// under Node. The engine resolves OpsDashValidate off the global, so publish it there.
var OpsDashValidate = require(path.join(REPO, "dashboard", "validate.js")).OpsDashValidate;
globalThis.OpsDashValidate = OpsDashValidate;
var OpsDashEngine = require(path.join(REPO, "dashboard", "engine.js")).OpsDashEngine;

var plan = JSON.parse(fs.readFileSync(path.join(REPO, "sprint-plan.json"), "utf8"));
var expected = JSON.parse(fs.readFileSync(path.join(__dirname, "expected-plan-mode.json"), "utf8"));

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

/* ------------------------------------------------------------------ */
console.log("\n=== sprint-plan.json validation (§7) ===\n");

var report = OpsDashValidate.validate(plan);
console.log(OpsDashValidate.formatReport(report) + "\n");
check("plan validates with zero errors", report.ok, JSON.stringify(report.errors));

/* ------------------------------------------------------------------ */
console.log("\n=== engine: plan mode ===\n");

var result = OpsDashEngine.planMode(plan);

check("engine reports ok", result.ok, JSON.stringify(result.errors));
check("46 tasks scheduled", result.stats.scheduled === 46, "got " + result.stats.scheduled);
check("1 task deferred and excluded", result.stats.deferred === 1, "got " + result.stats.deferred);
check("M13-t1 is the excluded one",
  result.deferredTasks.length === 1 && result.deferredTasks[0] === "M13-t1",
  JSON.stringify(result.deferredTasks));
check("M13-t1 has no computed dates", !result.tasks["M13-t1"]);

/* ------------------------------------------------------------------ */
console.log("\n=== per-task comparison vs. expected-plan-mode.json ===\n");

var expectedIds = Object.keys(expected).sort();
var actualIds = Object.keys(result.tasks).sort();

check("fixture covers " + expectedIds.length + " tasks", expectedIds.length === 46,
  "got " + expectedIds.length);
check("engine scheduled exactly the fixture's task set",
  expectedIds.join(",") === actualIds.join(","),
  "only in engine: [" + actualIds.filter(function (id) { return !expected[id]; }).join(", ") +
  "] · only in fixture: [" + expectedIds.filter(function (id) { return !result.tasks[id]; }).join(", ") + "]");

console.log("");

var mismatches = [];

expectedIds.forEach(function (id) {
  var want = expected[id];
  var got = result.tasks[id];

  if (!got) {
    fail(id + "  not scheduled by the engine");
    mismatches.push({ id: id, field: "(missing)", want: want.plannedStart + " → " + want.plannedFinish, got: "not scheduled" });
    return;
  }

  var startOk = got.plannedStart === want.plannedStart;
  var finishOk = got.plannedFinish === want.plannedFinish;

  if (startOk && finishOk) {
    pass(pad(id) + "  " + got.plannedStart + " → " + got.plannedFinish);
    return;
  }

  fail(pad(id) +
    "  expected " + want.plannedStart + " → " + want.plannedFinish +
    "   got " + got.plannedStart + " → " + got.plannedFinish);

  if (!startOk) mismatches.push({ id: id, field: "plannedStart", want: want.plannedStart, got: got.plannedStart });
  if (!finishOk) mismatches.push({ id: id, field: "plannedFinish", want: want.plannedFinish, got: got.plannedFinish });
});

function pad(s) {
  var out = String(s);
  while (out.length < 8) out += " ";
  return out;
}

/* ------------------------------------------------------------------ */
console.log("\n=== roll-up (§4.6) ===\n");

var rock = result.rocks["R3"];
check("Rock R3 has a planned finish", !!(rock && rock.plannedFinish), JSON.stringify(rock));
if (rock && rock.plannedFinish) {
  console.log("  Rock R3 plannedFinish: " + rock.plannedFinish +
    "  (sprint.end " + result.sprint.end + ")  red=" + rock.red);
  check("Rock R3 closes 2026-09-14 (D-023)", rock.plannedFinish === "2026-09-14",
    "got " + rock.plannedFinish);
  check("Rock R3 flagged red — 1 day past sprint.end (D-023, expected, not a bug)",
    rock.red === true);
}

var m13 = result.milestones["M13"];
check("M13 is marked deferred", !!m13 && m13.deferred === true);
check("M13 has no plannedFinish (all tasks deferred — empty-max guard)",
  !!m13 && m13.plannedFinish === null, m13 ? String(m13.plannedFinish) : "missing");

var datedMilestones = Object.keys(result.milestones).filter(function (id) {
  return result.milestones[id].plannedFinish !== null;
});
check("19 of 20 milestones have a date (M13 skipped)", datedMilestones.length === 19,
  "got " + datedMilestones.length);

var redMilestones = Object.keys(result.milestones).filter(function (id) {
  return result.milestones[id].red;
}).sort();
console.log("  milestones past sprint.end: " + (redMilestones.join(", ") || "(none)"));

/* ------------------------------------------------------------------ */
console.log("\n=== summary ===\n");
console.log("  passed:   " + passes);
console.log("  failed:   " + failures);

if (mismatches.length) {
  console.log("\n  date mismatches (engine vs. fixture):");
  mismatches.forEach(function (m) {
    console.log("    " + m.id + "." + m.field + ": expected " + m.want + ", got " + m.got);
  });
  console.log("\n  Per D-022: do NOT edit the fixture or force the engine to match.");
  console.log("  Report these to the design chat for a ruling.");
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
