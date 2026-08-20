#!/usr/bin/env node
/**
 * Sprint Board — collapsible hierarchy (§6, revised).
 *
 *     node tests/board-hierarchy.test.js
 *
 * Board.js needs no network module (postEvent/fetchEvents) to mount or
 * render — only validate/engine/metrics — so this loads the minimum and
 * inspects render() output as a STRING (dom.mainEl.innerHTML), the same
 * approach tests/todo-week-mode.test.js uses for todos.js's rendered HTML,
 * rather than hand-rolling a CSS-selector-capable fake DOM.
 *
 * Fixture: two Rocks.
 *   R1 — cuttable, 2 projects (P1 not cuttable, P2 cuttable), each with
 *        2 milestones of 1 task apiece. P1's tasks are Ana's; P2's are
 *        Beto's. M2 carries a `deadline` earlier than its own projected
 *        finish, so R1 and P1 both get the missed-deadline badge.
 *   R2 — not cuttable, 1 project (P3), 1 milestone (M5), 1 task, owned by
 *        Beto — used for the "only my tasks" empties-a-Rock-completely case.
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

/* ---- a DOM just real enough for render()'s assignments and no-op patches ---- */
function FakeEl() {
  this.innerHTML = "";
  this._cls = {};
  this.classList = {
    add: function () { for (var i = 0; i < arguments.length; i++) this[arguments[i]] = true; }.bind(this._cls),
    remove: function () {},
    contains: function () { return false; }
  };
}
FakeEl.prototype.querySelector = function () { return null; }; // collapsed panels: always absent
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
    return new FakeEl(); // topbar/summary/burnup/toast — unused by these assertions
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

function task(id, owner) {
  return { id: id, desc: id + " desc", owner: owner, type: "work", workDays: 1, waitDays: 0,
    dependsOn: [], crossDependsOn: [] };
}

var PLAN = {
  schemaVersion: "1.0",
  sprint: { id: "S1", start: "2026-08-01", end: "2026-10-01" },
  people: ["Ana", "Beto"],
  rocks: [
    {
      id: "R1", name: "Rock One", owners: ["Ana", "Beto"], cuttable: true,
      projects: [
        { id: "P1", name: "Project One", owner: "Ana", cuttable: false,
          milestones: [
            { id: "M1", name: "Milestone One", dependsOn: [], tasks: [task("M1-t1", "Ana")] },
            // Deadline set BEFORE the sprint even starts, so a 1-day task
            // starting on sprint.start is guaranteed to miss it.
            { id: "M2", name: "Milestone Two", dependsOn: [], deadline: "2026-07-01",
              tasks: [task("M2-t1", "Ana")] }
          ] },
        { id: "P2", name: "Project Two", owner: "Beto", cuttable: true,
          milestones: [
            { id: "M3", name: "Milestone Three", dependsOn: [], tasks: [task("M3-t1", "Beto")] },
            { id: "M4", name: "Milestone Four", dependsOn: [], tasks: [task("M4-t1", "Beto")] }
          ] }
      ]
    },
    {
      id: "R2", name: "Rock Two", owners: ["Beto"], cuttable: false,
      projects: [
        { id: "P3", name: "Project Three", owner: "Beto", cuttable: false,
          milestones: [
            { id: "M5", name: "Milestone Five", dependsOn: [], tasks: [task("M5-t1", "Beto")] }
          ] }
      ]
    }
  ]
};

function mount() {
  var frozenPlan = global.OpsDashEngine.planMode(PLAN);
  Board.mount({
    plan: PLAN, frozenPlan: frozenPlan, currentState: {}, deliverables: {}, pins: {},
    people: [{ name: "Ana", active: true }, { name: "Beto", active: true }], band: 1
  });
}

mount();
var I = Board._internals;
var html = function () { return MAIN.innerHTML; };

/* ================= §6.3: default state ================= */
console.log("\n=== everything opens collapsed (§6.3) ===\n");

check("expandedRocks starts empty", Object.keys(I.getState().expandedRocks).length === 0);
check("expandedProjects starts empty", Object.keys(I.getState().expandedProjects).length === 0);
check("both Rock rows render", html().indexOf("Rock One") !== -1 && html().indexOf("Rock Two") !== -1, html());
check("no project row renders yet", html().indexOf("Project One") === -1, html());
check("no task row renders yet", html().indexOf("M1-t1 desc") === -1, html());
check("the Collapse all control is present", html().indexOf('data-action="collapse-all"') !== -1);
check("...using .btn-primary, not the dark-bar-only .btn-secondary (ef72e33)",
  /class="btn btn-primary" data-action="collapse-all"/.test(html()), html());

/* ================= §6.4/§6.6: Rock row contents, unfiltered ================= */
console.log("\n=== Rock row states what it hides (§6.6) ===\n");

var r1 = I.rockCounts(PLAN.rocks[0]);
check("R1 counts: 2 projects, 4 milestones, 4 tasks",
  r1.projectsTotal === 2 && r1.milestonesTotal === 4 && r1.tasksTotal === 4, JSON.stringify(r1));
