#!/usr/bin/env node
/**
 * ONE CLICK MUST PRODUCE ONE WRITE.
 *
 *     node tests/listener-isolation.test.js
 *
 * This is a regression test for a shipped double-write, and it is
 * deliberately NOT a test that the handlers work — those exist elsewhere.
 * It counts CALLS TO THE WRITE PATH with more than one view mounted.
 *
 * What happened: board.js, todos.js and issues.js all render into the same
 * #main, and each attached its own click listener to it at mount. Both
 * todos.js and issues.js handle "todo-add-adhoc" — issues.js reuses §11.5's
 * ad-hoc form (§13.3 says to), and reusing the markup means reusing its
 * data-action. So one Add click ran both handlers and posted two createTask
 * calls. In production that produced T-0008 and T-0009 three seconds apart;
 * the gap was the server's LockService serialising them, not two clicks.
 *
 * Why the in-flight guard did not save it: by the time the first handler
 * disabled the form, BOTH listeners had already been dispatched for that
 * same event. Disabling a control does not cancel handlers already queued.
 * The only fix is for the second listener not to be attached at all, which
 * is what setActive() enforces — and what this file guards.
 *
 * The DOM here is a hand-rolled minimum: enough of addEventListener /
 * removeEventListener / closest / getAttribute to run real event dispatch
 * through the real handlers, with no browser.
 */
"use strict";

var path = require("path");
var REPO = path.resolve(__dirname, "..");

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

/* ------------------------------------------------------------------ *
 * A DOM small enough to read, real enough to dispatch
 * ------------------------------------------------------------------ */

function FakeEl(attrs, className) {
  this._attrs = attrs || {};
  this.className = className || "";
  this.children = [];
  this.parent = null;
  this.disabled = false;
  this.value = "";
  this.textContent = "";
  this.innerHTML = "";
  this.style = {};
  this._listeners = { click: [], change: [], keydown: [] };
}
FakeEl.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
};
FakeEl.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
FakeEl.prototype.appendChild = function (c) { c.parent = this; this.children.push(c); return c; };
/** Only the selectors this test actually uses: "[data-action]", ".cls". */
FakeEl.prototype.closest = function (sel) {
  var n = this;
  while (n) {
    if (sel === "[data-action]" && n.getAttribute("data-action") !== null) return n;
    if (sel.charAt(0) === "." && (" " + n.className + " ").indexOf(" " + sel.slice(1) + " ") !== -1) return n;
    n = n.parent;
  }
  return null;
};
FakeEl.prototype._walk = function (fn) {
  fn(this);
  for (var i = 0; i < this.children.length; i++) this.children[i]._walk(fn);
};
FakeEl.prototype.querySelector = function (sel) {
  var found = null;
  this._walk(function (n) {
    if (found) return;
    if (sel.charAt(0) === "." && (" " + n.className + " ").indexOf(" " + sel.slice(1) + " ") !== -1) found = n;
  });
  return found;
};
FakeEl.prototype.querySelectorAll = function () { return []; };
FakeEl.prototype.addEventListener = function (type, fn) {
  if (!this._listeners[type]) this._listeners[type] = [];
  this._listeners[type].push(fn);
};
FakeEl.prototype.removeEventListener = function (type, fn) {
  var list = this._listeners[type];
  if (!list) return;
  var i = list.indexOf(fn);
  if (i !== -1) list.splice(i, 1);
};
/** Dispatch exactly the way a browser does: every attached listener runs,
 *  in order, for the SAME event. That is the behaviour under test. */
FakeEl.prototype.dispatch = function (type, target) {
  var list = (this._listeners[type] || []).slice();
  var evt = { type: type, target: target, preventDefault: function () {} };
  for (var i = 0; i < list.length; i++) list[i](evt);
  return list.length;
};
FakeEl.prototype.listenerCount = function (type) {
  return (this._listeners[type] || []).length;
};

var MAIN = new FakeEl({ id: "main" }, "main");
var TOASTS = new FakeEl({ id: "toast-container" }, "toast-container");
var TOPBAR = new FakeEl({ id: "board-topbar-right" }, "");
var SUMMARY = new FakeEl({ id: "board-summary-bar" }, "");
var BURNUP = new FakeEl({ id: "board-burnup-panel" }, "");
[SUMMARY, BURNUP].forEach(function (el) {
  el.classList = { add: function () {}, remove: function () {}, contains: function () { return false; } };
});

