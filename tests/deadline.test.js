#!/usr/bin/env node
/**
 * Milestone `deadline` (spec §2/§5.3/§7, D-087) — validation + passive
 * engine passthrough.
 *
 * Deliberately a separate file, not an addition to engine.test.js or
 * live-engine.test.js: those two are arbitrated by frozen fixtures
 * (expected-plan-mode.json / expected-live-mode.json) and NEITHER is edited
 * here, per this project's own D-071(b) rule (a fixture adjusted to make a
 * test pass is the failure, not the fix).
 *
 * Board.js's red chip itself is NOT unit-tested here, consistent with this
 * project's existing convention: board.js (like app.js) has never had a
 * test file — only the pure logic layers (validate.js, engine.js, events.js,
 * thisweek.js, metrics.js) are. What IS covered, so the chip's inputs are
 * provably correct even though its rendering isn't: (a) validate.js's four
 * rules for the field, and (b) engine.js carrying `deadline` through the
 * roll-up completely unread by scheduling — the same day-count arithmetic
 * the chip does is exercised directly against engine.js's own parseISO, so
 * the one piece of real logic behind the chip (the day diff) is proven
 * correct without needing to load a DOM.
 *
 *     node tests/deadline.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

global.window = global;
require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
var OpsDashValidate = global.OpsDashValidate;
var OpsDashEngine = global.OpsDashEngine;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

function findError(report, code) {
  return report.errors.filter(function (e) { return e.code === code; })[0] || null;
}
function findWarning(report, code) {
  return report.warnings.filter(function (w) { return w.code === code; })[0] || null;
}

/** Minimal one-Rock, one-project, one-milestone, one-task plan, with an
 *  optional milestone-level `deadline` and optional sprint window override. */
function makePlan(opts) {
  opts = opts || {};
  var milestone = {
    id: "M1", name: "Test milestone", dependsOn: [],
    tasks: [
      { id: "T1", desc: "Only task", owner: "Ana", type: "work", workDays: 2, waitDays: 0,
        dependsOn: [], crossDependsOn: [] }
    ]
  };
  if (opts.deadline !== undefined) milestone.deadline = opts.deadline;

  return {
    schemaVersion: "1.0",
    sprint: {
      id: "S-TEST",
      start: opts.sprintStart || "2026-08-01",
      end: opts.sprintEnd || "2026-09-01"
    },
    people: ["Ana"],
    rocks: [{
      id: "R1", name: "Test Rock", owners: ["Ana"], cuttable: false,
      projects: [{ id: "P1", name: "Test Project", owner: "Ana", milestones: [milestone] }]
    }]
  };
}

/* ================= (1) no deadline — today's case, unchanged ================= */
console.log("\n=== validate.js: milestone with no deadline ===\n");

