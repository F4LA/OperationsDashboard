#!/usr/bin/env node
/**
 * Issues view (§13, D-096) — the pure decisions behind the view, without a DOM.
 *
 *     node tests/issues.test.js
 *
 * Two things carry the weight here:
 *
 *   - the OPEN LIST ORDER. §13.3 makes age the entire ordering rule
 *     (D-096c rejected manual priority), so "oldest first" is not cosmetic —
 *     it IS the prioritisation, and a regression in it silently reorders the
 *     meeting.
 *   - §13.4's FOLLOW-THROUGH flag. This is the case that disappears today: an
 *     issue closed as todo_created whose to-dos never got done. It is also the
 *     only reader of sourceIssueId, so if it breaks, that field goes back to
 *     being written by the server and read by nobody — the exact defect D-080
 *     found with the Tasks tab.
 *
 * Same harness discipline as tests/todo-week-mode.test.js: stub the two
 * globals the module touches at mount, and pin "today" through
 * OpsDashConfig.todayISO so no assertion depends on the real clock (D-027).
 *
 * NOTE: like todos.js, issues.js is a SINGLETON — _internals closes over one
 * shared `state`, so every mount replaces the last. Read what you need
 * immediately after mounting; snapshot() below does exactly that.
 */
"use strict";

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
require(path.join(REPO, "dashboard/issues.js"));

var Issues = global.OpsDashIssues;
var Events = global.OpsDashEvents;
var CFG = global.OpsDashConfig;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

var TODAY = "2026-08-28";

var HEADER = ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"];
function ev(id, taskId, action, value, ts, note) {
  return [id, "S-WK", taskId, action, value, "Bernardo", ts, note === undefined ? "" : note];
}

function issue(id, title, raisedAt, desc) {
  return { id: id, sprintId: "S-WK", title: title, desc: desc || "", raisedBy: "Bernardo",
           raisedAt: raisedAt };
}

function adhoc(id, sourceIssueId, desc) {
  return { id: id, desc: desc || id, owner: "Ana", workDays: 1, deadline: "",
           sourceIssueId: sourceIssueId || "", createdBy: "Bernardo", createdAt: "2026-08-01" };
}

/**
 * Mount with a set of issues, ad-hoc tasks, event rows and statuses, then
 * read everything the caller needs while that mount is still the live one.
 */
function snapshot(opts) {
  CFG.todayISO = function () { return opts.today || TODAY; };

  var rows = [HEADER].concat(opts.eventRows || []);
  var folded = Events.fold(rows);

  var issuesMap = {};
  (opts.issues || []).forEach(function (i) { issuesMap[i.id] = i; });
  var tasksMap = {};
  (opts.tasks || []).forEach(function (t) { tasksMap[t.id] = t; });

  Issues.mount({
    issues: issuesMap,
    tasks: tasksMap,
    currentState: Events.toCurrentState(folded),
    resolutions: Events.issueResolutions(folded),
    people: [{ name: "Ana", active: true }, { name: "Beto", active: true }],
    opsWeekStartDay: "Friday",
    folded: folded
  });

  var I = Issues._internals;
  return {
    openIds: I.openIssuesOldestFirst().map(function (i) { return i.id; }),
    resolvedIds: I.resolvedIssuesNewestFirst().map(function (i) { return i.id; }),
    followUp: function (id) { return I.followUp(id); },
    todosOf: function (id) { return I.todosOfIssue(id); },
    age: function (id) { return I.ageInDays(issuesMap[id]); },
    ageLabel: I.ageLabel,
    isResolved: function (id) { return I.isResolved(id); },
    resolutionOf: function (id) { return I.resolutionOf(id); },
    weeksSince: I.weeksSince,
    targetWeek: I.targetWeek(),
    openHtml: function (id) { return I.openIssueHtml(issuesMap[id]); },
    resolvedHtml: function (id) { return I.resolvedIssueHtml(issuesMap[id]); },
    followUpHtml: function (id) { return I.followUpHtml(id); }
  };
}