check("R1's row states its contents count", html().indexOf("2 projects · 4 milestones · 4 tasks") !== -1, html());

var r2 = I.rockCounts(PLAN.rocks[1]);
check("R2 counts: 1 project, 1 milestone, 1 task",
  r2.projectsTotal === 1 && r2.milestonesTotal === 1 && r2.tasksTotal === 1, JSON.stringify(r2));

/* ================= missed deadline: both levels (§6.4, widened) ================= */
console.log("\n=== a missed milestone deadline is visible at BOTH levels without expanding ===\n");

check("R1's row shows the missed-deadline badge (M2 is past its deadline)",
  html().indexOf("⚠ Deadline missed") !== -1, html());
check("R1 is CUTTABLE", html().indexOf("CUTTABLE") !== -1, html());

/* ================= expanding a Rock reveals its burn-up + project rows ================= */
console.log("\n=== expanding a Rock (§6.5) ===\n");

I.onToggleRock("R1");
check("R1 is now expanded", I.getState().expandedRocks.R1 === true);
check("aria-expanded on R1's header is true",
  /data-rock-id="R1" aria-expanded="true"/.test(html()), html());
check("R2's header is untouched — still collapsed",
  /data-rock-id="R2" aria-expanded="false"/.test(html()), html());
check("R1's burn-up chart now renders", html().indexOf("burnup-chart") !== -1, html());
check("both of R1's project rows render", html().indexOf("Project One") !== -1 && html().indexOf("Project Two") !== -1, html());
check("...each with its OWN contents count, not a Rock-level one",
  html().indexOf("2 milestones · 2 tasks") !== -1, html());
check("P2's project-level CUTTABLE badge shows (Rock3's own precedent, one level down)",
  (html().match(/CUTTABLE/g) || []).length === 2, html()); // R1's + P2's
check("P1's project-level missed-deadline badge shows too (M2 is inside P1)",
  (html().match(/⚠ Deadline missed/g) || []).length === 2, html()); // R1's + P1's
check("no task row yet — projects are still collapsed", html().indexOf("M1-t1 desc") === -1, html());
check("R2 stays fully collapsed — no project or task leaked from R1's expansion",
  html().indexOf("Project Three") === -1, html());

/* ================= expanding a project reveals milestones + tasks ================= */
console.log("\n=== expanding a project reveals its milestones, WITH their tasks (§6.2) ===\n");

I.onToggleProject("P1");
check("P1 is now expanded", I.getState().expandedProjects.P1 === true);
check("P1's milestone headers render", html().indexOf("Milestone One") !== -1 && html().indexOf("Milestone Two") !== -1, html());
check("P1's task rows render", html().indexOf("M1-t1 desc") !== -1 && html().indexOf("M2-t1 desc") !== -1, html());
check("P2 stays collapsed — its tasks do not leak in", html().indexOf("M3-t1 desc") === -1, html());

/* ================= §6.7: collapse state is per id, survives a collapsed ancestor ================= */
console.log("\n=== collapse state lives per id, independent of an ancestor's state (§6.7) ===\n");

I.onToggleRock("R1"); // collapse the Rock again
check("R1 is collapsed again", I.getState().expandedRocks.R1 === false || !I.getState().expandedRocks.R1);
check("P1's OWN state is untouched — still recorded as expanded", I.getState().expandedProjects.P1 === true);
check("...but nothing of P1 renders while its parent Rock is collapsed",
  html().indexOf("Milestone One") === -1 && html().indexOf("M1-t1 desc") === -1, html());

I.onToggleRock("R1"); // re-expand
check("re-expanding R1 shows P1 ALREADY expanded — no second click needed",
  html().indexOf("M1-t1 desc") !== -1, html());

/* ================= §6.5: Collapse all, and only that — no "expand all" ================= */
console.log("\n=== Collapse all (§6.5) ===\n");

I.onCollapseAll();
check("expandedRocks is empty again", Object.keys(I.getState().expandedRocks).length === 0);
check("expandedProjects is empty again", Object.keys(I.getState().expandedProjects).length === 0);
check("back to one row per Rock, nothing else", html().indexOf("Project One") === -1 && html().indexOf("M1-t1 desc") === -1, html());
check('there is no "expand all" anywhere in the control', html().indexOf("expand all") === -1 &&
  html().indexOf("Expand all") === -1, html());

/* ================= §6.6: the "only my tasks" filter ================= */
console.log("\n=== counts and rows follow the only-my-tasks filter honestly (§6.6) ===\n");

var st = I.getState();
st.actor = "Ana";
st.onlyMine = true;
I.render();

// R1 filtered to Ana: P1's both milestones (M1, M2) are each Ana-owned, so
// both stay visible — the filter reduces PROJECTS (P2 drops out entirely,
// all-Beto) and TASKS (2 of 4), not milestone count here.
var r1Filtered = I.rockCounts(PLAN.rocks[0]);
check("R1 filtered to Ana: 1 of 2 projects visible, 2 of 4 milestones, 2 of 4 tasks",
  r1Filtered.projectsVisible === 1 && r1Filtered.milestonesVisible === 2 && r1Filtered.tasksVisible === 2,
  JSON.stringify(r1Filtered));
