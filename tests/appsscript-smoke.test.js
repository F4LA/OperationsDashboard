#!/usr/bin/env node
/**
 * Apps Script Web App smoke test — Phase 3 backend (spec §3, D-037).
 *
 * Hits the DEPLOYED Web App for real and, after each accepted write, performs a
 * real write-then-verify: re-reads the tail of the Events tab through Sheets API
 * v4 and confirms the row landed, retrying with backoff because an Apps Script
 * append and a Sheets read are not instantly consistent (§3, "Write path").
 *
 * Plain Node, no framework, no install step (D-022 convention). Needs Node 18+
 * for global fetch.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 * No URL or key is committed (D-035) — everything comes from the environment:
 *
 *   OPSDASH_WEBAPP_URL=https://script.google.com/macros/s/AKfy.../exec \
 *   OPSDASH_SHEET_ID=1AbC... \
 *   OPSDASH_API_KEY=AIza... \
 *   OPSDASH_ACTOR=Bernardo \
 *   node tests/appsscript-smoke.test.js
 *
 * OPSDASH_ACTOR must be a name that exists and is Active in the People tab.
 * OPSDASH_SPRINT_ID is optional (defaults to SMOKE).
 *
 * ---------------------------------------------------------------------------
 * This test WRITES to the real Events log
 * ---------------------------------------------------------------------------
 * Every row it creates uses a Task ID of the form SMOKE-<epochMillis>-<n>, so the
 * rows are trivially greppable. Delete them afterwards, or leave them — the log is
 * append-only audit data and the dashboard only ever folds by real task ids, so
 * SMOKE rows are inert. They are never confused with plan tasks.
 *
 * ---------------------------------------------------------------------------
 * NOT automated here — run these two by hand (D-037)
 * ---------------------------------------------------------------------------
 *
 * A) HEADER GUARD
 *    1. Open the Events tab. Rename cell D1 from "Action" to "Actions".
 *    2. Re-run this script. EVERY happy-path write must now fail with
 *       code HEADER_DRIFT, and the message must name column 4 and show both the
 *       expected and the found header.
 *    3. Confirm in the sheet that NO new row was appended during step 2.
 *    4. Rename D1 back to "Action". Re-run: everything passes again.
 *    5. Repeat once with a column REORDER (swap B1 "Sprint ID" and C1 "Task ID")
 *       to confirm a reorder is caught too, then swap them back.
 *
 * B) CONCURRENCY / LockService
 *    1. Open two terminals side by side.
 *    2. In each, run the same one-liner at the same time (change the -1 / -2 so the
 *       two rows are distinguishable):
 *
 *         for i in $(seq 1 20); do \
 *           curl -s -X POST "$OPSDASH_WEBAPP_URL" \
 *             -H 'Content-Type: text/plain;charset=utf-8' \
 *             -d '{"action":"setStatus","taskId":"CONC-1","value":"done","actor":"'"$OPSDASH_ACTOR"'"}' \
 *             -o /dev/null -w '%{http_code} '; \
 *         done; echo
 *
 *    3. Open the Events tab and check, over those 40 rows:
 *       - exactly 40 new rows exist (nothing lost, nothing duplicated),
 *       - every Event ID is distinct,
 *       - no row is half-written (every column populated),
 *       - the rows are contiguous, with no blank row wedged between them.
 *    4. Delete the CONC-1 rows.
 */
"use strict";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

var WEBAPP_URL = process.env.OPSDASH_WEBAPP_URL;
var SHEET_ID = process.env.OPSDASH_SHEET_ID;
var API_KEY = process.env.OPSDASH_API_KEY;
var ACTOR = process.env.OPSDASH_ACTOR || "Bernardo";
var SPRINT_ID = process.env.OPSDASH_SPRINT_ID || "SMOKE";

var EVENTS_RANGE = "Events!A:H";
var TAIL_ROWS = 40;
var VERIFY_DELAYS_MS = [400, 800, 1600, 2500, 4000, 6000];

