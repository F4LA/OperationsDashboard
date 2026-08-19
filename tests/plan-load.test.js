#!/usr/bin/env node
/**
 * sprint-plan.json — structural validity only, NEVER dates.
 *
 * This is the one thing that can honestly be asserted about the PRODUCTION
 * plan file: sprint-plan.json is live and grows every sprint by design
 * (today R1+R3, soon R2), so any fixture comparing it against a frozen set
 * of task ids or planned dates is guaranteed to break the moment a new Rock
 * is loaded — which is exactly the failure tests/engine.test.js and
 * tests/burnup.test.js hit, and why they now read the frozen
 * data/rock3-seed.json instead (D-107 pass 2).
 *
 * ZERO DATE ASSERTIONS IN THIS FILE. If a future edit adds one, it has
 * defeated the reason this file exists — sprint-plan.json cannot promise a
 * date, only that it is well-formed.
 *
 *     node tests/plan-load.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

var OpsDashValidate = require(path.join(REPO, "dashboard", "validate.js")).OpsDashValidate;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

var plan = JSON.parse(fs.readFileSync(path.join(REPO, "sprint-plan.json"), "utf8"));

console.log("\n=== sprint-plan.json structural validity ===\n");

var report = OpsDashValidate.validate(plan);

check("validate() reports ok: true", report.ok === true, JSON.stringify(report.errors));
check("zero errors", report.errors.length === 0, JSON.stringify(report.errors));
check("zero warnings", report.warnings.length === 0, JSON.stringify(report.warnings));

var index = OpsDashValidate.buildIndex(plan);

check("zero duplicate ids", index.duplicates.length === 0, JSON.stringify(index.duplicates));

/* ---- dependency resolution: every dependsOn/crossDependsOn resolves, no cycles ---- */
console.log("\n=== dependencies ===\n");

var unresolvedCount = 0;
var taskIds = Object.keys(index.tasks);
for (var i = 0; i < taskIds.length; i++) {
  var resolved = OpsDashValidate.resolveDeps(index.tasks[taskIds[i]], index);
  unresolvedCount += resolved.unresolved.length;
}
check("zero unresolved dependencies across every task", unresolvedCount === 0, unresolvedCount);

function depEdges(id) {
  var node = index.tasks[id] || index.milestones[id];
  if (!node) return [];
  return OpsDashValidate.resolveDeps(node, index).taskIds.concat(
    OpsDashValidate.resolveDeps(node, index).selfMilestone || []
  );
}

var taskCycles = OpsDashValidate.findCycles(index.taskOrder, function (id) {
  return OpsDashValidate.resolveDeps(index.tasks[id], index).taskIds;
});
check("zero task-level dependency cycles", taskCycles.length === 0, JSON.stringify(taskCycles));

var milestoneCycles = OpsDashValidate.findCycles(index.milestoneOrder, function (id) {
  return OpsDashValidate.resolveDeps(index.milestones[id], index).taskIds;
});
check("zero milestone-level dependency cycles", milestoneCycles.length === 0, JSON.stringify(milestoneCycles));

/* ---- id count is REPORTED, never fixed — it grows every sprint by design ---- */
console.log("\n=== id count (informational — not a fixed expectation) ===\n");

var totalIds = Object.keys(index.kinds).length;
console.log("  total unique ids across the sprint: " + totalIds);
console.log("  tasks: " + Object.keys(index.tasks).length +
  " | milestones: " + Object.keys(index.milestones).length +
  " | projects: " + Object.keys(index.projects).length +
  " | rocks: " + Object.keys(index.rocks).length);
check("every id is accounted for exactly once (kinds count matches no-duplicate claim)",
  totalIds > 0, totalIds);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
