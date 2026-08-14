#!/usr/bin/env node
/**
 * OpsDashMetrics.burnupSeries — unit test (Phase 5, D-022 convention: plain
 * Node, no framework). burnupSeries takes a frozen-plan `.tasks` map and a
 * D-027 currentState map directly, so most of this is a fully isolated,
 * hand-built fixture — no plan/engine run needed to exercise the pure math.
 * The one exception is the real-Rock-3 sanity check at the end, which
 * reuses sprint-plan.json + planMode() as the "useful as a control" values
 * the Phase 5 spec calls out by name (46 tasks, total 40.75 work-days).
 *
 *     node tests/burnup.test.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var REPO = path.resolve(__dirname, "..");

global.window = global; // config.js/engine.js/metrics.js attach to `window` when it exists
require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/metrics.js"));
var OpsDashEngine = global.OpsDashEngine;
var OpsDashMetrics = global.OpsDashMetrics;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

function findPoint(series, date) {
  for (var i = 0; i < series.points.length; i++) {
    if (series.points[i].date === date) return series.points[i];
  }
  return null;
}

/* ================= isolated fixture — no engine run needed ================= */
console.log("\n=== isolated fixture ===\n");

var frozenTasks = {
  T1: { workDays: 5, plannedFinish: "2026-01-05" },
  T2: { workDays: 3, plannedFinish: "2026-01-10" },
  T3: { workDays: 2, plannedFinish: "2026-01-15" }
};
var allIds = ["T1", "T2", "T3"];

/* ---- one point per calendar day, inclusive, no weekend skipping ---- */
console.log("\n--- one point per calendar day (weekends included) ---\n");

var basicSeries = OpsDashMetrics.burnupSeries(frozenTasks, {}, allIds,
  "2026-01-01", "2026-01-05", "2026-01-01");
check("5-day axis (Jan 1..5 inclusive) yields exactly 5 points",
  basicSeries.points.length === 5, basicSeries.points.length);
check("every calendar day present, including any weekend in range",
  basicSeries.points.map(function (p) { return p.date; }).join(",") ===
    "2026-01-01,2026-01-02,2026-01-03,2026-01-04,2026-01-05",
  basicSeries.points.map(function (p) { return p.date; }).join(","));

/* ---- planned curve ends exactly at total ---- */
console.log("\n--- planned curve ends exactly at total ---\n");

var fullSeries = OpsDashMetrics.burnupSeries(frozenTasks, {}, allIds,
  "2026-01-01", "2026-01-20", "2026-01-20");
check("total = sum of workDays in scope (5+3+2=10)", fullSeries.total === 10, fullSeries.total);
var lastPoint = fullSeries.points[fullSeries.points.length - 1];
check("last point's date is axisEnd", lastPoint.date === "2026-01-20", lastPoint.date);
check("last point's planned === total (every plannedFinish is ≤ axisEnd)",
  lastPoint.planned === fullSeries.total, lastPoint.planned + " vs " + fullSeries.total);

var beforeAnyFinish = findPoint(fullSeries, "2026-01-01");
check("planned is 0 before any task's plannedFinish", beforeAnyFinish.planned === 0, beforeAnyFinish.planned);
var afterFirstFinish = findPoint(fullSeries, "2026-01-05");
check("planned steps up exactly on T1's plannedFinish (5)", afterFirstFinish.planned === 5, afterFirstFinish.planned);
var afterSecondFinish = findPoint(fullSeries, "2026-01-10");
check("planned steps up again on T2's plannedFinish (5+3=8)", afterSecondFinish.planned === 8, afterSecondFinish.planned);

/* ---- scope is respected — total only sums the requested taskIds ---- */
console.log("\n--- scope ---\n");

var scoped = OpsDashMetrics.burnupSeries(frozenTasks, {}, ["T1", "T2"],
  "2026-01-01", "2026-01-20", "2026-01-20");
check("total respects the scope (5+3=8, T3 excluded)", scoped.total === 8, scoped.total);

/* ---- actual is null after today; no invented future ---- */
console.log("\n--- actual is null after today ---\n");

