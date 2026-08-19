#!/usr/bin/env node
/**
 * EVERY WRITE GOES THROUGH THE ONE GATE (§3, D-109).
 *
 *     node tests/write-overlay.test.js
 *
 * Same shape as tests/listener-isolation.test.js, and for the same reason: the
 * value is not "the overlay renders", it is "no write can reach the network
 * without raising it". So this counts ENTRY POINTS and fails if one stops
 * routing through OpsDashEvents.guardedWrite.
 *
 * The write entry points, enumerated from the repo (nothing else POSTs to
 * WEB_APP_URL):
 *   1. OpsDashEvents.postEvent          events.js  — the events log, 7 callers
 *   2. postCreateTask                   todos.js   — createTask sibling RPC
 *   3. postCreateIssue                  issues.js  — createIssue sibling RPC
 *
 * Reads are deliberately NOT gated and are asserted to stay ungated:
 * fetchEvents, app.js's fetchSheetValues, validate.load, and postEvent's own
 * verify re-read. An overlay on a read would cover the screen during every
 * refresh.
 *
 * The last section BREAKS the invariant on purpose and confirms this file
 * notices. A green test that cannot fail is not protection.
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

/* ------------------------------------------------------------------ *
 * A DOM just real enough for the overlay to build itself
 * ------------------------------------------------------------------ */

function FakeEl(tag) {
  this.tag = tag;
  this.children = [];
  this.parentNode = null;
  this._attrs = {};
  this._cls = {};
  this.innerHTML = "";
  this.textContent = "";
  this.focusCount = 0;
  var self = this;
  this.classList = {
    add: function () { for (var i = 0; i < arguments.length; i++) self._cls[arguments[i]] = true; },
    remove: function () { for (var i = 0; i < arguments.length; i++) delete self._cls[arguments[i]]; },
    contains: function (c) { return self._cls[c] === true; }
  };
}
FakeEl.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
FakeEl.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
};
FakeEl.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
FakeEl.prototype.focus = function () { this.focusCount++; };
/** The overlay only ever looks up its two inner parts by class. */
FakeEl.prototype.querySelector = function (sel) {
  var cls = sel.replace(/^\./, "");
  if (!this._parts) this._parts = {};
  if (!this._parts[cls]) {
    var el = new FakeEl("div");
    el._cls = {};
    el._cls[cls] = true;
    this._parts[cls] = el;
  }
  return this._parts[cls];
};

var BODY = new FakeEl("body");
var keyListeners = [];