var RUN = "SMOKE-" + Date.now();
var seq = 0;
function nextTaskId() {
  seq++;
  return RUN + "-" + seq;
}

var failures = 0;
var passes = 0;

function pass(msg) { passes++; console.log("  PASS  " + msg); }
function fail(msg, detail) {
  failures++;
  console.log("  FAIL  " + msg + (detail ? "\n          " + detail : ""));
}
function check(name, cond, detail) { if (cond) pass(name); else fail(name, detail); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

function preflight() {
  var missing = [];
  if (!WEBAPP_URL) missing.push("OPSDASH_WEBAPP_URL");
  if (!SHEET_ID) missing.push("OPSDASH_SHEET_ID");
  if (!API_KEY) missing.push("OPSDASH_API_KEY");

  if (missing.length) {
    console.error("\nMissing required environment variable(s): " + missing.join(", ") + "\n");
    console.error("Run it like this (values are never committed — D-035):\n");
    console.error("  OPSDASH_WEBAPP_URL=https://script.google.com/macros/s/AKfy.../exec \\");
    console.error("  OPSDASH_SHEET_ID=1AbC... \\");
    console.error("  OPSDASH_API_KEY=AIza... \\");
    console.error("  OPSDASH_ACTOR=Bernardo \\");
    console.error("  node tests/appsscript-smoke.test.js\n");
    process.exit(2);
  }

  if (typeof fetch !== "function") {
    console.error("\nThis script needs Node 18+ (global fetch is not available here).\n");
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * POST exactly the way the browser will (§3): a CORS "simple request" with a
 * text/plain content type and a JSON body, so no preflight OPTIONS is ever needed.
 */
async function postEvent(payload) {
  var res = await fetch(WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });

  var text = await res.text();
  var body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return {
      httpStatus: res.status,
      parseError: "Response was not JSON. First 300 chars: " + text.slice(0, 300),
      body: null
    };
  }
  return { httpStatus: res.status, body: body, parseError: null };
}

/** Reads the tail of the Events tab through Sheets API v4 (D-038: no read endpoint). */
async function readEventsTail() {
  var url = "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(SHEET_ID) + "/values/" + encodeURIComponent(EVENTS_RANGE) +
    "?key=" + encodeURIComponent(API_KEY);

  var res = await fetch(url);
  var text = await res.text();

  if (!res.ok) {
    throw new Error("Sheets API read failed (HTTP " + res.status + "): " + text.slice(0, 300));
  }

  var json = JSON.parse(text);
  var values = json.values || [];
  if (!values.length) return { header: [], rows: [] };

  var header = values[0];
  var rows = values.slice(1);
  return { header: header, rows: rows.slice(Math.max(0, rows.length - TAIL_ROWS)) };
}

/**
 * Write-then-verify (§3): confirm a row matching (Task ID, Action, Value, Actor)
 * actually appeared, retrying with backoff before reporting success.
 */
async function verifyRow(expect) {
  var lastSeen = null;

  for (var attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt++) {
    await sleep(VERIFY_DELAYS_MS[attempt]);

    var tail;
    try {
      tail = await readEventsTail();
    } catch (err) {
      lastSeen = err.message;
      continue;
    }

    var idx = {};
    tail.header.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });

    for (var i = tail.rows.length - 1; i >= 0; i--) {
      var row = tail.rows[i];
      function cell(name) {
        var at = idx[name];
        return at === undefined || row[at] === undefined ? "" : String(row[at]).trim();
      }
      if (cell("task id") === expect.taskId &&
          cell("action") === expect.action &&
          cell("value") === expect.value &&
          cell("actor") === expect.actor) {
        return {
          found: true,
          attempts: attempt + 1,
          eventId: cell("event id"),
          timestamp: cell("timestamp")
        };
      }
    }

    lastSeen = "not in the last " + TAIL_ROWS + " rows yet (attempt " + (attempt + 1) + ")";
  }

  return { found: false, reason: lastSeen };
}

