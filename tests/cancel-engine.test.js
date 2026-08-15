#!/usr/bin/env node
/**
 * Date engine — the CANCEL path (D-068c, Phase 8 part 2A).
 *
 * Deliberately a separate file from live-engine.test.js, which is arbitrated by
 * the frozen fixture expected-live-mode.json. That fixture encodes the engine's
 * behaviour with NO cancellations, and D-071(b)'s rule (a fixture adjusted to
 * make a test pass is the failure, not the fix) applies with full force to the
 * first change to engine.js since Phase 2. So the cancel coverage lives here,
 * built on its own expectations, and the 17/17 fixture regression next door
 * stays untouched and keeps meaning what it meant.
 *
 *     node tests/cancel-engine.test.js
 *
 * What D-068(c) actually specifies is REUSE: a cancelled task leaves the
 * schedule through the same code path a plan-deferred task already used, so
 * its dependents come out with the dependency satisfied. These tests are
 * written to prove that equivalence rather than to describe a new mechanism —
 * hence the deferred-vs-cancelled comparison at the end, which is the real
 * assertion of the whole file.
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

var OpsDashValidate = require(path.join(REPO, "dashboard", "validate.js")).OpsDashValidate;
globalThis.OpsDashValidate = OpsDashValidate;
var OpsDashEngine = require(path.join(REPO, "dashboard", "engine.js")).OpsDashEngine;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

var plan = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario-live-mode.json"), "utf8"));
var currentState = JSON.parse(fs.readFileSync(path.join(__dirname, "current-state-live-mode.json"), "utf8"));
var TODAY = "2026-08-12";

/* ================= (iii) planMode is untouched by cancellations ================= */
console.log("\n=== planMode never sees a cancellation (the fixture cannot move) ===\n");

// planMode takes no cancelled set at all — this is the structural guarantee
// D-076 fixed when it chose collectActive as the entry point. Running it twice
// and comparing the full serialised result is the strongest available check
// that the frozen baseline is immune.
var planA = OpsDashEngine.planMode(plan);
var planB = OpsDashEngine.planMode(plan);
check("planMode is deterministic across calls",
  JSON.stringify(planA) === JSON.stringify(planB));

check("planMode exposes no cancelledTasks — the frozen baseline predates every cancellation",
  planA.cancelledTasks === undefined, JSON.stringify(planA.cancelledTasks));
check("planMode's deferredTasks still means only 'deferred by the plan'",
  Array.isArray(planA.deferredTasks) && planA.deferredTasks.length === 0,
  JSON.stringify(planA.deferredTasks));

/* ================= three-argument liveMode still means "nothing cancelled" ============ */
console.log("\n=== the 3-argument call is unchanged (every pre-Phase-8 caller) ===\n");

var base3 = OpsDashEngine.liveMode(plan, currentState, TODAY);
var base4Empty = OpsDashEngine.liveMode(plan, currentState, TODAY, []);
var base4Undef = OpsDashEngine.liveMode(plan, currentState, TODAY, undefined);

check("liveMode(3 args) === liveMode(4th = [])",
  JSON.stringify(base3) === JSON.stringify(base4Empty));
check("liveMode(3 args) === liveMode(4th = undefined)",
  JSON.stringify(base3) === JSON.stringify(base4Undef));
check("with nothing cancelled, cancelledTasks is empty and stats.cancelled is 0",
  base3.cancelledTasks.length === 0 && base3.stats.cancelled === 0,
  JSON.stringify({ c: base3.cancelledTasks, s: base3.stats }));
check("baseline schedules every one of the 5 tasks", Object.keys(base3.tasks).length === 5,
  Object.keys(base3.tasks).join(","));

/* ================= (i) a cancelled task leaves the schedule ================= */
console.log("\n=== (i) a cancelled task leaves the schedule ===\n");

// T3 is open, owned by Both, and gates T5.
var cancelT3 = OpsDashEngine.liveMode(plan, currentState, TODAY, ["T3"]);

