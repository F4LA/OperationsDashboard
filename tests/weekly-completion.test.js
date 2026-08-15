#!/usr/bin/env node
/**
 * OpsDashMetrics — §12 weekly completion + cancelled work-days (Phase 8 part 2A).
 *
 * Covers, per D-077 (§12 math belongs in metrics.js) and D-068(d)/(e):
 *   weeklyCompletion() — completed / moved / discarded / cancelled / rate
 *   progress()         — cancelled work-days leave the denominator
 *   burnupSeries()     — gains a cancelled scalar and NOTHING else changes
 *
 *     node tests/weekly-completion.test.js
 *
 * Isolated hand-built fixtures throughout (same style as burnup.test.js): the
 * functions under test are pure, so nothing here needs the engine or a plan.
 */
"use strict";

var path = require("path");
var REPO = path.resolve(__dirname, "..");

global.window = global;
require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/metrics.js"));
var M = global.OpsDashMetrics;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

var WINDOW = { start: "2026-08-14", end: "2026-08-20", mondayKey: "2026-08-17" };
var PEOPLE = ["Ana", "Beto"];

var TASK_OWNERS = {
  A1: ["Ana"], A2: ["Ana"], A3: ["Ana"], A4: ["Ana"], A5: ["Ana"],
  B1: ["Beto"], B2: ["Beto"],
  J1: ["Ana", "Beto"]           // a "Both" task, owners already expanded
};

function base(over) {
  var o = {
    window: WINDOW, people: PEOPLE, taskOwners: TASK_OWNERS,
    currentState: {}, pins: {}, discards: {}, cancels: {}, commitment: null
  };
  for (var k in over) o[k] = over[k];
  return o;
}

/* ================= the four outcomes ================= */
console.log("\n=== the four §12 outcomes ===\n");

var r = M.weeklyCompletion(base({
  commitment: ["A1", "A2", "A3", "A4", "B1"],
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },   // completed
    A2: { status: "done", statusChangedAt: "2026-08-01T10:00:00Z" },   // done BEFORE the window
    B1: { status: "done", statusChangedAt: "2026-08-18T09:00:00Z" }    // completed
  },
  pins:     { A3: "2026-08-24" },                                       // moved forward
  discards: { A4: { note: "not needed", actor: "Ana", timestamp: "2026-08-16T10:00:00Z" } },
  cancels:  { A5: { note: "scope dropped", actor: "Ana", timestamp: "2026-08-16T10:00:00Z" } }
}));

check("completed counts a task that reached done inside the window",
  r.team.completed.indexOf("A1") !== -1, JSON.stringify(r.team.completed));

/* EXPECTATION CHANGED by D-079. This previously asserted that A2 — done on
   2026-08-01, before the window — was NOT counted. But A2 is in this week's
   frozen commitment, and D-079 rules that a committed task counts as completed
   whenever it was finished: the commitment is already the membership filter for
   the week, and withholding the credit told a person "you didn't do this" about
   finished work.

   The window bound itself is NOT loosened — it still governs everything
   uncommitted, which is asserted directly in the D-079 block below
   ("an UNCOMMITTED task done before the window is still NOT counted") and
   across the whole D-078 correction-1 block. */
check("a COMMITTED task completed before the window IS counted (D-079)",
  r.team.completed.indexOf("A2") !== -1, JSON.stringify(r.team.completed));
check("moved counts a task pinned to a LATER Monday",
  r.team.moved.indexOf("A3") !== -1, JSON.stringify(r.team.moved));
check("discarded comes from the discards map",
  r.team.discarded.indexOf("A4") !== -1, JSON.stringify(r.team.discarded));
check("cancelled comes from the cancels map",
  r.team.cancelled.indexOf("A5") !== -1, JSON.stringify(r.team.cancelled));
check("cancelled is reported SEPARATELY from discarded (§12: different signals)",
  r.team.cancelled.indexOf("A4") === -1 && r.team.discarded.indexOf("A5") === -1,
  JSON.stringify({ d: r.team.discarded, c: r.team.cancelled }));
// completedCount is 3, not 2, since D-079 admitted the committed-but-early A2.
check("counts accompany the id lists",
  r.team.completedCount === 3 && r.team.movedCount === 1 &&
  r.team.discardedCount === 1 && r.team.cancelledCount === 1, JSON.stringify(r.team));