check("R1's row now reads the filtered task count as X of Y",
  html().indexOf("2 milestones · 2 of 4 tasks") !== -1, html());

check("R2 (all Beto) still RENDERS its row — filter never removes a Rock",
  html().indexOf("Rock Two") !== -1, html());
check("R2's row reads 0 of 1 tasks, not hidden and not silently zero-with-no-explanation",
  html().indexOf("0 of 1 tasks") !== -1, html());

I.onToggleRock("R2");
check("expanding R2 under the filter shows the 'no tasks for the filter' message",
  html().indexOf("No tasks for the selected filter in this Rock.") !== -1, html());
check("...and renders NO project row while fully empty — the whole-Rock short-circuit (§6.6)",
  html().indexOf("Project Three") === -1, html());

// Clean up filter state for the next sections.
st.onlyMine = false;
st.actor = null;
I.onCollapseAll();

/* ================= §6.8: patch guards no-op on a collapsed panel ================= */
console.log("\n=== a mark inside a collapsed panel changes no DOM and throws nothing (§6.8) ===\n");

var threw = false;
try {
  // FakeEl.querySelector always returns null — every collapsed node is
  // "not in the document", which is what these guards exist to handle.
  I.patchTaskRow("M1-t1");
  I.patchMilestoneHeader("M1");
  I.patchProjectHeader("P1");
  I.patchRockBurnup("R1");
} catch (err) {
  threw = true;
  console.log("    threw: " + (err && err.stack || err));
}
check("none of the four patch helpers throw when their node is absent", threw === false);
check("...and nothing appeared in the DOM as a side effect",
  html().indexOf("M1-t1 desc") === -1, html());

/* ================= reload starts collapsed again ================= */
console.log("\n=== a fresh mount (reload) returns to fully collapsed (§6.7) ===\n");

I.onToggleRock("R1");
I.onToggleProject("P1");
check("sanity: something is expanded before the remount",
  I.getState().expandedRocks.R1 === true && I.getState().expandedProjects.P1 === true);

mount(); // a second mount == what a page reload does
check("the new mount's expandedRocks is empty, regardless of the old one's state",
  Object.keys(Board._internals.getState().expandedRocks).length === 0);
check("the new mount's expandedProjects is empty too",
  Object.keys(Board._internals.getState().expandedProjects).length === 0);
check("rendered output is back to one row per Rock",
  MAIN.innerHTML.indexOf("Project One") === -1 && MAIN.innerHTML.indexOf("M1-t1 desc") === -1);

/* ================= the overshoot flag must not toggle the row ================= */
console.log("\n=== a click on the overshoot flag does not bubble into a row toggle ===\n");

/**
 * Found in the browser, not by this suite: the overshoot flag has its own
 * hover/focus popover and, once the Rock/project header became a real
 * <button> (§6.5), ended up NESTED inside it — a click on the flag has no
 * data-action of its own, so it bubbled up to the row's own
 * data-action="toggle-rock" and silently expanded/collapsed the row.
 * onMainClick now returns early for anything inside .overshoot-wrap, before
 * it ever resolves [data-action]. This is the regression test for that: a
 * minimal fake event-target chain that WOULD hit toggle-rock if the guard
 * were missing.
 */
function fakeChainEl(cls, parent) {
  return {
    className: cls,
    parent: parent,
    closest: function (sel) {
      var node = this;
      while (node) {
        if (sel === "[data-action]" && node.dataAction) return node;
        if (sel.charAt(0) === "." && node.className === sel.slice(1)) return node;
        node = node.parent;
      }
      return null;
    }
  };
}

mount(); // fresh, everything collapsed
var rockHeaderNode = fakeChainEl("rock-header", null);
rockHeaderNode.dataAction = "toggle-rock";
rockHeaderNode.getAttribute = function (a) {
  if (a === "data-action") return "toggle-rock";
  if (a === "data-rock-id") return "R1";
  return null;
};
var overshootWrapNode = fakeChainEl("overshoot-wrap", rockHeaderNode);
var overshootFlagNode = fakeChainEl("overshoot-flag", overshootWrapNode);

I.onMainClick({ target: overshootFlagNode });
check("a click landing on the flag leaves expandedRocks untouched",
  Object.keys(I.getState().expandedRocks).length === 0, JSON.stringify(I.getState().expandedRocks));

// Sanity: the SAME chain's outer button, clicked directly, still toggles —
// proving the guard is scoped to the flag and not a blanket no-op.
I.onMainClick({ target: rockHeaderNode });
check("...but a click on the row itself (bypassing the flag) still toggles",
  I.getState().expandedRocks.R1 === true, JSON.stringify(I.getState().expandedRocks));

I.onCollapseAll();

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