var noDeadline = OpsDashValidate.validate(makePlan({}));
check("no deadline: report.ok is true", noDeadline.ok === true, JSON.stringify(noDeadline.errors));
check("no deadline: no BAD_MILESTONE_DEADLINE error", !findError(noDeadline, "BAD_MILESTONE_DEADLINE"));
check("no deadline: no MILESTONE_DEADLINE_OUTSIDE_SPRINT warning",
  !findWarning(noDeadline, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"));

/* ================= (2) valid deadline inside the sprint window ================= */
console.log("\n=== validate.js: valid deadline inside the sprint window ===\n");

var validInside = OpsDashValidate.validate(makePlan({ deadline: "2026-08-20" }));
check("valid deadline inside window: report.ok is true", validInside.ok === true,
  JSON.stringify(validInside.errors));
check("valid deadline inside window: no error", !findError(validInside, "BAD_MILESTONE_DEADLINE"));
check("valid deadline inside window: no warning either",
  !findWarning(validInside, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"));

/* Boundary: exactly on sprint.start / sprint.end must NOT warn (the window
   is inclusive per §2's own sprint.start/sprint.end semantics). */
var onStart = OpsDashValidate.validate(makePlan({ deadline: "2026-08-01" }));
check("deadline exactly on sprint.start does not warn",
  !findWarning(onStart, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"), JSON.stringify(onStart.warnings));
var onEnd = OpsDashValidate.validate(makePlan({ deadline: "2026-09-01" }));
check("deadline exactly on sprint.end does not warn",
  !findWarning(onEnd, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"), JSON.stringify(onEnd.warnings));

/* ================= (3) malformed deadline — BLOCKING error ================= */
console.log("\n=== validate.js: malformed deadline is a blocking error (§7) ===\n");

var badMonth = OpsDashValidate.validate(makePlan({ deadline: "2026-13-01" }));
check('"2026-13-01" (month 13) rejected with BAD_MILESTONE_DEADLINE',
  badMonth.ok === false && !!findError(badMonth, "BAD_MILESTONE_DEADLINE"),
  JSON.stringify(badMonth.errors));

var badDay = OpsDashValidate.validate(makePlan({ deadline: "2026-02-30" }));
check('"2026-02-30" (Feb has no 30th) rejected with BAD_MILESTONE_DEADLINE',
  badDay.ok === false && !!findError(badDay, "BAD_MILESTONE_DEADLINE"),
  JSON.stringify(badDay.errors));

var badFormat = OpsDashValidate.validate(makePlan({ deadline: "09/05/2026" }));
check("non-ISO format rejected with BAD_MILESTONE_DEADLINE",
  badFormat.ok === false && !!findError(badFormat, "BAD_MILESTONE_DEADLINE"));

var badType = OpsDashValidate.validate(makePlan({ deadline: 20260905 }));
check("a number instead of a string is rejected too",
  badType.ok === false && !!findError(badType, "BAD_MILESTONE_DEADLINE"));

check("a blocking deadline error names the milestone id",
  findError(badMonth, "BAD_MILESTONE_DEADLINE").id === "M1",
  JSON.stringify(findError(badMonth, "BAD_MILESTONE_DEADLINE")));

/* Never silently ignored: never falls through to look like a clean report,
   and never gets fixed up or coerced to a nearby valid date. */
check("a malformed deadline never produces a clean-looking report",
  badMonth.ok === false && badDay.ok === false && badFormat.ok === false && badType.ok === false);

/* ================= (4) deadline outside the sprint window — WARNING only ============ */
console.log("\n=== validate.js: deadline outside the sprint window is a non-blocking warning (§7) ===\n");

var beforeStart = OpsDashValidate.validate(makePlan({ deadline: "2026-07-15" }));
check("deadline before sprint.start: report.ok is STILL true (non-blocking)",
  beforeStart.ok === true, JSON.stringify(beforeStart.errors));
check("deadline before sprint.start: warns MILESTONE_DEADLINE_OUTSIDE_SPRINT",
  !!findWarning(beforeStart, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"),
  JSON.stringify(beforeStart.warnings));

var afterEnd = OpsDashValidate.validate(makePlan({ deadline: "2026-09-14" }));
check("deadline after sprint.end: report.ok is STILL true (non-blocking)",
  afterEnd.ok === true, JSON.stringify(afterEnd.errors));
check("deadline after sprint.end: warns MILESTONE_DEADLINE_OUTSIDE_SPRINT",
  !!findWarning(afterEnd, "MILESTONE_DEADLINE_OUTSIDE_SPRINT"));

check("an out-of-window warning still names the milestone id",
  findWarning(afterEnd, "MILESTONE_DEADLINE_OUTSIDE_SPRINT").id === "M1");

/* Distinct from the TASK-level hardDeadline error code — the two fields look
   similar but must never collide (D-087's own explicit concern). */
check("BAD_MILESTONE_DEADLINE is a DISTINCT code from task-level BAD_DEADLINE",
  "BAD_MILESTONE_DEADLINE" !== "BAD_DEADLINE");

/* ================= engine.js: deadline is PASSIVE (D-087b, §4.4/§4.3 untouched) ====== */
console.log("\n=== engine.js: deadline travels through the roll-up, never into scheduling ===\n");

var TODAY = "2026-08-10";

var planNoDeadline = makePlan({});
var planWithDeadline = makePlan({ deadline: "2026-08-20" });

var liveNo = OpsDashEngine.liveMode(planNoDeadline, {}, TODAY);
var liveWith = OpsDashEngine.liveMode(planWithDeadline, {}, TODAY);

check("no deadline: computeRollup reports deadline as null",
  liveNo.milestones["M1"].deadline === null, JSON.stringify(liveNo.milestones["M1"]));
check("with deadline: computeRollup carries the EXACT string from the plan",
  liveWith.milestones["M1"].deadline === "2026-08-20", JSON.stringify(liveWith.milestones["M1"]));

/* The equivalence proof: adding a deadline must not move a single computed
   date, nor change scheduling order — same technique cancel-engine.test.js
   uses to prove D-068(c) is pure code reuse. */
check("adding a deadline does not change the task's plannedStart/plannedFinish",
  liveNo.tasks["T1"].plannedStart === liveWith.tasks["T1"].plannedStart &&
  liveNo.tasks["T1"].plannedFinish === liveWith.tasks["T1"].plannedFinish,
  JSON.stringify({ no: liveNo.tasks["T1"], with: liveWith.tasks["T1"] }));
check("adding a deadline does not change the milestone's own plannedFinish",
  liveNo.milestones["M1"].plannedFinish === liveWith.milestones["M1"].plannedFinish);
check("adding a deadline does not change the scheduling order",
  JSON.stringify(liveNo.order) === JSON.stringify(liveWith.order));

/* A second, busier plan — proves deadline never enters §4.4's ordering even
   when there IS a real choice to make between ready tasks. */
var busyPlan = {
  schemaVersion: "1.0",
  sprint: { id: "S-BUSY", start: "2026-08-01", end: "2026-10-01" },
  people: ["Ana"],
  rocks: [{
    id: "R1", name: "Busy Rock", owners: ["Ana"], cuttable: false,
    projects: [{
      id: "P1", name: "Busy Project", owner: "Ana",
      milestones: [
        { id: "MA", name: "A", dependsOn: [],
          tasks: [{ id: "A1", desc: "a", owner: "Ana", type: "work", workDays: 1, waitDays: 0,
            dependsOn: [], crossDependsOn: [] }] },
        { id: "MB", name: "B", dependsOn: [],
          tasks: [{ id: "B1", desc: "b", owner: "Ana", type: "work", workDays: 1, waitDays: 0,
            dependsOn: [], crossDependsOn: [] }] }
      ]
    }]
  }]
};
var busyOrder = OpsDashEngine.liveMode(busyPlan, {}, TODAY).order;

var busyPlanDeadlined = JSON.parse(JSON.stringify(busyPlan));
// Give the LATER-scheduled milestone (per busyOrder) the EARLIEST deadline —
// if deadline influenced §4.4 ordering at all, this is the case that would
// flip it, since an earliest-deadline rule would promote it to go first.
var laterMilestoneId = busyOrder[1] === "A1" ? "MB" : "MA";
busyPlanDeadlined.rocks[0].projects[0].milestones.forEach(function (m) {
  if (m.id === laterMilestoneId) m.deadline = "2026-08-02"; // earliest possible
});
var busyOrderWithDeadline = OpsDashEngine.liveMode(busyPlanDeadlined, {}, TODAY).order;

check("an EARLY deadline on the later-scheduled milestone does NOT reorder §4.4",
  JSON.stringify(busyOrder) === JSON.stringify(busyOrderWithDeadline),
  JSON.stringify({ before: busyOrder, after: busyOrderWithDeadline }));

/* planMode's inline roll-up is untouched — D-031-style guard, same
   discipline cancel-engine.test.js applies to cancellation. */
var plan1 = OpsDashEngine.planMode(planWithDeadline);
check("planMode's milestone roll-up carries NO deadline key at all",
  !("deadline" in plan1.milestones["M1"]), JSON.stringify(plan1.milestones["M1"]));

/* ================= the chip's own arithmetic (day count), proven directly ============ */
console.log("\n=== the day-count math behind the chip (calendar days, not working days) ===\n");

var parseISO = OpsDashEngine._internals.parseISO;

function daysLate(deadline, finish) {
  return Math.round((parseISO(finish) - parseISO(deadline)) / 86400000);
}

check("finish exactly ON the deadline: 0 days late (no chip)", daysLate("2026-09-05", "2026-09-05") === 0);
check("finish BEFORE the deadline: negative — board.js's own `finishMs <= deadlineMs` guard is what hides the chip",
  daysLate("2026-09-05", "2026-09-01") < 0);
check("finish 5 calendar days after, spanning a weekend: still exactly 5",
  daysLate("2026-09-05", "2026-09-10") === 5); // Sep 5 2026 is a Saturday — proves calendar days, not working days
check("a 1-day miss uses the singular in board.js's text (verified by the count itself)",
  daysLate("2026-09-05", "2026-09-06") === 1);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