/* a pin to THIS week, or to an earlier one, is not "moved" */
var notMoved = M.weeklyCompletion(base({
  commitment: ["A1", "A2"],
  pins: { A1: "2026-08-17", A2: "2026-08-10" }
}));
check("a pin to this same week is not counted as moved",
  notMoved.team.moved.indexOf("A1") === -1, JSON.stringify(notMoved.team.moved));
check("a pin to an EARLIER week is not counted as moved either",
  notMoved.team.moved.indexOf("A2") === -1, JSON.stringify(notMoved.team.moved));

/* one task, one outcome */
var bothWays = M.weeklyCompletion(base({
  commitment: ["A1"],
  currentState: { A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" } },
  pins: { A1: "2026-08-24" }
}));
check("a task both completed and pinned forward counts ONCE, as completed",
  bothWays.team.completedCount === 1 && bothWays.team.movedCount === 0,
  JSON.stringify(bothWays.team));

/* ================= the rate and its denominator ================= */
console.log("\n=== rate vs the frozen denominator (D-070) ===\n");

var rated = M.weeklyCompletion(base({
  commitment: ["A1", "A2", "A3", "A4"],
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    A2: { status: "done", statusChangedAt: "2026-08-16T10:00:00Z" }
  }
}));
check("denominator is the frozen commitment's length", rated.team.denominator === 4,
  rated.team.denominator);
check("rate is completed / denominator", rated.team.rate === 0.5, rated.team.rate);

/* THE rule of D-070: no confirmation, no rate. */
var unconfirmed = M.weeklyCompletion(base({
  commitment: null,
  currentState: { A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" } }
}));
check("an UNCONFIRMED week has rate null — a denominator is never invented",
  unconfirmed.team.rate === null, JSON.stringify(unconfirmed.team));
check("...and reports denominator null, not 0",
  unconfirmed.team.denominator === null, JSON.stringify(unconfirmed.team));
check("...while still counting the numerator, which is real either way",
  unconfirmed.team.completedCount === 1, JSON.stringify(unconfirmed.team));

/* Confirmed-empty is a REAL denominator of zero and must not look unconfirmed. */
var emptyConfirmed = M.weeklyCompletion(base({ commitment: [] }));
check("a week confirmed EMPTY has denominator 0, not null",
  emptyConfirmed.team.denominator === 0, JSON.stringify(emptyConfirmed.team));

/* EXPECTATION CHANGED by D-078 (correction 2). This previously asserted
   `rate === 0 && rate !== null` — that a confirmed-empty week had a real rate
   of zero. Dividing by zero is undefined, not zero, and showing 0% to someone
   who completed work they picked up mid-week is the same lie as the silent
   denominator D-070 exists to prevent. rate is now null here; `denominator`
   remains the field that separates "unconfirmed" from "confirmed empty". */
check("...and rate null, because a zero denominator makes the rate undefined",
  emptyConfirmed.team.rate === null, JSON.stringify(emptyConfirmed.team));
check("...while denominator 0 still distinguishes it from an unconfirmed week's null",
  emptyConfirmed.team.denominator === 0 &&
  M.weeklyCompletion(base({ commitment: null })).team.denominator === null,
  JSON.stringify(emptyConfirmed.team));

/* §11.5: mid-week additions raise the numerator, never the denominator. */
var over = M.weeklyCompletion(base({
  commitment: ["A1", "A2"],
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    A2: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    A3: { status: "done", statusChangedAt: "2026-08-16T10:00:00Z" }  // added mid-week
  }
}));
check("work added mid-week counts in the numerator", over.team.completedCount === 3,
  JSON.stringify(over.team.completed));
check("...but never inflates the frozen denominator", over.team.denominator === 2,
  over.team.denominator);
check("a rate ABOVE 1 is reported as-is, never clamped to 100% (§11.5)",
  over.team.rate === 1.5, over.team.rate);

/* ================= per person ================= */
console.log("\n=== per person ===\n");

var pp = M.weeklyCompletion(base({
  commitment: ["A1", "A2", "B1", "J1"],
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    B1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    J1: { status: "done", statusChangedAt: "2026-08-16T10:00:00Z" }
  }
}));

