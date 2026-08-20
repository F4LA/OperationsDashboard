#!/usr/bin/env node
/**
 * Overshoot flag — reachable by real keyboard Tab (polish pass).
 *
 *     node tests/overshoot-focus.test.js
 *
 * Found in the browser: the overshoot flag was a <span tabindex="0"> nested
 * inside the Rock/project header <button> (§6.5). Two things followed from
 * that (1) it is invalid HTML — a <button> may not contain interactive
 * content — and (2) Safari, without Full Keyboard Access on, excludes bare
 * tabindex="0" elements from the default Tab order entirely (only real
 * form controls/links/buttons are included), so the flag could never
 * actually receive keyboard focus there by default, and its :hover/
 * :focus-within popover never showed for a keyboard user, even though the
 * CSS itself was correct.
 *
 * Fix: the Rock/project header row is now a div[role="button"]
 * [tabindex="0"] rather than a real <button> — legally able to contain the
 * flag — and the flag itself is now a real <button>, always in the default
 * Tab order regardless of Full Keyboard Access. Enter/Space activation for
 * the row (lost when it stopped being a real <button>) is restored via
 * onMainKeydown.
 *
 * Same string-based render() inspection tests/board-hierarchy.test.js uses,
 * plus the same fakeChainEl event-target-chain approach that file's
 * overshoot-flag click test introduced, applied here to onMainKeydown.
 */
"use strict";

var path = require("path");
var REPO = path.resolve(__dirname, "..");

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

function FakeEl() {
  this.innerHTML = "";
  this.classList = { add: function () {}, remove: function () {}, contains: function () { return false; } };
}
FakeEl.prototype.querySelector = function () { return null; };
FakeEl.prototype.querySelectorAll = function () { return []; };
FakeEl.prototype.addEventListener = function () {};
FakeEl.prototype.removeEventListener = function () {};
FakeEl.prototype.getAttribute = function () { return null; };
FakeEl.prototype.setAttribute = function () {};

var MAIN = new FakeEl();

global.window = global;
global.document = {
  getElementById: function (id) {
    if (id === "main") return MAIN;
    return new FakeEl();
  },
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

require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/metrics.js"));
require(path.join(REPO, "dashboard/board.js"));

var Board = global.OpsDashBoard;
var CFG = global.OpsDashConfig;
CFG.todayISO = function () { return "2026-08-01"; };

var PLAN = {
  schemaVersion: "1.0",
  sprint: { id: "S1", start: "2026-08-01", end: "2026-08-20" },
  people: ["Ana"],
  rocks: [{
    id: "R1", name: "Overshoot Rock", owners: ["Ana"], cuttable: false,
    projects: [{
      id: "P1", name: "Project One", owner: "Ana", cuttable: false,
      milestones: [{
        id: "M1", name: "Milestone One", dependsOn: [],
        tasks: [{ id: "T1", desc: "very long task", owner: "Ana", type: "work",
          workDays: 30, waitDays: 0, dependsOn: [], crossDependsOn: [] }]
      }]
    }]
  }]
};

Board.mount({ plan: PLAN, frozenPlan: global.OpsDashEngine.planMode(PLAN), currentState: {},
  deliverables: {}, pins: {}, people: [{ name: "Ana", active: true }], band: 2 });

var I = Board._internals;
I.onToggleRock("R1");
I.onToggleProject("P1");

var html = MAIN.innerHTML;

/* ================= rendered markup: header rows are divs, flag is a button ================= */
console.log("\n=== the row toggle is a div[role=button], the flag is a real <button> ===\n");

check("rock-header is a div with role=button + tabindex=0",
  html.indexOf('<div role="button" tabindex="0" class="rock-header"') !== -1, html.slice(0, 300));
check("rock-header is NOT a <button> (would be invalid HTML with the flag nested inside)",
  html.indexOf('<button type="button" class="rock-header"') === -1);
check("project-header is a div with role=button + tabindex=0",
  html.indexOf('<div role="button" tabindex="0" class="project-header"') !== -1);
check("project-header is NOT a <button>",
  html.indexOf('<button type="button" class="project-header"') === -1);
check("the overshoot flag is a real <button>, not a span with tabindex",
  html.indexOf('<button type="button" class="overshoot-flag"') !== -1, html.slice(0, 400));
check("no leftover span[tabindex] overshoot flag",
  html.indexOf('<span class="overshoot-flag" tabindex="0"') === -1);
check("the flag still carries its accessible name and popover link",
  html.indexOf('aria-label="Projected past sprint end"') !== -1 &&
  html.indexOf('aria-describedby="overshoot-pop-') !== -1);

/* ================= onMainKeydown: Enter/Space activates the row toggle ================= */
console.log("\n=== onMainKeydown restores Enter/Space activation for the div[role=button] row ===\n");

function fakeTarget(dataAction, extra) {
  var clicked = 0;
  var el = {
    getAttribute: function (a) {
      if (a === "data-action") return dataAction || null;
      if (extra && Object.prototype.hasOwnProperty.call(extra, a)) return extra[a];
      return null;
    },
    classList: { contains: function () { return false; } },
    click: function () { clicked++; }
  };
  el._clicked = function () { return clicked; };
  return el;
}

function fakeEvent(key, target) {
  var prevented = 0;
  return {
    key: key,
    target: target,
    preventDefault: function () { prevented++; },
    _prevented: function () { return prevented; }
  };
}

var rockRow = fakeTarget("toggle-rock");
var e1 = fakeEvent("Enter", rockRow);
I.onMainKeydown(e1);
check("Enter on the rock-header row triggers its own click()",
  rockRow._clicked() === 1 && e1._prevented() === 1);

var projectRow = fakeTarget("toggle-project");
var e2 = fakeEvent(" ", projectRow);
I.onMainKeydown(e2);
check("Space on the project-header row triggers its own click()",
  projectRow._clicked() === 1 && e2._prevented() === 1);

var flagTarget = fakeTarget(null); // the overshoot-flag button carries no data-action
var e3 = fakeEvent("Enter", flagTarget);
I.onMainKeydown(e3);
check("Enter while the (nested) overshoot flag has focus does NOT bubble into a row toggle",
  flagTarget._clicked() === 0 && e3._prevented() === 0);

var otherKeyRow = fakeTarget("toggle-rock");
var e4 = fakeEvent("a", otherKeyRow);
I.onMainKeydown(e4);
check("an unrelated key on the row does nothing",
  otherKeyRow._clicked() === 0 && e4._prevented() === 0);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