/* ================= ORDER: oldest first is the whole rule ================= */
console.log("\n=== the open list is ordered by age, oldest first (§13.3, D-096c) ===\n");

var ordered = snapshot({
  issues: [
    issue("I-0002", "middle", "2026-08-20T10:00:00-04:00"),
    issue("I-0001", "newest", "2026-08-27T10:00:00-04:00"),
    issue("I-0003", "oldest", "2026-08-07T10:00:00-04:00")
  ]
});
check("the oldest issue is first and the newest is last, regardless of id order",
  ordered.openIds.join(",") === "I-0003,I-0002,I-0001", ordered.openIds.join(","));

// The age shown is what justifies that position, so it has to be right.
check("age is counted in whole days from raisedAt to today",
  ordered.age("I-0003") === 21, String(ordered.age("I-0003")));
check("a three-week-old issue reaches the top on its own — no manual rank needed",
  ordered.openIds[0] === "I-0003" && ordered.age("I-0003") === 21);

check("age reads 'today' on the day it was raised",
  ordered.ageLabel(0) === "today", ordered.ageLabel(0));
check("age is singular at one day", ordered.ageLabel(1) === "1 day", ordered.ageLabel(1));
check("age is plural beyond that", ordered.ageLabel(21) === "21 days", ordered.ageLabel(21));
check("an unparseable raisedAt yields null, NOT 0 — a zero-day age would read " +
  "as 'raised today' on corrupt data", ordered.ageLabel(null) === null);

var tied = snapshot({
  issues: [
    issue("I-0009", "b", "2026-08-20T10:00:00-04:00"),
    issue("I-0004", "a", "2026-08-20T10:00:00-04:00")
  ]
});
check("issues raised at the same instant fall back to id, so the order is total",
  tied.openIds.join(",") === "I-0004,I-0009", tied.openIds.join(","));

/* ================= open vs resolved comes from the fold ================= */
console.log("\n=== open/resolved is event state, never a column (§13.1) ===\n");

var withRes = snapshot({
  issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00"),
           issue("I-0002", "two", "2026-08-11T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "discussed_no_action", "2026-08-21T10:00:00-04:00")
  ]
});
check("a resolved issue leaves the open list", withRes.openIds.join(",") === "I-0002",
  withRes.openIds.join(","));
check("...and appears in the resolved list", withRes.resolvedIds.join(",") === "I-0001",
  withRes.resolvedIds.join(","));
check("the resolution itself is carried through the fold",
  withRes.resolutionOf("I-0001") === "discussed_no_action", withRes.resolutionOf("I-0001"));

var reopened = snapshot({
  issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "todo_created", "2026-08-21T10:00:00-04:00"),
    ev("E2", "I-0001", "unresolveIssue", "", "2026-08-22T10:00:00-04:00")
  ]
});
check("unresolveIssue reopens it — the D-069 pair folds like discard/undiscard",
  reopened.openIds.join(",") === "I-0001" && reopened.resolvedIds.length === 0,
  JSON.stringify({ open: reopened.openIds, resolved: reopened.resolvedIds }));
check("...and it carries no resolution once reopened",
  reopened.resolutionOf("I-0001") === null, String(reopened.resolutionOf("I-0001")));

var reResolved = snapshot({
  issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "todo_created", "2026-08-21T10:00:00-04:00"),
    ev("E2", "I-0001", "unresolveIssue", "", "2026-08-22T10:00:00-04:00"),
    ev("E3", "I-0001", "resolveIssue", "discussed_no_action", "2026-08-23T10:00:00-04:00")
  ]
});
check("resolving again after a reopen wins, and the LATEST resolution is the one kept",
  reResolved.resolutionOf("I-0001") === "discussed_no_action",
  String(reResolved.resolutionOf("I-0001")));