check("every person gets an entry", !!pp.byPerson.Ana && !!pp.byPerson.Beto,
  Object.keys(pp.byPerson).join(","));
check("Ana's completed holds her own tasks", pp.byPerson.Ana.completed.indexOf("A1") !== -1,
  JSON.stringify(pp.byPerson.Ana.completed));
check("Beto's completed does not hold Ana's A1",
  pp.byPerson.Beto.completed.indexOf("A1") === -1,
  JSON.stringify(pp.byPerson.Beto.completed));
check("a Both task counts for BOTH owners (D-063b's rule, carried into §12)",
  pp.byPerson.Ana.completed.indexOf("J1") !== -1 &&
  pp.byPerson.Beto.completed.indexOf("J1") !== -1,
  JSON.stringify({ a: pp.byPerson.Ana.completed, b: pp.byPerson.Beto.completed }));
check("each person is rated against THEIR slice of the commitment, not the team's",
  pp.byPerson.Ana.denominator === 3 && pp.byPerson.Beto.denominator === 2,
  JSON.stringify({ a: pp.byPerson.Ana.denominator, b: pp.byPerson.Beto.denominator }));
check("the team total is not the sum of the per-person lists (J1 is shared)",
  pp.team.denominator === 4, pp.team.denominator);
check("a person with nothing gets zeroes, not a missing entry",
  M.weeklyCompletion(base({ commitment: [] })).byPerson.Beto.completedCount === 0);

