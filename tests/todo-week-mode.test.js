#!/usr/bin/env node
/**
 * To-dos week selector + mode (§11.1, D-092) — the pure decisions behind the
 * view, verified without a DOM.
 *
 * The centrepiece is the DEFECT TEST: the ops week runs Friday→Thursday and
 * the L10 is Friday, so on Friday the offset-0 window is the week that opens
 * THAT DAY — the one step 8 must build. The retired code tied BUILD to
 * offset +1, which on a Friday is the week opening the FOLLOWING Friday, so
 * the only loading form on screen pointed seven days past the week being
 * planned. Anchoring the mode to confirmWeek is what removes it, and
 * "on the ops week's start day, the offset-0 week is in BUILD mode" is the
 * assertion that would fail if anyone reintroduced a position-derived mode.
 *
 *     node tests/todo-week-mode.test.js
 *
 * todos.js is a browser module, so this stubs the two globals it touches at
 * mount (document, localStorage) and overrides OpsDashConfig.todayISO to pin
 * "today" — the same discipline D-027 fixed for the engine: never let a test
 * depend on the real clock.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var REPO = path.resolve(__dirname, "..");

/* ---- minimal browser surface, enough for mount() ---- */
var noopEl = {
  addEventListener: function () {},
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  appendChild: function () {},
  innerHTML: ""
};
global.window = global;
global.document = {
  getElementById: function () { return noopEl; },
  createElement: function () { return { classList: { add: function () {}, remove: function () {} } }; }
};
global.localStorage = {
  _v: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setItem: function (k, v) { this._v[k] = String(v); },
  removeItem: function (k) { delete this._v[k]; }
};

require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/events.js"));
require(path.join(REPO, "dashboard/metrics.js"));
require(path.join(REPO, "dashboard/thisweek.js"));
require(path.join(REPO, "dashboard/todos.js"));

var Todos = global.OpsDashTodos;
var Events = global.OpsDashEvents;
var CFG = global.OpsDashConfig;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

/* ---- fixtures ---- */

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
        tasks: [
          { id: "T1", desc: "one", owner: "Ana", type: "work", workDays: 1, waitDays: 0,
            dependsOn: [], crossDependsOn: [] },
          { id: "T2", desc: "two", owner: "Beto", type: "work", workDays: 1, waitDays: 0,
            dependsOn: [], crossDependsOn: [] }
        ]
      }]
    }]
  }]
};

var HEADER = ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"];
function ev(id, task, action, value, ts, note) {
  return [id, "S-WK", task, action, value, "Ana", ts, note === undefined ? "" : note];
}

/** Mount the view with "today" pinned and an optional list of confirmed
 *  Monday keys, then hand back its internals. */
/**
 * NOTE: todos.js is a singleton module — _internals closes over ONE shared
 * `state`, so every mount replaces the last. Callers must therefore read the
 * values they need immediately after mounting and never hold an internals
 * reference across a later mount. `snapshot()` below does exactly that.
 */
function mountAt(todayISO, confirmedMondays, pins) {
  CFG.todayISO = function () { return todayISO; };

  var rows = [HEADER];
  (confirmedMondays || []).forEach(function (monday, i) {
    rows.push(ev("E-C" + i, "WEEK-" + monday, "confirmWeek", monday,
      "2026-08-01T10:00:00-04:00", "[]"));
  });
  (pins || []).forEach(function (p, i) {
    rows.push(ev("E-P" + i, p.taskId, "pin", p.monday, "2026-08-01T11:00:00-04:00"));
  });

  var folded = Events.fold(rows);

  Todos.mount({
    plan: PLAN,
    currentState: Events.toCurrentState(folded),
    deliverables: {},
    pins: Events.pins(folded),
    pinEvents: Events.pinEvents(folded),
    discards: {},
    cancels: {},
    tasks: {},
    people: PLAN.people.map(function (n) { return { name: n, active: true }; }),
    opsWeekStartDay: "Friday",
    folded: folded
  });

  return Todos._internals;
}

/** Mount, then read everything this test needs while that mount is still the
 *  live one — the singleton makes any later read unsafe. */
function snapshot(todayISO, confirmedMondays, pins) {
  var I = mountAt(todayISO, confirmedMondays, pins);
  var wins = { "-1": I.windowAt(-1), "0": I.windowAt(0), "1": I.windowAt(1) };
  return {
    win: function (o) { return wins[String(o)]; },
    mode: function (o) { return I.weekModeFor(wins[String(o)]); },
    label: function (o) { return I.formatWindowRange(wins[String(o)]); },
    hasEnded: function (o) { return I.weekHasEnded(wins[String(o)]); },
    defaultOffset: I.defaultWeekOffset(),
    positions: I.WEEK_POSITIONS,
    committed: function (person, o) { return I.committedIdsForPerson(person, wins[String(o)]); },
    liveTasks: Object.keys(I.getState().liveResult.tasks),
    card: function (person, o) {
      var win = wins[String(o)];
      return I.cardHtml(person, win, I.weekModeFor(win));
    }
  };
}