/* ================= the sourceIssueId join (§13.4's data) ================= */
console.log("\n=== to-dos generated from an issue (the sourceIssueId join) ===\n");

var joined = snapshot({
  issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00")],
  tasks: [adhoc("T-0001", "I-0001"), adhoc("T-0002", "I-0001"),
          adhoc("T-0003", ""), adhoc("T-0004", "I-0009")]
});
check("only the to-dos pointing at THIS issue are joined to it",
  joined.todosOf("I-0001").map(function (t) { return t.id; }).join(",") === "T-0001,T-0002",
  JSON.stringify(joined.todosOf("I-0001")));
check("an unlinked ad-hoc task belongs to no issue",
  joined.todosOf("").length === 0);
check("a to-do's status comes from the event fold, defaulting to open",
  joined.todosOf("I-0001")[0].status === "open", joined.todosOf("I-0001")[0].status);

/* ================= §13.4 FOLLOW-THROUGH ================= */
console.log("\n=== §13.4: a resolved issue is not finished work ===\n");

/* Resolved todo_created three weeks ago, one of two to-dos still open. */
var chase = snapshot({
  issues: [issue("I-0001", "one", "2026-08-01T10:00:00-04:00")],
  tasks: [adhoc("T-0001", "I-0001"), adhoc("T-0002", "I-0001")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "todo_created", "2026-08-07T10:00:00-04:00"),
    ev("E2", "T-0001", "setStatus", "done", "2026-08-10T10:00:00-04:00")
  ]
});
var f = chase.followUp("I-0001");
check("an issue closed as todo_created with an unfinished to-do IS flagged",
  f !== null, JSON.stringify(f));
check("...counting exactly the ones still open", f && f.openCount === 1 && f.total === 2,
  JSON.stringify(f));
check("...and saying how many WEEKS ago it was resolved", f && f.weeks === 3,
  JSON.stringify(f));
check("the rendered flag names both halves",
  chase.followUpHtml("I-0001").indexOf("3 weeks ago") !== -1 &&
  chase.followUpHtml("I-0001").indexOf("1 of 2") !== -1,
  chase.followUpHtml("I-0001"));

/* All to-dos done — nothing to chase. */
var clean = snapshot({
  issues: [issue("I-0001", "one", "2026-08-01T10:00:00-04:00")],
  tasks: [adhoc("T-0001", "I-0001"), adhoc("T-0002", "I-0001")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "todo_created", "2026-08-07T10:00:00-04:00"),
    ev("E2", "T-0001", "setStatus", "done", "2026-08-10T10:00:00-04:00"),
    ev("E3", "T-0002", "setStatus", "done", "2026-08-11T10:00:00-04:00")
  ]
});
check("an issue whose to-dos are ALL done is NOT flagged",
  clean.followUp("I-0001") === null, JSON.stringify(clean.followUp("I-0001")));
check("...and renders no flag at all", clean.followUpHtml("I-0001") === "",
  clean.followUpHtml("I-0001"));