var currentState = { T1: { status: "done", statusChangedAt: "2026-01-03T10:00:00Z" } };
var series = OpsDashMetrics.burnupSeries(frozenTasks, currentState, allIds,
  "2026-01-01", "2026-01-20", "2026-01-10");

var beforeToday = findPoint(series, "2026-01-05");
check("actual is a number on/before today, not null", beforeToday.actual === 5, JSON.stringify(beforeToday));
var onToday = findPoint(series, "2026-01-10");
check("actual is a number exactly at today", onToday.actual === 5, JSON.stringify(onToday));
var afterToday = findPoint(series, "2026-01-11");
check("actual is null the day after today", afterToday.actual === null, JSON.stringify(afterToday));
var wellAfterToday = findPoint(series, "2026-01-20");
check("actual stays null for every day after today, all the way to axisEnd",
  wellAfterToday.actual === null, JSON.stringify(wellAfterToday));
check("planned is NOT null after today — only actual stops", wellAfterToday.planned === 10, wellAfterToday.planned);

/* ---- a done task OUTSIDE the axis, on either side ---- */
console.log("\n--- done task outside the axis ---\n");

// 3a: completed BEFORE axisStart — must count from the very first point onward.
var doneBeforeAxis = { T1: { status: "done", statusChangedAt: "2025-12-20T00:00:00Z" } };
var seriesA = OpsDashMetrics.burnupSeries(frozenTasks, doneBeforeAxis, allIds,
  "2026-01-01", "2026-01-20", "2026-01-20");
var firstA = seriesA.points[0];
check("a task done before axisStart already counts at the very first point",
  firstA.actual === 5, JSON.stringify(firstA));

// 3b: completed AFTER axisEnd — must never count anywhere inside the axis, even
// though the task really is done (today is pinned to axisEnd so the null-after-
// today rule can't also explain a zero here — this isolates the outside-axis case).
var doneAfterAxis = { T3: { status: "done", statusChangedAt: "2026-01-25T00:00:00Z" } };
var seriesB = OpsDashMetrics.burnupSeries(frozenTasks, doneAfterAxis, allIds,
  "2026-01-01", "2026-01-20", "2026-01-20");
var lastB = seriesB.points[seriesB.points.length - 1];
check("a task done after axisEnd never counts anywhere inside the axis",
  lastB.actual === 0, JSON.stringify(lastB));
check("...even though today (axisEnd) is not null — it's genuinely zero, not future-masked",
  lastB.actual !== null, JSON.stringify(lastB));

/* ---- axisStart/axisEnd/today are echoed back verbatim ---- */
console.log("\n--- echoed fields ---\n");
check("axisStart echoed", fullSeries.axisStart === "2026-01-01", fullSeries.axisStart);
check("axisEnd echoed", fullSeries.axisEnd === "2026-01-20", fullSeries.axisEnd);
check("today echoed", fullSeries.today === "2026-01-20", fullSeries.today);

/* ================= real Rock 3 sanity check (the spec's own control values) ================= */
console.log("\n=== Rock 3 sanity check (control values from the Phase 5 spec) ===\n");

var plan = JSON.parse(fs.readFileSync(path.join(REPO, "sprint-plan.json"), "utf8"));
var frozen = OpsDashEngine.planMode(plan);
var rock3Ids = Object.keys(frozen.tasks);

check("46 non-deferred tasks (M13-t1 excluded)", rock3Ids.length === 46, rock3Ids.length);

var latest = plan.sprint.end;
for (var i = 0; i < rock3Ids.length; i++) {
  if (frozen.tasks[rock3Ids[i]].plannedFinish > latest) latest = frozen.tasks[rock3Ids[i]].plannedFinish;
}
check("axisEnd = max(sprint.end, latest frozen finish) = 2026-09-14 (D-023)",
  latest === "2026-09-14", latest);

var rock3Series = OpsDashMetrics.burnupSeries(frozen.tasks, {}, rock3Ids,
  plan.sprint.start, latest, "2026-08-13");
check("total = 40.75 work-days (the spec's stated control value)",
  rock3Series.total === 40.75, rock3Series.total);
var rock3Last = rock3Series.points[rock3Series.points.length - 1];
check("planned reaches exactly 40.75 by axisEnd", rock3Last.planned === 40.75, rock3Last.planned);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