/* Real weekday anchors, verified against the calendar:
     2026-08-26 is a Wednesday
     2026-08-28 is a Friday  <- the ops week's start day */
var WED = "2026-08-26";
var FRI = "2026-08-28";

/* ================= THE DEFECT (D-092) ================= */
console.log("\n=== the Friday defect: the week that opens today must be buildable ===\n");

var fri = snapshot(FRI, []);

check("on Friday, the offset-0 window is the week that STARTS that Friday",
  fri.win(0).start === FRI, JSON.stringify(fri.win(0)));
check("on Friday, offset +1 is the week starting the FOLLOWING Friday (7 days out)",
  fri.win(1).start === "2026-09-04", JSON.stringify(fri.win(1)));

check("THE FIX: on Friday, the week opening that day is in BUILD mode",
  fri.mode(0) === "build", fri.mode(0));
check("...and it is NOT review, which is what the old position-derived rule gave it",
  fri.mode(0) !== "review");
check("the week that already ended is review", fri.mode(-1) === "review", fri.mode(-1));

/* The mode must not come from the position: the SAME window seen from two
   different positions on two different days must give the same answer. */
var wed = snapshot(WED, []);
check("the same window is 'Next week' on Wednesday and 'Current' on Friday",
  wed.win(1).start === fri.win(0).start && wed.win(1).end === fri.win(0).end,
  JSON.stringify({ wedNext: wed.win(1), friCurrent: fri.win(0) }));
check("...and gets the SAME mode either way — position never decides it",
  wed.mode(1) === fri.mode(0), wed.mode(1) + " vs " + fri.mode(0));

/* ================= mode comes from confirmWeek ================= */
console.log("\n=== mode is decided by confirmation, not the calendar ===\n");

check("an unconfirmed, still-running week is BUILD", wed.mode(0) === "build", wed.mode(0));

var curMonday = wed.win(0).mondayKey;
var wedConfirmed = snapshot(WED, [curMonday]);
check("the SAME week, once confirmed, is EXECUTE",
  wedConfirmed.mode(0) === "execute", wedConfirmed.mode(0));
check("confirming changed the mode with no change to the date or the position",
  wedConfirmed.win(0).start === wed.win(0).start);

check("a week that has already ended is REVIEW even when it was never confirmed",
  wed.mode(-1) === "review");

var closedConfirmed = snapshot(WED, [wed.win(-1).mondayKey]);
check("...and REVIEW even when it WAS confirmed — ended beats confirmed",
  closedConfirmed.mode(-1) === "review", closedConfirmed.mode(-1));

var nextConfirmed = snapshot(WED, [wed.win(1).mondayKey]);
check("a FUTURE week that is already confirmed is EXECUTE, not build",
  nextConfirmed.mode(1) === "execute", nextConfirmed.mode(1));

/* weekHasEnded is a property of the week's own dates, not of the offset. */
check("weekHasEnded is true only once the window's end is behind today",
  wed.hasEnded(-1) === true && wed.hasEnded(0) === false && wed.hasEnded(1) === false,
  JSON.stringify([wed.hasEnded(-1), wed.hasEnded(0), wed.hasEnded(1)]));

var atLastDay = snapshot(wed.win(0).end, []);
check("a window whose LAST day is today has not ended yet",
  atLastDay.hasEnded(0) === false && atLastDay.mode(0) !== "review",
  atLastDay.mode(0));

/* ================= the three labels carry their window ================= */
console.log("\n=== selector labels show label AND window (§11.1) ===\n");

check("the three positions are Closed / Current / Next week, in order",
  wed.positions.map(function (p) { return p.label; }).join(",") === "Closed,Current,Next week",
  JSON.stringify(wed.positions));
check('"Opening" is gone as a label (D-092 discards the name)',
  wed.positions.every(function (p) { return p.label !== "Opening"; }));
check('"Closing" is gone too — on Friday that week has already closed',
  wed.positions.every(function (p) { return p.label !== "Closing"; }));

/* Wednesday the 26th */
check("Wednesday: Closed reads Aug 14–20", wed.label(-1) === "Aug 14–20", wed.label(-1));
check("Wednesday: Current reads Aug 21–27", wed.label(0) === "Aug 21–27", wed.label(0));
check("Wednesday: Next week reads Aug 28 – Sep 3, spelling both months",
  wed.label(1) === "Aug 28 – Sep 3", wed.label(1));

/* Friday the 28th — every position has shifted by one week */
check("Friday: Closed reads Aug 21–27", fri.label(-1) === "Aug 21–27", fri.label(-1));
check("Friday: Current reads Aug 28 – Sep 3", fri.label(0) === "Aug 28 – Sep 3", fri.label(0));
check("Friday: Next week reads Sep 4–10", fri.label(1) === "Sep 4–10", fri.label(1));

/* The anchor property that makes advance loading safe: the window printed for
   "Next week" on Thursday night is the SAME text as "Current" the next
   morning, so the person recognises the week they loaded. */