/* discussed_no_action produced no work by definition. */
var noAction = snapshot({
  issues: [issue("I-0001", "one", "2026-08-01T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "discussed_no_action", "2026-08-07T10:00:00-04:00")
  ]
});
check("an issue closed as discussed_no_action is never flagged — it promised nothing",
  noAction.followUp("I-0001") === null, JSON.stringify(noAction.followUp("I-0001")));

/* todo_created but nothing was ever created: the promise broken one step earlier. */
var promised = snapshot({
  issues: [issue("I-0001", "one", "2026-08-01T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "todo_created", "2026-08-14T10:00:00-04:00")
  ]
});
var pf = promised.followUp("I-0001");
check("closed as todo_created with NO to-do at all is flagged, not treated as complete",
  pf !== null && pf.none === true, JSON.stringify(pf));
check("...and says so in its own words rather than '0 of 0'",
  promised.followUpHtml("I-0001").indexOf("no to-do was ever created") !== -1,
  promised.followUpHtml("I-0001"));

/* An OPEN issue is never followed up — it has not promised anything yet. */
var stillOpen = snapshot({
  issues: [issue("I-0001", "one", "2026-08-01T10:00:00-04:00")],
  tasks: [adhoc("T-0001", "I-0001")]
});
check("an OPEN issue is never flagged, however old its to-dos are",
  stillOpen.followUp("I-0001") === null, JSON.stringify(stillOpen.followUp("I-0001")));

check("weeksSince floors to whole weeks (6 days is still 0 weeks ago)",
  chase.weeksSince("2026-08-22T10:00:00-04:00") === 0,
  String(chase.weeksSince("2026-08-22T10:00:00-04:00")));

/* ================= the resolve control is gated (§13.3) ================= */
console.log("\n=== resolving requires choosing how it closed (§13.3) ===\n");

var gate = snapshot({ issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00")] });
var html = gate.openHtml("I-0001");
// Not expanded, so the control is not rendered yet; expand it via state.
Issues._internals.getState().expanded["I-0001"] = true;
html = Issues._internals.openIssueHtml({ id: "I-0001", title: "one",
  raisedBy: "Bernardo", raisedAt: "2026-08-10T10:00:00-04:00", desc: "" });

check("the Resolve button starts DISABLED — no resolution chosen yet",
  /data-action="issue-resolve"[^>]*disabled/.test(html), html);
check("both resolutions are offered, and only those two",
  html.indexOf("discussed_no_action") !== -1 && html.indexOf("todo_created") !== -1);
check("creating a to-do is offered separately from resolving (D-096b)",
  html.indexOf('data-action="issue-create-todo-open"') !== -1 &&
  html.indexOf('data-action="issue-resolve"') !== -1, html);

Issues._internals.getState().resolveChoice["I-0001"] = "todo_created";
var chosenHtml = Issues._internals.openIssueHtml({ id: "I-0001", title: "one",
  raisedBy: "Bernardo", raisedAt: "2026-08-10T10:00:00-04:00", desc: "" });
check("once a resolution is chosen the button is enabled",
  !/data-action="issue-resolve"[^>]*disabled/.test(chosenHtml), chosenHtml);

/* ================= resolved section keeps its Undo (D-069) ================= */
console.log("\n=== a closed thing does not vanish (D-069) ===\n");

// Re-mounted deliberately: `withRes` was created several mounts ago and the
// singleton has moved on since, so its resolvedHtml() closure would render
// against whatever state is live now. This is the trap the header warns about.
var undoSnap = snapshot({
  issues: [issue("I-0001", "one", "2026-08-10T10:00:00-04:00")],
  eventRows: [
    ev("E1", "I-0001", "resolveIssue", "discussed_no_action", "2026-08-21T10:00:00-04:00")
  ]
});
var undoHtml = undoSnap.resolvedHtml("I-0001");
check("a resolved issue stays visible with an Undo",
  undoHtml.indexOf('data-action="issue-unresolve"') !== -1, undoHtml);
check("...showing the resolution it closed with",
  undoHtml.indexOf("Discussed, no action") !== -1, undoHtml);

/* ================= the week a generated to-do lands in ================= */
console.log("\n=== the target week for a to-do created from an issue ===\n");

// §13 does not answer this (reported as an open question); the view picks
// the CURRENT ops week. The assertion pins the choice so it cannot drift
// silently: today is Friday 2026-08-28, which IS an ops-week start day.
check("a to-do created from an issue targets the CURRENT ops week",
  chase.targetWeek.start === "2026-08-28", JSON.stringify(chase.targetWeek));
check("...and that week's Monday key is what gets written as the pin",
  chase.targetWeek.mondayKey === "2026-08-31", chase.targetWeek.mondayKey);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