check("the cancelled task is gone from liveResult.tasks", !("T3" in cancelT3.tasks),
  Object.keys(cancelT3.tasks).join(","));
check("it is reported in cancelledTasks", cancelT3.cancelledTasks.join(",") === "T3",
  JSON.stringify(cancelT3.cancelledTasks));
check("stats.cancelled counts it", cancelT3.stats.cancelled === 1, cancelT3.stats.cancelled);
check("it is NOT in deferredTasks — deferred still means 'deferred by the plan'",
  cancelT3.deferredTasks.indexOf("T3") === -1, JSON.stringify(cancelT3.deferredTasks));
check("stats.active drops by one", cancelT3.stats.active === base3.stats.active - 1,
  cancelT3.stats.active + " vs " + base3.stats.active);
check("the run is still ok — a cancellation is not an error", cancelT3.ok === true,
  JSON.stringify(cancelT3.errors));

/* ================= (ii) dependents are unblocked and move earlier ================= */
console.log("\n=== (ii) dependents find the dependency satisfied and pull forward ===\n");

check("T5 (which depended on the cancelled T3) is still scheduled", !!cancelT5Task(),
  Object.keys(cancelT3.tasks).join(","));

function cancelT5Task() { return cancelT3.tasks["T5"]; }

check("T5 now finishes EARLIER than it did with T3 in the way",
  cancelT3.tasks["T5"].plannedFinish < base3.tasks["T5"].plannedFinish,
  "cancelled=" + cancelT3.tasks["T5"].plannedFinish + " baseline=" + base3.tasks["T5"].plannedFinish);

check("the untouched sibling branch (T4, already done) keeps its date",
  cancelT3.tasks["T4"].plannedFinish === base3.tasks["T4"].plannedFinish,
  cancelT3.tasks["T4"].plannedFinish + " vs " + base3.tasks["T4"].plannedFinish);

// The milestone that owned the cancelled task rolls up over what's left.
check("M2 (T2 in progress + T3 cancelled) still has a date, from T2 alone",
  cancelT3.milestones["M2"].plannedFinish === cancelT3.tasks["T2"].plannedFinish,
  cancelT3.milestones["M2"].plannedFinish);

/* ---- the §4.6 empty-milestone guard, verified rather than assumed ----
   M3 holds exactly one task (T4). Cancelling it leaves a milestone with no
   scheduled task at all, which is the case computeRollup's `if (!member)
   continue` has always handled for deferred tasks. */
var cancelWholeM3 = OpsDashEngine.liveMode(plan, currentState, TODAY, ["T4"]);
check("a milestone whose every task is cancelled gets plannedFinish null, not a crash",
  cancelWholeM3.milestones["M3"].plannedFinish === null,
  JSON.stringify(cancelWholeM3.milestones["M3"]));
check("...and is not flagged red off an empty set",
  cancelWholeM3.milestones["M3"].red === false,
  JSON.stringify(cancelWholeM3.milestones["M3"]));
check("...and its scheduledTaskIds is empty while taskIds still lists the task",
  cancelWholeM3.milestones["M3"].scheduledTaskIds.length === 0 &&
  cancelWholeM3.milestones["M3"].taskIds.indexOf("T4") !== -1,
  JSON.stringify(cancelWholeM3.milestones["M3"]));
check("the Rock still rolls up over its remaining dated milestones",
  typeof cancelWholeM3.rocks["R1"].plannedFinish === "string",
  JSON.stringify(cancelWholeM3.rocks["R1"]));

/* ---- cancelling several at once ---- */
var cancelTwo = OpsDashEngine.liveMode(plan, currentState, TODAY, ["T3", "T5"]);
check("two cancellations are both reported",
  cancelTwo.cancelledTasks.slice().sort().join(",") === "T3,T5",
  JSON.stringify(cancelTwo.cancelledTasks));
check("M4, whose only task was cancelled, has no date",
  cancelTwo.milestones["M4"].plannedFinish === null,
  JSON.stringify(cancelTwo.milestones["M4"]));