global.window = global;
global.document = {
  body: BODY,
  createElement: function (tag) { return new FakeEl(tag); },
  getElementById: function () { return null; },
  addEventListener: function (type, fn, capture) {
    keyListeners.push({ type: type, fn: fn, capture: capture });
  },
  removeEventListener: function (type, fn) {
    keyListeners = keyListeners.filter(function (l) { return l.fn !== fn; });
  }
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

var Events = global.OpsDashEvents;
var Todos = global.OpsDashTodos;
var Issues = global.OpsDashIssues;
var CFG = global.OpsDashConfig;

CFG.todayISO = function () { return "2026-08-28"; };

/* ------------------------------------------------------------------ *
 * Instrument the gate and the network
 * ------------------------------------------------------------------ */

var gateCalls = [];
var realGuardedWrite = Events.guardedWrite;

/** Wrap, don't replace: the real gate still runs, so overlay behaviour below
 *  is the real behaviour and not a stub's imitation of it. */
function instrumentGate() {
  gateCalls = [];
  Events.guardedWrite = function (message, doWrite) {
    gateCalls.push(message);
    return realGuardedWrite(message, doWrite);
  };
}
function restoreGate() { Events.guardedWrite = realGuardedWrite; }

var fetchCalls = 0;
var overlayVisibleAtFetch = null;

function overlayIsVisible() {
  var el = BODY.children[0];
  return !!el && el.classList.contains("is-visible");
}

var EVENTS_HEADER = ["Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"];
var VERIFY_ROW = ["E-1", "S", "T-0001", "pin", "2026-08-31", "Ana", "2026-08-28T10:00:00-04:00", ""];
var postShouldSucceed = true;

/**
 * One stub for both directions, because verifyEvent re-reads through the
 * INTERNAL fetchEvents — replacing the export would not reach it, which is
 * what made the first run of this file report a phantom failure.
 *
 *   POST → the write response
 *   GET  → a Sheets values payload containing the row verify is looking for
 *
 * It also records whether the cover was ALREADY up the first time the network
 * was touched. That single boolean is the whole assertion of requirement 3.
 */
global.fetch = function (url, opts) {
  fetchCalls++;
  if (overlayVisibleAtFetch === null) overlayVisibleAtFetch = overlayIsVisible();

  if (opts && opts.method === "POST") {
    var body = postShouldSucceed
      ? { ok: true, id: "T-0001", verified: true }
      : { ok: false, code: "ACTOR_UNKNOWN", message: "Who is that?" };
    return Promise.resolve({
      ok: true, status: 200,
      text: function () { return Promise.resolve(JSON.stringify(body)); }
    });
  }
  return Promise.resolve({
    ok: true, status: 200,
    text: function () {
      return Promise.resolve(JSON.stringify({ values: [EVENTS_HEADER, VERIFY_ROW] }));
    }
  });
};

/* ------------------------------------------------------------------ *
 * 1. Every entry point routes through the gate
 * ------------------------------------------------------------------ */
console.log("\n=== every write entry point goes through guardedWrite ===\n");

var ENTRY_POINTS = [
  {
    name: "OpsDashEvents.postEvent (the events log)",
    run: function () { return Events.postEvent("pin", "T-0001", "2026-08-31", "Ana", ""); }
  },
  {
    name: "postCreateTask (createTask sibling RPC, todos.js)",
    run: function () {
      return Todos._internals.postCreateTask({
        desc: "x", owner: "Ana", workDays: 1, week: "2026-08-31", actor: "Ana"
      });
    }
  },
  {
    name: "postCreateIssue (createIssue sibling RPC, issues.js)",
    run: function () {
      return Issues._internals.postCreateIssue({ title: "x", desc: "", actor: "Ana" });
    }
  }
];

function runAll() {
  var chain = Promise.resolve();
  ENTRY_POINTS.forEach(function (ep) {
    chain = chain.then(function () {
      instrumentGate();
      overlayVisibleAtFetch = null;
      return ep.run().then(function () {
        /* THE invariant, asserted on the observable effect rather than on a
           spy: the cover was already up the first time the network was
           touched. This holds however the entry point reaches the gate —
           postEvent calls it through its own closure, the two sibling RPCs
           through the export — so the check cannot be fooled by wiring. */
        check(ep.name + ": overlay was ALREADY up when fetch ran (raised " +
          "before the first await, so a fast second click cannot slip in)",
          overlayVisibleAtFetch === true, String(overlayVisibleAtFetch));
        check("...and the write is back to rest afterwards, cover down",
          Events.isWriteInFlight() === false && overlayIsVisible() === false);
        restoreGate();
      });
    });
  });
  return chain;
}

runAll()
  /* ---------------------------------------------------------------- *
   * 2. Success lowers the cover; failure holds it up
   * ---------------------------------------------------------------- */
  .then(function () {
    console.log("\n=== success retires the overlay, error holds it ===\n");

    return Events.postEvent("pin", "T-0001", "2026-08-31", "Ana", "").then(function () {
      check("after a successful write the overlay is gone", overlayIsVisible() === false);
      check("...and the key trap is uninstalled with it", keyListeners.length === 0,
        keyListeners.length + " listeners still attached");
    });
  })
  .then(function () {
    postShouldSucceed = false; // server answers with a definitive rejection
    return Events.postEvent("pin", "T-0001", "2026-08-31", "Ana", "").then(function (result) {
      check("a rejected write still resolves to the caller (its toast and " +
        "button re-enable run unchanged)", result && result.ok === false, JSON.stringify(result));
      check("the overlay STAYS UP on error — it does not retire itself",
        overlayIsVisible() === true);
      var el = BODY.children[0];
      check("...in its error state", el.classList.contains("is-error"));
      var ack = el.querySelector(".write-overlay-ack");
      check("...showing an acknowledge button", ack.classList.contains("hidden") === false);
      check("...carrying the server's own words, no error code on screen",
        el.querySelector(".write-overlay-msg").textContent.indexOf("Who is that?") !== -1,
        el.querySelector(".write-overlay-msg").textContent);
      check("...and the key trap is still installed, so Escape and Tab cannot leave",
        keyListeners.length > 0);

      // Acknowledge it.
      ack.onclick();
      check("acknowledging retires the overlay", overlayIsVisible() === false);
      check("...and releases the key trap", keyListeners.length === 0);
    });
  })
  /* ---------------------------------------------------------------- *
   * 3. Reads are NOT gated
   * ---------------------------------------------------------------- */
  .then(function () {
    console.log("\n=== reads stay ungated ===\n");
    instrumentGate();
    return Events.fetchEvents().then(function () {
      check("fetchEvents does not raise the overlay — a refresh must not cover the screen",
        gateCalls.length === 0, gateCalls.length + " gate calls");
      restoreGate();
    });
  })
  /* ---------------------------------------------------------------- *
   * 4. SANITY: break the invariant and confirm this file catches it
   * ---------------------------------------------------------------- */
  .then(function () {
    console.log("\n=== sanity: the test can actually fail ===\n");

    postShouldSucceed = true;

    // An ungated write — exactly what a future pass would reintroduce by
    // adding a fourth POST that forgets the gate.
    instrumentGate();
    overlayVisibleAtFetch = null;
    var ungated = Todos._internals.postCreateTaskUnguarded({
      desc: "x", owner: "Ana", workDays: 1, week: "2026-08-31", actor: "Ana"
    });
    return ungated.then(function () {
      check("an UNGATED write reaches the network with no gate call — the " +
        "condition this file exists to reject", gateCalls.length === 0,
        gateCalls.length + " gate calls");
      check("...and with no overlay raised, which is the actual defect",
        overlayVisibleAtFetch === false, String(overlayVisibleAtFetch));
      restoreGate();
    });
  })
  .then(function () {
    console.log("\n=== summary ===");
    console.log("  passed: " + passes);
    console.log("  failed: " + failures);
    console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(function (err) {
    console.log("\nHARNESS ERROR: " + (err && err.stack || err) + "\n");
    process.exit(1);
  });
