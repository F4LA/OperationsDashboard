#!/usr/bin/env node
/**
 * OpsDashThisWeek — unit test (Phase 7, D-022 convention: plain Node, no
 * framework). D-061 (opsWeek) is exercised against a hand-computed calendar
 * table (built with plain Date.UTC arithmetic here in the TEST — never in
 * the app source, per D-027's discipline); D-063(a/b/e) against small,
 * isolated fixtures, the same style burnup.test.js uses.
 *
 *     node tests/thisweek.test.js
 */
"use strict";

var path = require("path");
var REPO = path.resolve(__dirname, "..");

global.window = global; // config.js/engine.js/validate.js/thisweek.js attach to `window`
require(path.join(REPO, "dashboard/config.js"));
require(path.join(REPO, "dashboard/validate.js"));
require(path.join(REPO, "dashboard/engine.js"));
require(path.join(REPO, "dashboard/thisweek.js"));
var ThisWeek = global.OpsDashThisWeek;

var failures = 0;
var passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

var DAY_MS = 86400000;
function isoOf(ms) {
  var d = new Date(ms);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

/* ================= opsWeek (D-061) ================= */
console.log("\n=== opsWeek — one today per weekday, startDayName \"Friday\" ===\n");

// 2026-08-07 is a real Friday; walk all 7 days from there (Fri..Thu).
var FRI_MS = Date.UTC(2026, 7, 7);
for (var i = 0; i < 7; i++) {
  var todayMs = FRI_MS + i * DAY_MS;
  var todayISO = isoOf(todayMs);
  var win = ThisWeek.opsWeek(todayISO, "Friday");

  var expectedStart = isoOf(FRI_MS);
  var expectedEnd = isoOf(FRI_MS + 6 * DAY_MS);
  var expectedMonday = isoOf(FRI_MS + 3 * DAY_MS); // Friday + 3 = Monday

  check("today=" + todayISO + " -> start=" + expectedStart,
    win.start === expectedStart, JSON.stringify(win));
  check("today=" + todayISO + " -> end=" + expectedEnd,
    win.end === expectedEnd, JSON.stringify(win));
  check("today=" + todayISO + " -> mondayKey=" + expectedMonday,
    win.mondayKey === expectedMonday, JSON.stringify(win));

  var mondayDow = new Date(win.mondayKey + "T00:00:00Z").getUTCDay();
  check("today=" + todayISO + " -> mondayKey is actually a Monday", mondayDow === 1, mondayDow);

  check("today=" + todayISO + " -> window is 7 calendar days inclusive",
    (Date.parse(win.end + "T00:00:00Z") - Date.parse(win.start + "T00:00:00Z")) === 6 * DAY_MS);
}

/* ---- mondayKey is always a Monday, for every possible start day ---- */
console.log("\n--- mondayKey is always a Monday, for every startDayName ---\n");

var ALL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
for (var d = 0; d < ALL_DAYS.length; d++) {
  var w = ThisWeek.opsWeek("2026-08-14", ALL_DAYS[d]);
  var dow = new Date(w.mondayKey + "T00:00:00Z").getUTCDay();
  check("startDayName=" + ALL_DAYS[d] + " -> mondayKey (" + w.mondayKey + ") is a Monday",
    dow === 1, JSON.stringify(w));
  check("startDayName=" + ALL_DAYS[d] + " -> mondayKey falls inside [start, end]",
    w.mondayKey >= w.start && w.mondayKey <= w.end, JSON.stringify(w));
}

/* ---- missing/unparseable startDayName falls back to Friday (D-061) ---- */
console.log("\n--- fallback ---\n");

var fallback = ThisWeek.opsWeek("2026-08-14", undefined);
var friday = ThisWeek.opsWeek("2026-08-14", "Friday");
check("missing startDayName falls back to Friday", fallback.mondayKey === friday.mondayKey, JSON.stringify(fallback));

var garbage = ThisWeek.opsWeek("2026-08-14", "not-a-day");
check("unparseable startDayName falls back to Friday", garbage.mondayKey === friday.mondayKey, JSON.stringify(garbage));

/* ---- offset: closing / current / opening (§11.1, D-071a) ---- */
console.log("\n--- opsWeek offset ---\n");

var cur = ThisWeek.opsWeek("2026-08-12", "Friday");
var curExplicit = ThisWeek.opsWeek("2026-08-12", "Friday", 0);
var closing = ThisWeek.opsWeek("2026-08-12", "Friday", -1);
var opening = ThisWeek.opsWeek("2026-08-12", "Friday", 1);

check("a 2-argument call still works and equals offset 0",
  JSON.stringify(cur) === JSON.stringify(curExplicit),
  JSON.stringify(cur) + " vs " + JSON.stringify(curExplicit));

check("offset -1 starts exactly 7 calendar days before the current window",
  Date.parse(closing.start + "T00:00:00Z") === Date.parse(cur.start + "T00:00:00Z") - 7 * DAY_MS,
  closing.start + " vs " + cur.start);
check("offset +1 starts exactly 7 calendar days after",
  Date.parse(opening.start + "T00:00:00Z") === Date.parse(cur.start + "T00:00:00Z") + 7 * DAY_MS,
  opening.start + " vs " + cur.start);

[["closing", closing], ["current", cur], ["opening", opening]].forEach(function (pair) {
  var name = pair[0], w = pair[1];
  check(name + ": window is still 7 calendar days inclusive",
    Date.parse(w.end + "T00:00:00Z") - Date.parse(w.start + "T00:00:00Z") === 6 * DAY_MS,
    JSON.stringify(w));
  check(name + ": mondayKey is a Monday",
    new Date(w.mondayKey + "T00:00:00Z").getUTCDay() === 1, JSON.stringify(w));
  check(name + ": mondayKey is the one Monday INSIDE this window",
    w.mondayKey >= w.start && w.mondayKey <= w.end, JSON.stringify(w));
});

check("the three windows are consecutive and non-overlapping",
  closing.end < cur.start && cur.end < opening.start,
  JSON.stringify([closing, cur, opening]));
check("their mondayKeys are 7 days apart in order",
  Date.parse(cur.mondayKey + "T00:00:00Z") - Date.parse(closing.mondayKey + "T00:00:00Z") === 7 * DAY_MS &&
  Date.parse(opening.mondayKey + "T00:00:00Z") - Date.parse(cur.mondayKey + "T00:00:00Z") === 7 * DAY_MS,
  [closing.mondayKey, cur.mondayKey, opening.mondayKey].join(" "));

/* The mondayKey is recomputed from the shifted window rather than by adding 7
   to the unshifted key. Those agree for Friday; this checks the property that
   makes them agree, across every possible start day. */
ALL_DAYS.forEach(function (day) {
  [-1, 0, 1].forEach(function (off) {
    var w = ThisWeek.opsWeek("2026-08-12", day, off);
    var dow = new Date(w.mondayKey + "T00:00:00Z").getUTCDay();
    check("startDay=" + day + " offset=" + off + ": key is the Monday within its own window",
      dow === 1 && w.mondayKey >= w.start && w.mondayKey <= w.end, JSON.stringify(w));
  });
});

/* ================= buckets (D-063a/b) ================= */
console.log("\n=== buckets — isolated fixture ===\n");

var window1 = { start: "2026-08-14", end: "2026-08-20", mondayKey: "2026-08-17" };
var people = ["Ana", "Beto"];

var liveResult = {
  tasks: {
    // Done inside the window
    T1: { id: "T1", owner: "Ana", owners: ["Ana"], workDays: 2, waitDays: 0,
      status: "done", plannedStart: null, plannedFinish: "2026-08-15" },
    // Done, but OUTSIDE the window — must not land in "done this week"
    T2: { id: "T2", owner: "Beto", owners: ["Beto"], workDays: 1, waitDays: 0,
      status: "done", plannedStart: null, plannedFinish: "2026-08-01" },
    // in_progress — no window filter at all (D-063a)
    T3: { id: "T3", owner: "Beto", owners: ["Beto"], workDays: 3, waitDays: 0,
      status: "in_progress", plannedStart: "2026-08-01", plannedFinish: "2026-09-01" },
    // open, projected finish overlaps the window
    T4: { id: "T4", owner: "Ana", owners: ["Ana"], workDays: 2, waitDays: 0,
      status: "open", plannedStart: "2026-08-18", plannedFinish: "2026-08-19" },
    // open, projected entirely AFTER the window — must be excluded
    T5: { id: "T5", owner: "Ana", owners: ["Ana"], workDays: 2, waitDays: 0,
      status: "open", plannedStart: "2026-09-01", plannedFinish: "2026-09-02" },
    // Joint task — must appear in EACH owner's column (D-063b). The
    // assertion reads `owners` (D-107); the stale "Both" literal in `owner`
    // is gone, since ownersOf() no longer resolves it specially.
    T6: { id: "T6", owner: ["Ana", "Beto"], owners: ["Ana", "Beto"], workDays: 1, waitDays: 0,
      status: "open", plannedStart: "2026-08-16", plannedFinish: "2026-08-18" }
  }
};

var currentState1 = {
  T1: { status: "done", statusChangedAt: "2026-08-15T10:00:00Z" },
  T2: { status: "done", statusChangedAt: "2026-08-01T10:00:00Z" },
  T3: { status: "in_progress", statusChangedAt: "2026-08-01T10:00:00Z" }
  // T4, T5, T6 absent -> default "open" (D-027)
};

var b = ThisWeek.buckets(liveResult, currentState1, window1, people);

check("every person gets an entry even before any filtering",
  !!b.Ana && !!b.Beto, JSON.stringify(Object.keys(b)));
check("T1 (done inside window) lands in Ana's done bucket",
  b.Ana.done.indexOf("T1") !== -1, JSON.stringify(b.Ana.done));
check("T2 (done outside window) is excluded from Beto's done bucket",
  b.Beto.done.indexOf("T2") === -1, JSON.stringify(b.Beto.done));
check("T3 (in_progress) lands in Beto's workingOn regardless of window",
  b.Beto.workingOn.indexOf("T3") !== -1, JSON.stringify(b.Beto.workingOn));
check("T4 (open, overlapping) lands in Ana's notStarted",
  b.Ana.notStarted.indexOf("T4") !== -1, JSON.stringify(b.Ana.notStarted));
check("T5 (open, entirely after the window) is excluded from notStarted",
  b.Ana.notStarted.indexOf("T5") === -1, JSON.stringify(b.Ana.notStarted));
check("T6 (Both) appears in Ana's notStarted",
  b.Ana.notStarted.indexOf("T6") !== -1, JSON.stringify(b.Ana.notStarted));
check("T6 (Both) ALSO appears in Beto's notStarted — one task, two columns (D-063b)",
  b.Beto.notStarted.indexOf("T6") !== -1, JSON.stringify(b.Beto.notStarted));

/* ================= availableToPull / cascadeOf (D-071b / D-063d) ================= */
console.log("\n=== availableToPull / cascadeOf — isolated fixture ===\n");

var plan2 = {
  schemaVersion: "1.0",
  sprint: { id: "S-TEST", start: "2026-08-01", end: "2026-09-01" },
  people: ["Ana", "Beto"],
  rocks: [{
    id: "R1", name: "Test Rock",
    projects: [{
      id: "P1", name: "Test Project",
      milestones: [{
        id: "M1", name: "Test Milestone",
        tasks: [
          { id: "T1", desc: "Kickoff", owner: "Ana", type: "work", workDays: 1, waitDays: 0 },
          { id: "T2", desc: "Depends on T1", owner: "Beto", type: "work", workDays: 1, waitDays: 0, dependsOn: ["T1"] },
          { id: "T3", desc: "Also depends on T1", owner: ["Ana", "Beto"], type: "work", workDays: 1, waitDays: 0, dependsOn: ["T1"] },
          { id: "T4", desc: "Depends on T2 (not done)", owner: "Ana", type: "work", workDays: 1, waitDays: 0, dependsOn: ["T2"] }
        ]
      }]
    }]
  }]
};

var currentState2 = { T1: { status: "done", statusChangedAt: "2026-08-02T00:00:00Z" } };

var pullable = ThisWeek.availableToPull(plan2, currentState2);
var pullableIds = pullable.map(function (t) { return t.id; });

check("T2 (dep T1 done) is available to pull", pullableIds.indexOf("T2") !== -1, pullableIds);
check("T3 (dep T1 done) is available to pull", pullableIds.indexOf("T3") !== -1, pullableIds);
check("T1 itself (already done) is NOT in the dropdown", pullableIds.indexOf("T1") === -1, pullableIds);

/* ---- CONTRACT CHANGE: D-071(b) supersedes D-063(e) ----
   This assertion used to read "T4 (dep T2 NOT done) is BLOCKED and excluded
   from the dropdown" and checked indexOf("T4") === -1. §11.5 reversed that
   requirement: the dropdown must now SHOW blocked tasks, flagged, naming the
   blocker and its owner, because hiding them hid the coordination the L10 is
   there to do. The test is not loosened — it is inverted and then tightened,
   asserting the flag and the named blocker that the old behaviour could not
   have produced at all. */
function pullableById(id) {
  return pullable.filter(function (t) { return t.id === id; })[0];
}

var t4 = pullableById("T4");
check("T4 (dep T2 NOT done) NOW APPEARS in the dropdown (D-071b supersedes D-063e)",
  !!t4, pullableIds);
check("T4 is flagged blocked:true", !!t4 && t4.blocked === true, JSON.stringify(t4));
check("T4's blockedBy names the blocking task T2",
  !!t4 && t4.blockedBy.length === 1 && t4.blockedBy[0].id === "T2",
  JSON.stringify(t4 && t4.blockedBy));
check("T4's blockedBy names the BLOCKER'S OWNER — the whole point of D-071(b)",
  !!t4 && t4.blockedBy[0].owner === "Beto", JSON.stringify(t4 && t4.blockedBy));
check("T4's blockedBy also carries the blocker's desc, so the row can be read",
  !!t4 && t4.blockedBy[0].desc === "Depends on T1", JSON.stringify(t4 && t4.blockedBy));

var t2 = pullableById("T2");
check("an UNBLOCKED task carries blocked:false", !!t2 && t2.blocked === false, JSON.stringify(t2));
check("an unblocked task's blockedBy is an empty array, never undefined",
  !!t2 && Array.isArray(t2.blockedBy) && t2.blockedBy.length === 0, JSON.stringify(t2));
check("every entry still carries id, desc and owner",
  pullable.every(function (t) { return t.id && t.desc && t.owner; }),
  JSON.stringify(pullable));
check("order by id is preserved",
  pullableIds.slice().sort().join(",") === pullableIds.join(","), pullableIds);

/* ---- cancelled tasks are excluded, and stop blocking (D-068) ---- */
var pullableWithCancel = ThisWeek.availableToPull(plan2, currentState2, ["T3"]);
check("a CANCELLED task is not offered for pulling",
  pullableWithCancel.every(function (t) { return t.id !== "T3"; }),
  JSON.stringify(pullableWithCancel.map(function (t) { return t.id; })));

var pullableDepCancelled = ThisWeek.availableToPull(plan2, currentState2, ["T2"]);
var t4NoBlocker = pullableDepCancelled.filter(function (t) { return t.id === "T4"; })[0];
check("cancelling the BLOCKER unblocks its dependent — matches what the engine now schedules",
  !!t4NoBlocker && t4NoBlocker.blocked === false && t4NoBlocker.blockedBy.length === 0,
  JSON.stringify(t4NoBlocker));

var cascade = ThisWeek.cascadeOf(plan2, "T2");
var cascadeIds = cascade.map(function (c) { return c.id; });
check("cascadeOf(T2) reports T4 (transitively depends on T2)", cascadeIds.indexOf("T4") !== -1, cascadeIds);
check("cascadeOf(T2) does not report T3 (T3 depends on T1, not T2)", cascadeIds.indexOf("T3") === -1, cascadeIds);
var t4Entry = cascade.filter(function (c) { return c.id === "T4"; })[0];
check("cascadeOf(T2) carries T4's owner for the postpone warning",
  !!t4Entry && t4Entry.owner === "Ana", JSON.stringify(t4Entry));

var cascadeOfLeaf = ThisWeek.cascadeOf(plan2, "T4");
check("cascadeOf a leaf task (nothing depends on T4) returns empty", cascadeOfLeaf.length === 0, cascadeOfLeaf);

console.log("\n=== summary ===");
console.log("  passed: " + passes);
console.log("  failed: " + failures);
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
process.exit(failures === 0 ? 0 : 1);