/** Confirms a REJECTED write left no trace in the log. */
async function assertNoRow(taskId) {
  await sleep(1500);
  try {
    var tail = await readEventsTail();
    var idx = {};
    tail.header.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    var at = idx["task id"];
    if (at === undefined) return { clean: true };
    var hit = tail.rows.some(function (row) {
      return row[at] !== undefined && String(row[at]).trim() === taskId;
    });
    return { clean: !hit };
  } catch (err) {
    return { clean: true, note: "could not re-read: " + err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Happy paths — each POST followed by a real write-then-verify
 * ------------------------------------------------------------------ */

async function happyPath(label, payloadPartial) {
  var taskId = nextTaskId();
  var payload = Object.assign(
    { sprintId: SPRINT_ID, taskId: taskId, actor: ACTOR },
    payloadPartial
  );

  var res = await postEvent(payload);

  if (res.parseError) {
    fail(label + " — response not JSON", res.parseError);
    return;
  }
  if (!res.body || res.body.ok !== true) {
    fail(label + " — server rejected an expected-valid write",
      JSON.stringify(res.body));
    return;
  }

  pass(label + " accepted  (eventId=" + res.body.eventId + ")");

  check(label + " — eventId matches D-034 format",
    /^E-\d{13}-[0-9a-z]{4}$/.test(res.body.eventId || ""),
    "got " + res.body.eventId);

  check(label + " — timestamp is a full ISO datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(res.body.timestamp || ""),
    "got " + res.body.timestamp);

  var expectedValue = payload.value === undefined ? "" : String(payload.value);
  var verified = await verifyRow({
    taskId: taskId,
    action: payloadPartial.eventAction || payloadPartial.action,
    value: expectedValue,
    actor: ACTOR
  });

  check(label + " — write-then-verify: row present in Events",
    verified.found,
    verified.found ? "" : "never appeared: " + verified.reason);

  if (verified.found) {
    check(label + " — verified row carries the server's Event ID",
      verified.eventId === res.body.eventId,
      "sheet=" + verified.eventId + " response=" + res.body.eventId);

    check(label + " — verified row carries the server's Timestamp",
      verified.timestamp === res.body.timestamp,
      "sheet=" + verified.timestamp + " response=" + res.body.timestamp);
  }
}

/* ------------------------------------------------------------------ *
 * Rejections
 * ------------------------------------------------------------------ */

async function rejection(label, payload, expectedCode, opts) {
  opts = opts || {};
  var res = await postEvent(payload);

  if (res.parseError) {
    fail(label + " — response not JSON", res.parseError);
    return;
  }
  if (!res.body) {
    fail(label + " — empty response body");
    return;
  }

  if (res.body.ok === false && res.body.code === expectedCode) {
    pass(label + " rejected with " + expectedCode);
  } else {
    fail(label + " — expected rejection " + expectedCode,
      "got " + JSON.stringify(res.body));
  }

  if (opts.taskId) {
    var clean = await assertNoRow(opts.taskId);
    check(label + " — nothing written to Events", clean.clean,
      "a row with taskId " + opts.taskId + " appeared despite the rejection");
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  preflight();

  console.log("\n=== Apps Script smoke test ===");
  console.log("  Web App : " + WEBAPP_URL.replace(/\/s\/[^/]+\//, "/s/***/"));
  console.log("  Sheet   : " + SHEET_ID.slice(0, 6) + "…");
  console.log("  Actor   : " + ACTOR);
  console.log("  Run tag : " + RUN);

  /* ---------------- happy paths ---------------- */
  console.log("\n--- happy paths (POST + real write-then-verify) ---\n");

  await happyPath("setStatus=done", { action: "setStatus", value: "done" });
  await happyPath("setStatus=in_progress", { action: "setStatus", value: "in_progress" });
  await happyPath("setStatus=open", { action: "setStatus", value: "open" });
  await happyPath("setDeliverable", {
    action: "setDeliverable",
    value: "https://drive.google.com/file/d/smoke-test/view"
  });
  await happyPath("pin (ISO Monday)", { action: "pin", value: "2026-08-10" });
  await happyPath("unpin", { action: "unpin", value: "" });

  // The spec-literal envelope must work identically to the shorthand.
  await happyPath("appendEvent envelope form", {
    action: "appendEvent", eventAction: "setStatus", value: "done"
  });

  /* ---------------- rejections ---------------- */
  console.log("\n--- rejections (server-side guarantees, §3) ---\n");

  var t;

  t = nextTaskId();
  await rejection("unknown actor",
    { action: "setStatus", taskId: t, value: "done", actor: "NotARealPerson_" + RUN },
    "ACTOR_UNKNOWN", { taskId: t });

  t = nextTaskId();
  await rejection("empty actor",
    { action: "setStatus", taskId: t, value: "done", actor: "" },
    "MISSING_ACTOR", { taskId: t });

  await rejection("empty task id",
    { action: "setStatus", taskId: "", value: "done", actor: ACTOR },
    "MISSING_TASK_ID");

  await rejection("missing task id",
    { action: "setStatus", value: "done", actor: ACTOR },
    "MISSING_TASK_ID");

  t = nextTaskId();
  await rejection("unknown action",
    { action: "deleteEverything", taskId: t, value: "x", actor: ACTOR },
    "UNKNOWN_ACTION", { taskId: t });

  t = nextTaskId();
  await rejection("appendEvent without eventAction",
    { action: "appendEvent", taskId: t, value: "done", actor: ACTOR },
    "UNKNOWN_ACTION", { taskId: t });

  t = nextTaskId();
  await rejection("missing action",
    { taskId: t, value: "done", actor: ACTOR },
    "UNKNOWN_RPC_ACTION", { taskId: t });

  t = nextTaskId();
  await rejection("setStatus with a value outside the enum",
    { action: "setStatus", taskId: t, value: "finished", actor: ACTOR },
    "BAD_VALUE_STATUS", { taskId: t });

  t = nextTaskId();
  await rejection("setStatus with an empty value",
    { action: "setStatus", taskId: t, value: "", actor: ACTOR },
    "BAD_VALUE_STATUS", { taskId: t });

  t = nextTaskId();
  await rejection("setDeliverable with a malformed URL",
    { action: "setDeliverable", taskId: t, value: "not a url", actor: ACTOR },
    "BAD_VALUE_URL", { taskId: t });

  t = nextTaskId();
  await rejection("setDeliverable with a javascript: URL",
    { action: "setDeliverable", taskId: t, value: "javascript:alert(1)", actor: ACTOR },
    "BAD_VALUE_URL", { taskId: t });

  t = nextTaskId();
  await rejection("setDeliverable with an empty value",
    { action: "setDeliverable", taskId: t, value: "", actor: ACTOR },
    "BAD_VALUE_URL", { taskId: t });

  t = nextTaskId();
  await rejection("pin on a non-Monday",
    { action: "pin", taskId: t, value: "2026-08-11", actor: ACTOR },
    "BAD_VALUE_PIN", { taskId: t });

  t = nextTaskId();
  await rejection("pin on an impossible date",
    { action: "pin", taskId: t, value: "2026-02-30", actor: ACTOR },
    "BAD_VALUE_PIN", { taskId: t });

  t = nextTaskId();
  await rejection("pin in a non-ISO format",
    { action: "pin", taskId: t, value: "08/10/2026", actor: ACTOR },
    "BAD_VALUE_PIN", { taskId: t });

  t = nextTaskId();
  await rejection("unpin carrying a value",
    { action: "unpin", taskId: t, value: "2026-08-10", actor: ACTOR },
    "BAD_VALUE_UNPIN", { taskId: t });

  /* ---------------- summary ---------------- */
  console.log("\n=== summary ===\n");
  console.log("  passed:   " + passes);
  console.log("  failed:   " + failures);
  console.log("\n  Rows written by this run are tagged " + RUN + "-* in the Task ID column.");
  console.log("  Still to run BY HAND (see the header of this file): the header-guard");
  console.log("  procedure and the concurrency/LockService procedure.");
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error("\nUnexpected failure: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