global.window = global;
global.document = {
  getElementById: function (id) {
    if (id === "main") return MAIN;
    if (id === "toast-container") return TOASTS;
    if (id === "board-topbar-right") return TOPBAR;
    if (id === "board-summary-bar") return SUMMARY;
    if (id === "board-burnup-panel") return BURNUP;
    // board.js's topbar markup is written via innerHTML and then looked up by
    // id; this harness does not parse HTML, so hand back an inert element
    // rather than null. Nothing under test depends on the topbar.
    return new FakeEl({ id: id }, "");
  },
  createElement: function () {
    var el = new FakeEl({}, "");
    el.classList = { add: function () {}, remove: function () {} };
    return el;
  },
  addEventListener: function () {},
  readyState: "complete"
};
global.localStorage = {
  _v: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setItem: function (k, v) { this._v[k] = String(v); },
  removeItem: function (k) { delete this._v[k]; }
};
global.setTimeout = global.setTimeout || function (fn) { return fn(); };
global.location = { search: "" };          // board.js reads ?actor= at mount
global.URLSearchParams = global.URLSearchParams || function () {
  return { get: function () { return null; } };
};

require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/events.js"));
require(path.join(REPO, "dashboard/metrics.js"));
require(path.join(REPO, "dashboard/thisweek.js"));
require(path.join(REPO, "dashboard/board.js"));
require(path.join(REPO, "dashboard/todos.js"));
require(path.join(REPO, "dashboard/issues.js"));

var Board = global.OpsDashBoard;
var Todos = global.OpsDashTodos;
var Issues = global.OpsDashIssues;
var Events = global.OpsDashEvents;
var CFG = global.OpsDashConfig;

CFG.todayISO = function () { return "2026-08-28"; };
global.localStorage.setItem(CFG.ACTOR_STORAGE_KEY, "Ana");

/* ---- count every write, at the network boundary ---- */
var createTaskCalls = 0;
var postEventCalls = [];

global.fetch = function () {
  createTaskCalls++;
  return Promise.resolve({
    text: function () {
      return Promise.resolve(JSON.stringify({ ok: true, id: "T-0001", verified: true }));
    }
  });
};
Events.postEvent = function (action, taskId) {
  postEventCalls.push(action + ":" + taskId);
  return Promise.resolve({ ok: true, event: { timestamp: "2026-08-28T10:00:00-04:00" } });
};
Events.fetchEvents = function () { return Promise.resolve([]); };

var PLAN = {
  schemaVersion: "1.0",
  sprint: { id: "S-WK", start: "2026-08-01", end: "2026-10-01" },
  people: ["Ana", "Beto"],
  rocks: [{
    id: "R1", name: "Rock", owners: ["Ana"], cuttable: false,
    projects: [{
      id: "P1", name: "Project", owner: "Ana",
      milestones: [{
        id: "M1", name: "Milestone", dependsOn: [],
        tasks: [{ id: "T1", desc: "one", owner: "Ana", type: "work", workDays: 1,
                  waitDays: 0, dependsOn: [], crossDependsOn: [] }]
      }]
    }]
  }]
};

var PEOPLE = [{ name: "Ana", active: true }, { name: "Beto", active: true }];
var FOLDED = Events.fold([["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"]]);

/* Mount all three, exactly as app.js does — board first, then todos, then
   issues. This is the arrangement that shipped broken. */
Board.mount({
  plan: PLAN, frozenPlan: global.OpsDashEngine.planMode(PLAN), currentState: {},
  deliverables: {}, pins: {}, people: PEOPLE, band: 1, opsWeekStartDay: "Friday"
});
Todos.mount({
  plan: PLAN, currentState: {}, deliverables: {}, pins: {}, pinEvents: {},
  discards: {}, cancels: {}, tasks: {}, people: PEOPLE,
  opsWeekStartDay: "Friday", folded: FOLDED
});
Issues.mount({
  issues: { "I-0001": { id: "I-0001", sprintId: "S-WK", title: "t", desc: "",
                        raisedBy: "Ana", raisedAt: "2026-08-10T09:00:00-04:00" } },
  tasks: {}, currentState: {}, resolutions: {}, people: PEOPLE,
  opsWeekStartDay: "Friday", folded: FOLDED
});

/* ================= the invariant ================= */
console.log("\n=== exactly one view listens to #main ===\n");

check("mounting three views does NOT stack three click listeners on #main",
  MAIN.listenerCount("click") <= 1, MAIN.listenerCount("click") + " click listeners");
check("...nor three change listeners",
  MAIN.listenerCount("change") <= 1, MAIN.listenerCount("change") + " change listeners");

/**
 * Switch views through BOARD.JS's own coordinator, not by calling setActive
 * by hand — the coordinator is the thing under test. board.js picks up the
 * view from localStorage at mount and calls setActiveViewListeners() from
 * render(), so re-mounting is how this harness drives a view switch.
 */
function showView(view) {
  global.localStorage.setItem(CFG.VIEW_STORAGE_KEY, view);
  Board.mount({
    plan: PLAN, frozenPlan: global.OpsDashEngine.planMode(PLAN), currentState: {},
    deliverables: {}, pins: {}, people: PEOPLE, band: 1, opsWeekStartDay: "Friday"
  });
  return { click: MAIN.listenerCount("click"), change: MAIN.listenerCount("change") };
}

