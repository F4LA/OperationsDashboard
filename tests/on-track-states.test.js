#!/usr/bin/env node
/**
 * §5.2 on-track — three states, symmetric band.
 *
 *     node tests/on-track-states.test.js
 *
 * No existing test exercised OpsDashMetrics.onTrack() or board.js's
 * onTrackLabel() at all before this pass — this is the first coverage
 * either has had. Pure math + a pure label mapping, so this builds tiny
 * hand-rolled fixtures directly rather than a full plan/engine run.
 *
 *   gap = actual(today) − planned(today)
 *   gap >= +band        -> "blue"  "Ahead"
 *   -band < gap < +band -> "green" "On pace"
 *   gap <= -band         -> "red"   "Behind"
 */
"use strict";

var path = require("path");
var REPO = path.resolve(__dirname, "..");

global.window = global;
require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/metrics.js"));

var Metrics = global.OpsDashMetrics;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

var TODAY = "2026-08-15";

/* ================= the three states, symmetric band ================= */
console.log("\n=== three states, band applied on BOTH sides of zero ===\n");

var BAND = 2;

// planned = 5 (finish already passed), actual = 5 + 3 ahead of the plan's
// own workDays would need a second task; simplest is to vary `actual` via
// a bigger/smaller single task relative to a fixed planned amount. Use two
// tasks instead: one plans 5, one (variously) marks done to move `actual`.
function twoTaskCase(plannedWd, actualWd, doneIso) {
  var frozenTasks = {
    P: { plannedFinish: "2026-08-10", workDays: plannedWd }, // already due
    A: { plannedFinish: "2026-09-01", workDays: actualWd }   // not yet due, but done early
  };
  var currentState = doneIso
    ? { A: { status: "done", statusChangedAt: doneIso + "T10:00:00Z" } }
    : {};
  return function (band) {
    return Metrics.onTrack(frozenTasks, currentState, ["P", "A"], TODAY, band);
  };
}

// planned = 5, actual = 5 + BAND exactly -> gap === +band -> blue (closed boundary)
var atPositiveBoundary = twoTaskCase(5, 5 + BAND, TODAY)(BAND);
check("gap === +band is BLUE (Ahead) — the boundary itself, not a hair past it",
  atPositiveBoundary.gap === BAND && atPositiveBoundary.color === "blue",
  JSON.stringify(atPositiveBoundary));

// just inside: gap = +band - 1 -> green
var justInsidePositive = twoTaskCase(5, 5 + BAND - 1, TODAY)(BAND);
check("gap = +band - 1 is GREEN (On pace) — one work-day inside the band",
  justInsidePositive.gap === BAND - 1 && justInsidePositive.color === "green",
  JSON.stringify(justInsidePositive));

// gap exactly 0 -> green (inside the band on both sides when band > 0)
var atZero = twoTaskCase(5, 5, TODAY)(BAND);
check("gap === 0 is GREEN — dead on plan, not treated as ahead",
  atZero.gap === 0 && atZero.color === "green", JSON.stringify(atZero));

// gap = -(band - 1) -> still green
var justInsideNegative = twoTaskCase(5, 5 - (BAND - 1), TODAY)(BAND);
check("gap = -(band - 1) is GREEN — one work-day inside the band, behind side",
  justInsideNegative.gap === -(BAND - 1) && justInsideNegative.color === "green",
  JSON.stringify(justInsideNegative));

// gap === -band exactly -> red (closed boundary, matches spec's own "<=")
var atNegativeBoundary = twoTaskCase(5, 5 - BAND, TODAY)(BAND);
check("gap === -band is RED (Behind) — the boundary itself",
  atNegativeBoundary.gap === -BAND && atNegativeBoundary.color === "red",
  JSON.stringify(atNegativeBoundary));

// well past either edge
var wellAhead = twoTaskCase(5, 5 + BAND + 3, TODAY)(BAND);
check("well past the positive edge is still BLUE", wellAhead.color === "blue");
var wellBehind = twoTaskCase(5, 5 - BAND - 3, TODAY)(BAND);
check("well past the negative edge is still RED", wellBehind.color === "red");

/* ================= band = 0: no green zone at all ================= */
console.log("\n=== band = 0 collapses the green zone to nothing (documented, not a bug) ===\n");

var zeroBandAhead = twoTaskCase(5, 6, TODAY)(0);
check("band 0, gap > 0 -> blue", zeroBandAhead.gap === 1 && zeroBandAhead.color === "blue");
var zeroBandOnPlan = twoTaskCase(5, 5, TODAY)(0);
check("band 0, gap === 0 -> blue (the >= boundary wins the tie, per the spec's own order)",
  zeroBandOnPlan.gap === 0 && zeroBandOnPlan.color === "blue", JSON.stringify(zeroBandOnPlan));
var zeroBandBehind = twoTaskCase(5, 4, TODAY)(0);
check("band 0, gap < 0 -> red", zeroBandBehind.gap === -1 && zeroBandBehind.color === "red");

/* ================= band echoed back, negative/missing band clamped ================= */
console.log("\n=== band handling (unchanged from before this pass) ===\n");