/* ---- an unknown id in the cancelled set is inert ---- */
var cancelGhost = OpsDashEngine.liveMode(plan, currentState, TODAY, ["NOT-A-TASK"]);
check("an id that is not in the plan cancels nothing and does not throw",
  JSON.stringify(cancelGhost.tasks) === JSON.stringify(base3.tasks),
  JSON.stringify(cancelGhost.cancelledTasks));

/* ---- cancelling an already-done task ---- */
var cancelDone = OpsDashEngine.liveMode(plan, currentState, TODAY, ["T1"]);
check("cancelling a DONE task removes it from the schedule too",
  !("T1" in cancelDone.tasks), Object.keys(cancelDone.tasks).join(","));
check("...and the run stays ok (no MISSING_COMPLETED_AT for a task that left)",
  cancelDone.ok === true, JSON.stringify(cancelDone.errors));

/* ================= the equivalence D-068(c) actually specifies ================= */
console.log("\n=== cancelled and plan-deferred take the SAME path (the point of D-068c) ===\n");

// Same plan, but T3 marked deferred in the JSON instead of cancelled at runtime.
var planWithDeferredT3 = JSON.parse(JSON.stringify(plan));
planWithDeferredT3.rocks[0].projects[0].milestones[1].tasks[1].deferred = true;

var deferredRun = OpsDashEngine.liveMode(planWithDeferredT3, currentState, TODAY);
var cancelledRun = cancelT3;

check("both routes schedule exactly the same set of tasks",
  Object.keys(deferredRun.tasks).sort().join(",") ===
  Object.keys(cancelledRun.tasks).sort().join(","),
  Object.keys(deferredRun.tasks).sort().join(",") + " vs " +
  Object.keys(cancelledRun.tasks).sort().join(","));

var dateMismatches = [];
Object.keys(deferredRun.tasks).forEach(function (id) {
  var a = deferredRun.tasks[id], b = cancelledRun.tasks[id];
  if (!b) { dateMismatches.push(id + " missing"); return; }
  if (a.plannedStart !== b.plannedStart || a.plannedFinish !== b.plannedFinish) {
    dateMismatches.push(id + ": deferred=" + a.plannedStart + ".." + a.plannedFinish +
      " cancelled=" + b.plannedStart + ".." + b.plannedFinish);
  }
});
check("every surviving task gets IDENTICAL dates either way — it is one code path",
  dateMismatches.length === 0, dateMismatches.join(" · "));

check("the two differ only in how the removal is REPORTED: deferredTasks vs cancelledTasks",
  deferredRun.deferredTasks.indexOf("T3") !== -1 &&
  deferredRun.cancelledTasks.length === 0 &&
  cancelledRun.cancelledTasks.indexOf("T3") !== -1 &&
  cancelledRun.deferredTasks.length === 0,
  JSON.stringify({
    deferredRun: { d: deferredRun.deferredTasks, c: deferredRun.cancelledTasks },
    cancelledRun: { d: cancelledRun.deferredTasks, c: cancelledRun.cancelledTasks }
  }));

/* A task that is BOTH plan-deferred and cancelled is classified as cancelled,
   per the Phase 8 part 2A brief ("un id cancelado va en cancelledTasks y NO en
   deferredTasks"). */
var bothRun = OpsDashEngine.liveMode(planWithDeferredT3, currentState, TODAY, ["T3"]);
check("a task both plan-deferred AND cancelled is reported as cancelled only",
  bothRun.cancelledTasks.indexOf("T3") !== -1 && bothRun.deferredTasks.indexOf("T3") === -1,
  JSON.stringify({ d: bothRun.deferredTasks, c: bothRun.cancelledTasks }));

/* ================= buckets inherits the removal for free (D-071a) ================= */
console.log("\n=== a cancelled task leaves This Week's buckets with no patch ===\n");