check("the window text is identical across the Thursday-night / Friday-morning handover",
  wed.label(1) === fri.label(0), wed.label(1) + " vs " + fri.label(0));

/* ================= default position (§11.1, D-081c) ================= */
console.log("\n=== default position on open ===\n");

check("on the ops week's start day (Friday) the default is Closed (-1)",
  fri.defaultOffset === -1, fri.defaultOffset);
check("on any other day (Wednesday) the default is Current (0)",
  wed.defaultOffset === 0, wed.defaultOffset);

/* ================= the week opens empty (D-091) ================= */
console.log("\n=== the week opens empty; only a pin commits (D-091) ===\n");

check("with nothing pinned, nobody has anything committed to the opening week",
  wed.committed("Ana", 1).length === 0 && wed.committed("Beto", 1).length === 0,
  JSON.stringify(wed.committed("Ana", 1)));

var openingMonday = wed.win(1).mondayKey;
var pinned = snapshot(WED, [], [{ taskId: "T1", monday: openingMonday }]);
check("a task pinned to that week IS committed, to its owner only",
  pinned.committed("Ana", 1).join(",") === "T1" && pinned.committed("Beto", 1).length === 0,
  JSON.stringify({ ana: pinned.committed("Ana", 1), beto: pinned.committed("Beto", 1) }));
check("a pin to a DIFFERENT week does not commit it to this one",
  pinned.committed("Ana", 0).length === 0, JSON.stringify(pinned.committed("Ana", 0)));

/* The engine still projects T1/T2 somewhere; that projection must no longer
   put anything into the commitment on its own — the whole point of D-091. */
check("the engine does project the tasks (so the emptiness is not an empty plan)",
  wed.liveTasks.length === 2, wed.liveTasks.join(","));
check("...yet the committed set is still empty — projection no longer pre-fills",
  wed.committed("Ana", 0).length === 0 && wed.committed("Beto", 0).length === 0,
  JSON.stringify(wed.committed("Ana", 0)));

/* ================= remove-your-own-addition (D-095) ================= */
console.log("\n=== build mode restores 'remove' as undo-your-own-addition (D-095) ===\n");

var openingKey = wed.win(1).mondayKey;
var withPin = snapshot(WED, [], [{ taskId: "T1", monday: openingKey }]);

check("a task pinned in the unconfirmed (build) week shows the Remove action",
  withPin.card("Ana", 1).indexOf('data-action="todo-unpin-build"') !== -1,
  withPin.card("Ana", 1));
check("its label reads as undoing an addition, not rejecting a system proposal",
  withPin.card("Ana", 1).indexOf("undo this addition") !== -1);
check("a person with nothing pinned there gets no Remove button",
  withPin.card("Beto", 1).indexOf('data-action="todo-unpin-build"') === -1,
  withPin.card("Beto", 1));

var curKey = wed.win(0).mondayKey;
var confirmedWithPin = snapshot(WED, [curKey], [{ taskId: "T1", monday: curKey }]);
check("once the week is CONFIRMED (execute mode), Remove is gone",
  confirmedWithPin.card("Ana", 0).indexOf('data-action="todo-unpin-build"') === -1,
  confirmedWithPin.card("Ana", 0));
check("...move/discard/cancel are the way to change a confirmed commitment instead",
  confirmedWithPin.card("Ana", 0).indexOf('data-action="todo-postpone"') !== -1);

var endedKey = wed.win(-1).mondayKey;
var closedWithPin = snapshot(WED, [], [{ taskId: "T1", monday: endedKey }]);
check("a CLOSED week (ended, never confirmed) also has no Remove — it is review, not build",
  closedWithPin.card("Ana", -1).indexOf('data-action="todo-unpin-build"') === -1,
  closedWithPin.card("Ana", -1));

check("no reason/mandatory-note UI is attached to the Remove action itself",
  withPin.card("Ana", 1).indexOf('data-action="todo-discard-open"') === -1 &&
  withPin.card("Ana", 1).indexOf('data-action="todo-cancel-open"') === -1);

/* ================= ad-hoc form limited to non-closed weeks (D-094) ================= */
console.log("\n=== ad-hoc creation is un-gated from build, but NOT offered on a closed week (D-094) ===\n");

check("build mode (unconfirmed, running week) offers the ad-hoc form",
  withPin.card("Ana", 1).indexOf("todo-adhoc-form") !== -1);
check("execute mode (confirmed, running week) ALSO offers it — unplanned work on a Tuesday",
  confirmedWithPin.card("Ana", 0).indexOf("todo-adhoc-form") !== -1);
check("review mode (a week that has ENDED) does NOT offer it",
  closedWithPin.card("Ana", -1).indexOf("todo-adhoc-form") === -1,
  closedWithPin.card("Ana", -1));
check("...even when that closed week was never confirmed",
  wed.mode(-1) === "review" && wed.card("Ana", -1).indexOf("todo-adhoc-form") === -1);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