/* Rock tasks are ordinary here (§12) — no separate class. */
var rockish = M.weeklyCompletion(base({
  commitment: ["M2-t1", "A1"],
  taskOwners: { "M2-t1": ["Ana"], A1: ["Ana"] },
  currentState: { "M2-t1": { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" } }
}));
check("a Rock task counts like any other (§12: they ARE the week's to-dos)",
  rockish.team.completed.indexOf("M2-t1") !== -1 && rockish.team.denominator === 2,
  JSON.stringify(rockish.team));

/* ================= D-078 correction 1: every outcome is window-bounded ========= */
console.log("\n=== the four outcomes are bounded to the window (D-078 c1) ===\n");

var LAST_WEEK = { start: "2026-08-07", end: "2026-08-13", mondayKey: "2026-08-10" };

/* One dataset, judged through TWO windows. The events are identical; only the
   window moves. This is the defect the correction fixes: before it, the stale
   outcomes below were re-counted every single week, for ever. */
var stale = {
  people: PEOPLE, taskOwners: TASK_OWNERS,
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-10T10:00:00Z" }   // done LAST week
  },
  pins:      { A2: "2026-09-14" },                                     // pinned LAST week
  pinEvents: { A2: { value: "2026-09-14", actor: "Ana", timestamp: "2026-08-10T11:00:00Z" } },
  discards:  { A3: { note: "old", actor: "Ana", timestamp: "2026-08-10T12:00:00Z" } },
  cancels:   { A4: { note: "old", actor: "Ana", timestamp: "2026-08-10T12:00:00Z" } },
  commitment: []
};

function judge(win, over) {
  var o = { window: win };
  for (var k in stale) o[k] = stale[k];
  for (var k2 in (over || {})) o[k2] = over[k2];
  return M.weeklyCompletion(o);
}

var thisWeekStale = judge(WINDOW);
check("a task DISCARDED last week is not counted as discarded this week",
  thisWeekStale.team.discardedCount === 0, JSON.stringify(thisWeekStale.team.discarded));
check("a task CANCELLED last week is not counted as cancelled this week",
  thisWeekStale.team.cancelledCount === 0, JSON.stringify(thisWeekStale.team.cancelled));
check("a task PINNED forward last week is not counted as moved this week",
  thisWeekStale.team.movedCount === 0, JSON.stringify(thisWeekStale.team.moved));
check("a task COMPLETED last week is not counted as completed this week",
  thisWeekStale.team.completedCount === 0, JSON.stringify(thisWeekStale.team.completed));

/* Same data, its own week: everything must be counted there. */
var ownWeek = judge(LAST_WEEK);
check("the SAME discard is counted in its own week", ownWeek.team.discarded.indexOf("A3") !== -1,
  JSON.stringify(ownWeek.team.discarded));
check("the SAME cancel is counted in its own week", ownWeek.team.cancelled.indexOf("A4") !== -1,
  JSON.stringify(ownWeek.team.cancelled));
check("the SAME pin is counted as moved in its own week", ownWeek.team.moved.indexOf("A2") !== -1,
  JSON.stringify(ownWeek.team.moved));
check("the SAME completion is counted in its own week",
  ownWeek.team.completed.indexOf("A1") !== -1, JSON.stringify(ownWeek.team.completed));

/* A committed task is judged even when its event fell outside the window —
   the commitment IS this week's commitment by definition. */
var committedStale = judge(WINDOW, { commitment: ["A3", "A4", "A2"] });
check("a COMMITTED task discarded outside the window is still judged",
  committedStale.team.discarded.indexOf("A3") !== -1,
  JSON.stringify(committedStale.team.discarded));
check("a COMMITTED task cancelled outside the window is still judged",
  committedStale.team.cancelled.indexOf("A4") !== -1,
  JSON.stringify(committedStale.team.cancelled));
check("a COMMITTED task pinned forward outside the window is still judged as moved",
  committedStale.team.moved.indexOf("A2") !== -1, JSON.stringify(committedStale.team.moved));

/* An in-window event on an uncommitted task still counts (§11.5 / D-078c). */
var freshDiscard = M.weeklyCompletion(base({
  commitment: [],
  discards: { A9: { note: "born and binned this week", actor: "Ana", timestamp: "2026-08-16T10:00:00Z" } },
  taskOwners: { A9: ["Ana"] }
}));
check("a task born AND discarded inside the window counts as discarded (§12 noise signal)",
  freshDiscard.team.discarded.indexOf("A9") !== -1, JSON.stringify(freshDiscard.team.discarded));

/* Without pinEvents, a pin can only be judged via the commitment — asserted so
   the optional-argument behaviour is pinned down rather than incidental. */
var noPinEvents = M.weeklyCompletion(base({
  commitment: [], pins: { A2: "2026-09-14" }
}));
check("with no pinEvents supplied, an uncommitted pin is not counted as moved",
  noPinEvents.team.movedCount === 0, JSON.stringify(noPinEvents.team.moved));

var noPinEventsCommitted = M.weeklyCompletion(base({
  commitment: ["A2"], pins: { A2: "2026-09-14" }
}));
check("...but a COMMITTED one still is, with no timestamp needed",
  noPinEventsCommitted.team.moved.indexOf("A2") !== -1,
  JSON.stringify(noPinEventsCommitted.team.moved));

/* The stale-history sweep is gone: currentState no longer drags in every task
   that was ever touched. */
var bigHistory = M.weeklyCompletion(base({
  commitment: [],
  currentState: {
    H1: { status: "done", statusChangedAt: "2026-06-01T10:00:00Z" },
    H2: { status: "in_progress", statusChangedAt: "2026-07-01T10:00:00Z" },
    H3: { status: "open", statusChangedAt: "2026-07-15T10:00:00Z" }
  },
  taskOwners: { H1: ["Ana"], H2: ["Ana"], H3: ["Ana"] }
}));
check("months of unrelated status history produce no outcomes for this week",
  bigHistory.team.completedCount === 0 && bigHistory.team.movedCount === 0 &&
  bigHistory.team.discardedCount === 0 && bigHistory.team.cancelledCount === 0,
  JSON.stringify(bigHistory.team));

/* ================= D-079: a COMMITTED task done before the window ============ */
console.log("\n=== a committed task finished before the window still counts (D-079) ===\n");

var LONG_AGO = "2026-07-24T10:00:00Z"; // three weeks before WINDOW

/* (1) In the commitment, done long before the window → completed, and the rate
   goes UP rather than down. This is the case D-079 exists for. */
var committedEarly = M.weeklyCompletion(base({
  commitment: ["A1", "A2"],
  currentState: { A1: { status: "done", statusChangedAt: LONG_AGO } }
}));
check("a COMMITTED task done three weeks early counts as completed",
  committedEarly.team.completed.indexOf("A1") !== -1,
  JSON.stringify(committedEarly.team.completed));
check("...so the rate RISES instead of falling (1 of 2, not 0 of 2)",
  committedEarly.team.rate === 0.5, committedEarly.team.rate);
check("...and it is still in the denominator, not double-counted out of it",
  committedEarly.team.denominator === 2, committedEarly.team.denominator);
check("...and it reaches the owner's own tally too",
  committedEarly.byPerson.Ana.completed.indexOf("A1") !== -1,
  JSON.stringify(committedEarly.byPerson.Ana));

/* (2) The guard on D-078. NOT in the commitment, done before the window → not
   counted. If this ever flips, the original all-history defect is back and the
   discard/completion counts start inflating every week again. */
var uncommittedEarly = M.weeklyCompletion(base({
  commitment: ["A2"],
  currentState: { A1: { status: "done", statusChangedAt: LONG_AGO } }
}));
check("an UNCOMMITTED task done before the window is still NOT counted (D-078 holds)",
  uncommittedEarly.team.completed.indexOf("A1") === -1,
  JSON.stringify(uncommittedEarly.team.completed));
check("...and it does not sneak into the tally at all",
  uncommittedEarly.team.completedCount === 0, JSON.stringify(uncommittedEarly.team));

/* The same relaxation must NOT leak to a week with no commitment at all. */
var noCommitEarly = M.weeklyCompletion(base({
  commitment: null,
  currentState: { A1: { status: "done", statusChangedAt: LONG_AGO } }
}));
check("with no commitment at all, an early completion is not counted either",
  noCommitEarly.team.completedCount === 0, JSON.stringify(noCommitEarly.team));

/* (3) Committed but never finished → still nothing. The exception is about
   WHEN it was done, not about waiving the done requirement. */
var committedUnfinished = M.weeklyCompletion(base({
  commitment: ["A1", "A2"],
  currentState: { A1: { status: "in_progress", statusChangedAt: "2026-08-15T10:00:00Z" } }
}));
check("a COMMITTED task that was never finished is still not completed",
  committedUnfinished.team.completedCount === 0,
  JSON.stringify(committedUnfinished.team.completed));
check("...and the rate reflects that (0 of 2)", committedUnfinished.team.rate === 0,
  committedUnfinished.team.rate);

/* An in-window completion of a committed task is unaffected by the change. */
var committedInWindow = M.weeklyCompletion(base({
  commitment: ["A1"],
  currentState: { A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" } }
}));
check("a committed task done INSIDE the window still counts, unchanged",
  committedInWindow.team.rate === 1, JSON.stringify(committedInWindow.team));

/* Priority is untouched: completed still outranks the other three. */
var committedEarlyAndDiscarded = M.weeklyCompletion(base({
  commitment: ["A1"],
  currentState: { A1: { status: "done", statusChangedAt: LONG_AGO } },
  discards: { A1: { note: "x", actor: "Ana", timestamp: "2026-08-16T10:00:00Z" } }
}));
check("completed still outranks discarded for a committed early-done task (D-078b)",
  committedEarlyAndDiscarded.team.completedCount === 1 &&
  committedEarlyAndDiscarded.team.discardedCount === 0,
  JSON.stringify(committedEarlyAndDiscarded.team));

/* ================= D-078 correction 2: rate with an empty denominator ========= */
console.log("\n=== an empty frozen denominator gives rate null, not 0 (D-078 c2) ===\n");

var emptyDen = M.weeklyCompletion(base({
  commitment: [],
  currentState: {
    A1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
    A2: { status: "done", statusChangedAt: "2026-08-16T10:00:00Z" },
    A3: { status: "done", statusChangedAt: "2026-08-17T10:00:00Z" }
  }
}));
check("three mid-week completions are all counted", emptyDen.team.completedCount === 3,
  JSON.stringify(emptyDen.team.completed));
check("denominator is 0 (the week WAS confirmed, with nothing in it)",
  emptyDen.team.denominator === 0, emptyDen.team.denominator);
check("rate is null — dividing by zero is undefined, not 0%",
  emptyDen.team.rate === null, JSON.stringify(emptyDen.team.rate));
check("nothing is clamped: the completions stand", emptyDen.team.completedCount === 3);

/* Both nulls must remain distinguishable — 2B renders them differently. */
var neverConfirmed = M.weeklyCompletion(base({ commitment: null }));
check("an unconfirmed week also has rate null", neverConfirmed.team.rate === null);
check("but denominator still tells the two apart: null vs 0",
  neverConfirmed.team.denominator === null && emptyDen.team.denominator === 0,
  JSON.stringify({ unconfirmed: neverConfirmed.team.denominator, empty: emptyDen.team.denominator }));

check("a person with an empty personal denominator also gets rate null",
  M.weeklyCompletion(base({ commitment: ["B1"] })).byPerson.Ana.rate === null &&
  M.weeklyCompletion(base({ commitment: ["B1"] })).byPerson.Ana.denominator === 0,
  JSON.stringify(M.weeklyCompletion(base({ commitment: ["B1"] })).byPerson.Ana));

/* ================= §5.1: cancelled work-days (D-068d) ================= */
console.log("\n=== progress(): cancelled work-days leave the denominator ===\n");

var frozen = {
  P1: { workDays: 2, plannedFinish: "2026-08-10" },
  P2: { workDays: 3, plannedFinish: "2026-08-11" },
  P3: { workDays: 5, plannedFinish: "2026-08-12" }
};
var ids = ["P1", "P2", "P3"];
var stateDone = { P1: { status: "done", statusChangedAt: "2026-08-10T10:00:00Z" } };

var noCancel = M.progress(frozen, stateDone, ids);
check("with nothing cancelled the totals are unchanged (2/10)",
  noCancel.done === 2 && noCancel.total === 10, JSON.stringify(noCancel));
check("cancelled is 0, not undefined, so callers can always read it",
  noCancel.cancelled === 0, JSON.stringify(noCancel));

var withCancel = M.progress(frozen, stateDone, ids, { P3: true });
check("a cancelled task's work-days LEAVE the denominator (10 -> 5)",
  withCancel.total === 5, JSON.stringify(withCancel));
check("...and are returned separately as the cancelled total",
  withCancel.cancelled === 5, JSON.stringify(withCancel));
check("the percentage rises because the remaining work is what is measured",
  withCancel.pct === 0.4 && withCancel.pct > noCancel.pct,
  withCancel.pct + " vs " + noCancel.pct);

/* The point of D-068(d): cancelling the rest lets the Rock actually finish. */
var allButDone = M.progress(frozen, stateDone, ids, { P2: true, P3: true });
check("cancelling everything unfinished lets the bar reach 100% (D-058's habit avoided)",
  allButDone.pct === 1, JSON.stringify(allButDone));

var doneAndCancelled = M.progress(frozen, stateDone, ids, { P1: true });
check("a cancelled task leaves the NUMERATOR too, even if it was done",
  doneAndCancelled.done === 0 && doneAndCancelled.total === 8,
  JSON.stringify(doneAndCancelled));

check("everything cancelled gives pct 0 rather than dividing by zero",
  M.progress(frozen, stateDone, ids, { P1: true, P2: true, P3: true }).pct === 0);

/* ================= §5.2: burn-up gains a scalar and nothing else ============ */
console.log("\n=== burnupSeries(): additive only (D-053, D-068e) ===\n");

var seriesPlain = M.burnupSeries(frozen, stateDone, ids, "2026-08-08", "2026-08-14", "2026-08-12");
var seriesCancel = M.burnupSeries(frozen, stateDone, ids, "2026-08-08", "2026-08-14", "2026-08-12",
  { P3: true });

check("the PLANNED curve is byte-identical with and without cancellations",
  JSON.stringify(seriesPlain.points.map(function (p) { return p.planned; })) ===
  JSON.stringify(seriesCancel.points.map(function (p) { return p.planned; })),
  "the frozen promise must not be rewritten mid-sprint");
check("the ACTUAL curve is unchanged too",
  JSON.stringify(seriesPlain.points.map(function (p) { return p.actual; })) ===
  JSON.stringify(seriesCancel.points.map(function (p) { return p.actual; })));
check("total is unchanged — cancelled days stay in the promise",
  seriesPlain.total === seriesCancel.total, seriesPlain.total + " vs " + seriesCancel.total);
check("the ONLY difference is the new cancelled scalar",
  seriesPlain.cancelled === 0 && seriesCancel.cancelled === 5,
  JSON.stringify({ a: seriesPlain.cancelled, b: seriesCancel.cancelled }));

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