var onBoard = showView("board");
check("with the Sprint Board active, exactly one click listener is attached",
  onBoard.click === 1, JSON.stringify(onBoard));

var onTodos = showView("todos");
check("switching to To-dos still leaves exactly one click listener",
  onTodos.click === 1, JSON.stringify(onTodos));
check("...and one change listener", onTodos.change === 1, JSON.stringify(onTodos));

var onIssues = showView("issues");
check("switching to Issues leaves exactly one click listener, not two",
  onIssues.click === 1, JSON.stringify(onIssues));

/* Idempotence: the property that makes calling this from render() safe.
   Each showView() runs mount → render → setActiveViewListeners again. */
showView("issues"); showView("issues"); showView("issues");
check("re-entering the same view repeatedly cannot stack listeners",
  MAIN.listenerCount("click") === 1, MAIN.listenerCount("click") + " click listeners");

Issues.setActive(false); Issues.setActive(false);
check("deactivating twice is harmless", MAIN.listenerCount("click") === 0,
  MAIN.listenerCount("click") + " click listeners");

/* ================= ONE CLICK, ONE WRITE ================= */
console.log("\n=== one click on Add produces exactly ONE createTask ===\n");

/* Build the shared ad-hoc form the way issues.js renders it: the SAME
   data-action todos.js owns, which is the collision. */
function buildAdHocForm(sourceIssueId) {
  var form = new FakeEl({ "data-person": "Ana", "data-week": "2026-08-31",
                          "data-source-issue-id": sourceIssueId }, "todo-adhoc-form");
  var desc = new FakeEl({}, "todo-adhoc-desc"); desc.value = "From the issue";
  var owner = new FakeEl({}, "todo-adhoc-owner"); owner.value = "Ana";
  var days = new FakeEl({}, "todo-adhoc-workdays"); days.value = "1";
  var deadline = new FakeEl({}, "todo-adhoc-deadline"); deadline.value = "";
  var addBtn = new FakeEl({ "data-action": "todo-add-adhoc", "data-person": "Ana" }, "todo-action-btn");
  [desc, owner, days, deadline, addBtn].forEach(function (c) { form.appendChild(c); });
  MAIN.children.length = 0;
  MAIN.appendChild(form);
  return addBtn;
}

/* Both views' handlers exist; only Issues is active, as when the person is
   looking at the Issues screen. */
Todos.setActive(false);
Issues.setActive(true);

createTaskCalls = 0;
var addBtn = buildAdHocForm("I-0001");
MAIN.dispatch("click", addBtn);

check("ONE click on Add fires ONE createTask, not two",
  createTaskCalls === 1, createTaskCalls + " createTask calls");

/* The same click with the OLD arrangement — both listeners attached — is
   what shipped. Prove this test would have caught it. */
createTaskCalls = 0;
Todos.setActive(true);   // deliberately wrong: two views listening at once
Issues.setActive(true);
var addBtn2 = buildAdHocForm("I-0001");
MAIN.dispatch("click", addBtn2);
check("SANITY: with both views listening, the same click doubles — the bug " +
  "this test exists to catch is reproducible here",
  createTaskCalls === 2, createTaskCalls + " createTask calls");

/* Back to the enforced arrangement. */
Todos.setActive(false);
Issues.setActive(true);
createTaskCalls = 0;
var addBtn3 = buildAdHocForm("I-0001");
MAIN.dispatch("click", addBtn3);
check("...and restoring the invariant restores one-click-one-write",
  createTaskCalls === 1, createTaskCalls + " createTask calls");

/* ================= the inactive view is inert ================= */
console.log("\n=== an inactive view cannot respond to ANY action ===\n");

/* Not just todo-add-adhoc: the point of fixing this structurally is that a
   view which is not on screen answers nothing, whatever it is named. */
Issues.setActive(false);
Todos.setActive(true);
postEventCalls = [];
var resolveBtn = new FakeEl({ "data-action": "issue-resolve", "data-issue-id": "I-0001" }, "todo-action-btn");
MAIN.children.length = 0;
MAIN.appendChild(resolveBtn);
MAIN.dispatch("click", resolveBtn);
check("an issue action is ignored while To-dos is the active view",
  postEventCalls.length === 0, JSON.stringify(postEventCalls));

Todos.setActive(false);
Issues.setActive(true);
postEventCalls = [];
var postponeBtn = new FakeEl({ "data-action": "todo-postpone", "data-task-id": "T-0001" }, "todo-action-btn");
MAIN.children.length = 0;
MAIN.appendChild(postponeBtn);
MAIN.dispatch("click", postponeBtn);
check("a to-do action is ignored while Issues is the active view",
  postEventCalls.length === 0, JSON.stringify(postEventCalls));

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