// thisweek.buckets() iterates liveResult.tasks, so once the engine drops a
// cancelled task the view's bucket math drops it too. Asserted rather than
// assumed, because "buckets and cascadeOf stay untouched" is only safe if
// that inheritance actually holds.
globalThis.OpsDashEngine = OpsDashEngine;
var ThisWeek = require(path.join(REPO, "dashboard", "thisweek.js")).OpsDashThisWeek;

var win = { start: "2026-08-07", end: "2026-08-13", mondayKey: "2026-08-10" };
function bucketsContain(b, id) {
  return Object.keys(b).some(function (person) {
    return ["done", "workingOn", "notStarted"].some(function (k) {
      return b[person][k].indexOf(id) !== -1;
    });
  });
}

var bucketsBase = ThisWeek.buckets(base3, currentState, win, plan.people);
var bucketsCancelled = ThisWeek.buckets(cancelT3, currentState, win, plan.people);

check("T3 is in the baseline buckets to begin with", bucketsContain(bucketsBase, "T3"),
  JSON.stringify(bucketsBase));
check("T3 is gone from the buckets once cancelled — inherited, not patched",
  !bucketsContain(bucketsCancelled, "T3"), JSON.stringify(bucketsCancelled));
check("the other tasks are still bucketed normally",
  bucketsContain(bucketsCancelled, "T2"), JSON.stringify(bucketsCancelled));

/* ================= early-exit shape parity (D-078, correction 3) ============ */
console.log("\n=== error returns carry the same shape as success returns ===\n");

/* 2B reads .cancelledTasks.length off a liveMode result. Before this fix an
   error result had no such field and the read threw, so the failure the user
   saw was a TypeError rather than the engine's own error message. */
var noSprint = OpsDashEngine.liveMode({ people: [], rocks: [] }, {}, TODAY);
check("liveMode(no sprint.start) reports SPRINT_START_MISSING",
  noSprint.ok === false && noSprint.errors[0].code === "SPRINT_START_MISSING",
  JSON.stringify(noSprint.errors));
check("...and still carries cancelledTasks, so .length is safe to read",
  Array.isArray(noSprint.cancelledTasks) && noSprint.cancelledTasks.length === 0,
  JSON.stringify(noSprint.cancelledTasks));
check("...and stats.cancelled", noSprint.stats.cancelled === 0, JSON.stringify(noSprint.stats));

var noToday = OpsDashEngine.liveMode(plan, currentState, null);
check("liveMode(no todayISO) reports TODAY_MISSING",
  noToday.ok === false && noToday.errors[0].code === "TODAY_MISSING",
  JSON.stringify(noToday.errors));
check("...and also carries cancelledTasks and stats.cancelled",
  Array.isArray(noToday.cancelledTasks) && noToday.stats.cancelled === 0,
  JSON.stringify({ c: noToday.cancelledTasks, s: noToday.stats }));

/* Every key the success shape has for these two fields, the error shape has. */
["cancelledTasks", "deferredTasks", "fixedTaskIds", "order", "tasks", "milestones", "rocks", "mode"]
  .forEach(function (k) {
    check("liveMode error shape has '" + k + "' like its success shape",
      Object.prototype.hasOwnProperty.call(noToday, k), Object.keys(noToday).join(","));
  });

/* planMode's own asymmetry was `mode` and `stats.active`, NOT cancelledTasks —
   planMode has no cancelledTasks on success either, because it never receives
   a cancelled set by signature. */
var planNoSprint = OpsDashEngine.planMode({ people: [], rocks: [] });
check("planMode error return now carries mode, like its success return",
  planNoSprint.mode === "plan", JSON.stringify(planNoSprint.mode));
check("planMode error return now carries stats.active",
  planNoSprint.stats.active === 0, JSON.stringify(planNoSprint.stats));
check("planMode error return still has NO cancelledTasks — neither does its success return",
  planNoSprint.cancelledTasks === undefined && planA.cancelledTasks === undefined,
  JSON.stringify(planNoSprint.cancelledTasks));

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