var normalBand = twoTaskCase(5, 5, null)(BAND);
check("band is echoed back on the result", normalBand.band === BAND, normalBand.band);
var missingBand = twoTaskCase(5, 5, null)(undefined);
check("a missing band clamps to 0, not NaN/undefined", missingBand.band === 0, missingBand.band);
var negativeBand = twoTaskCase(5, 5, null)(-3);
check("a negative band clamps to 0", negativeBand.band === 0, negativeBand.band);

/* ================= board.js's label mapping ================= */
console.log("\n=== onTrackLabel: one function, both call sites read it (Rock row + summary bar) ===\n");

// board.js requires a DOM/config context to load fully; load it the same
// minimal way tests/board-hierarchy.test.js does, then read the exported
// label function directly rather than exercising the whole render path —
// this file's job is the label mapping, not the board.
function FakeEl() { this.innerHTML = ""; this.classList = { add: function () {}, remove: function () {}, contains: function () { return false; } }; }
FakeEl.prototype.querySelector = function () { return null; };
FakeEl.prototype.querySelectorAll = function () { return []; };
FakeEl.prototype.addEventListener = function () {};
FakeEl.prototype.removeEventListener = function () {};
FakeEl.prototype.getAttribute = function () { return null; };
FakeEl.prototype.setAttribute = function () {};

// ONE stable element per id, reused on every call — otherwise board.js's
// dom.mainEl (captured once, during mount()) and any later
// document.getElementById("main") in this test would resolve to two
// different objects, and reading the wrong one is exactly what happened on
// the first run of this file (every render assertion failed against an
// element board.js never wrote to).
var ELS = {};
function stableEl(id) {
  if (!ELS[id]) ELS[id] = new FakeEl();
  return ELS[id];
}
global.document = {
  getElementById: stableEl,
  createElement: function () { return new FakeEl(); },
  addEventListener: function () {}
};
global.localStorage = {
  _v: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setItem: function (k, v) { this._v[k] = String(v); },
  removeItem: function (k) { delete this._v[k]; }
};
global.location = { search: "" };
global.URLSearchParams = function () { return { get: function () { return null; } }; };
require(path.join(REPO, "dashboard/board.js"));

// onTrackLabel is not on the public API or _internals — reached the same
// way the acceptance criterion states it: through the two real call sites
// (renderRockHeaderInner / renderSummaryBar), by mounting a tiny plan and
// reading the rendered chip text for each of the three colors via onTrack
// results that force each state.
var Board = global.OpsDashBoard;

var PLAN = {
  schemaVersion: "1.0", sprint: { id: "S1", start: "2026-08-01", end: "2026-10-01" },
  people: ["Ana"],
  rocks: [{ id: "R1", name: "Rock", owners: ["Ana"], cuttable: false, projects: [
    { id: "P1", name: "P", owner: "Ana", cuttable: false, milestones: [
      { id: "M1", name: "M", dependsOn: [], tasks: [
        { id: "T1", desc: "t", owner: "Ana", type: "work", workDays: 1, waitDays: 0,
          dependsOn: [], crossDependsOn: [] }
      ] }
    ] }]
  }]
};

/** Mount with a stubbed metrics.computeAll so BOTH call sites (the Rock
 *  header and the sprint summary bar) get the forced color, then return
 *  what board.js actually wrote into #main. */
function renderWithColor(color) {
  var realComputeAll = Metrics.computeAll;
  Metrics.computeAll = function () {
    var real = realComputeAll.apply(Metrics, arguments);
    real.sprint.onTrack.color = color;
    for (var rid in real.rocks) real.rocks[rid].onTrack.color = color;
    return real;
  };
  global.OpsDashConfig.todayISO = function () { return TODAY; };
  Board.mount({ plan: PLAN, frozenPlan: global.OpsDashEngine.planMode(PLAN), currentState: {},
    deliverables: {}, pins: {}, people: [{ name: "Ana", active: true }], band: BAND });
  Metrics.computeAll = realComputeAll;
  return stableEl("main").innerHTML + stableEl("board-summary-bar").innerHTML;
}

var blueHtml = renderWithColor("blue");
check('color "blue" renders the label "Ahead"', blueHtml.indexOf(">Ahead<") !== -1, blueHtml.slice(0, 400));
check('...using .chip-blue, not a leftover .chip-amber', blueHtml.indexOf("chip-blue") !== -1 &&
  blueHtml.indexOf("chip-amber") === -1, blueHtml.slice(0, 400));

var greenHtml = renderWithColor("green");
check('color "green" renders the label "On pace"', greenHtml.indexOf(">On pace<") !== -1, greenHtml.slice(0, 400));

var redHtml = renderWithColor("red");
check('color "red" renders the label "Behind"', redHtml.indexOf(">Behind<") !== -1, redHtml.slice(0, 400));

check('"Slightly behind" no longer appears anywhere the app renders',
  blueHtml.indexOf("Slightly behind") === -1 &&
  greenHtml.indexOf("Slightly behind") === -1 &&
  redHtml.indexOf("Slightly behind") === -1);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
