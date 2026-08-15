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
 * Why this sends a Referer header
 * ---------------------------------------------------------------------------
 * The read key is referrer-restricted to the GitHub Pages origin, which is what
 * §3 requires for production. Node sends no Referer at all, and Google rejects a
 * referrer-restricted key on a refererless request with
 * API_KEY_HTTP_REFERRER_BLOCKED — so the read leg has to state the origin it is
 * standing in for. OPSDASH_REFERER overrides it if the origin ever changes.
 *
 * This is not a way around the restriction: a Referer header is client-supplied
 * on every platform, so the restriction was never an authentication boundary. It
 * exists to stop a copied key from working on someone else's page, and it still
 * does. Keeping the key restricted and naming the origin here is strictly safer
 * than the alternative of unrestricting the key to make the test pass.
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
 *
 * C) CONCURRENT createTask — TWO IDS, TWO COMPLETE ROWS (D-066a)
 *    The id is assigned by reading the Tasks tab and taking max+1, so two
 *    creations racing inside the same lock window are exactly the case that
 *    would hand out a duplicate id if LockService were not doing its job.
 *    The automated part of this file cannot prove that: it posts serially.
 *
 *    1. Note the current last id in the Tasks tab (or that it is empty).
 *    2. Open two terminals side by side. In each, run the same block at the
 *       same time, changing only the -A / -B tag so the rows are tellable
 *       apart:
 *
 *         for i in $(seq 1 10); do \
 *           curl -s -X POST "$OPSDASH_WEBAPP_URL" \
 *             -H 'Content-Type: text/plain;charset=utf-8' \
 *             -d '{"action":"createTask","desc":"CONC-A '"$i"'","owner":"'"$OPSDASH_ACTOR"'",
 *                  "workDays":0.5,"week":"2026-08-17","actor":"'"$OPSDASH_ACTOR"'"}' \
 *             -o /dev/null -w '%{http_code} '; \
 *         done; echo
 *
 *    3. Open the Tasks tab and check, over those 20 new rows:
 *       - exactly 20 rows were added,
 *       - every id in column A is DISTINCT (this is the assertion that matters),
 *       - the ids are contiguous with no gap and no repeat,
 *       - every row is COMPLETE: id, desc, owner, workDays and createdBy/createdAt
 *         all populated — no half-written row,
 *       - column A's max equals the last id assigned (nothing overwrote anything).
 *    4. Open the Events tab and check there are exactly 20 matching `pin` rows,
 *       one per new task id, each with Value = 2026-08-17. A task with no pin
 *       row is the failure D-066(b) exists to prevent — report it rather than
 *       fixing it by hand, because it means the write order regressed.
 *    5. Delete the CONC-A / CONC-B rows from BOTH tabs.
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

/** Origin the read key is referrer-restricted to (§3, §10). See the header note. */
var REFERER = process.env.OPSDASH_REFERER || "https://f4la.github.io/";

var EVENTS_RANGE = "Events!A:H";
var TASKS_RANGE = "Tasks!A:H";
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
  return readTabTail(EVENTS_RANGE);
}

/** Same, for the Tasks tab (v2, D-066e). */
async function readTasksTail() {
  return readTabTail(TASKS_RANGE);
}

async function readTabTail(range) {
  var url = "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(SHEET_ID) + "/values/" + encodeURIComponent(range) +
    "?key=" + encodeURIComponent(API_KEY);

  var res = await fetch(url, { headers: { "Referer": REFERER } });
  var text = await res.text();

  if (!res.ok) {
    var hint = "";
    if (text.indexOf("API_KEY_HTTP_REFERRER_BLOCKED") !== -1) {
      hint = "\n    The key's referrer restriction did not accept Referer \"" + REFERER + "\". " +
        "Check that the key's allowed referrer is exactly the ORIGIN with a wildcard " +
        "(https://f4la.github.io/*) — an origin mismatch or a path-scoped restriction " +
        "fails every request. Override with OPSDASH_REFERER if the origin has changed.";
    } else if (text.indexOf("API_KEY_SERVICE_BLOCKED") !== -1) {
      hint = "\n    The key is not allowed to call the Sheets API. In Cloud Console, " +
        "edit the key → API restrictions → tick Google Sheets API.";
    } else if (res.status === 403 || res.status === 404) {
      hint = "\n    Also check the spreadsheet is shared as 'Anyone with the link' (Viewer) — " +
        "an API key can only read link-readable sheets.";
    }
    throw new Error("Sheets API read of " + range + " failed (HTTP " + res.status + "): " +
      text.slice(0, 300) + hint);
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

/**
 * Confirms a REJECTED write left no trace in the log.
 *
 * THE ID PASSED HERE MUST BE UNIQUE PER RUN. This function detects EXISTENCE,
 * not NOVELTY: it scans the tail of Events for any row carrying that Task ID,
 * with no notion of "before this call". Hand it a real task id — a plan id
 * like M2-t1, or a T-NNNN the createTask happy paths just created — and it
 * reports a failure against rows written weeks ago by an earlier phase, even
 * though the rejection under test worked perfectly. Use nextTaskId(), which
 * returns SMOKE-<millis>-<n> and is outside every namespace the server
 * enforces.
 *
 * Where a test genuinely needs a namespaced id (discard/undiscard need a real
 * T-NNNN shape, confirmWeek needs WEEK-<ISO Monday>), uniqueness per run is
 * impossible by construction — those cases must NOT be given an opts.taskId,
 * and so deliberately skip this check.
 *
 * A read that fails is INCONCLUSIVE, never clean. Reporting an unreadable sheet
 * as "nothing was written" would turn every one of these into a check that
 * passes precisely when it can no longer see anything — the exact shape of a
 * test that is green for the wrong reason.
 */
async function assertNoRow(taskId) {
  await sleep(1500);
  try {
    var tail = await readEventsTail();
    var idx = {};
    tail.header.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    var at = idx["task id"];
    if (at === undefined) {
      return { inconclusive: true, reason: 'the Events tab has no "Task ID" column' };
    }
    var hit = tail.rows.some(function (row) {
      return row[at] !== undefined && String(row[at]).trim() === taskId;
    });
    return { clean: !hit };
  } catch (err) {
    return { inconclusive: true, reason: "could not re-read Events: " + err.message };
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

/**
 * Same as happyPath, but for actions whose Task ID is NOT free-form and so
 * cannot be a generated SMOKE-* id: discard/undiscard need a real T-NNNN
 * (D-067), cancel/uncancel need an id outside that namespace (D-068), and
 * confirmWeek needs WEEK-<ISO Monday> (D-070).
 */
async function happyPathFixedId(label, taskId, payloadPartial) {
  var payload = Object.assign(
    { sprintId: SPRINT_ID, taskId: taskId, actor: ACTOR },
    payloadPartial
  );

  var res = await postEvent(payload);

  if (res.parseError) { fail(label + " — response not JSON", res.parseError); return; }
  if (!res.body || res.body.ok !== true) {
    fail(label + " — server rejected an expected-valid write", JSON.stringify(res.body));
    return;
  }

  pass(label + " accepted  (eventId=" + res.body.eventId + ")");

  var verified = await verifyRow({
    taskId: taskId,
    action: payloadPartial.eventAction || payloadPartial.action,
    value: payload.value === undefined ? "" : String(payload.value),
    actor: ACTOR
  });

  check(label + " — write-then-verify: row present in Events", verified.found,
    verified.found ? "" : "never appeared: " + verified.reason);
}

/* ------------------------------------------------------------------ *
 * createTask (v2, D-066) — POST, then verify BOTH writes: the Tasks row
 * and the pin event that must accompany it.
 * ------------------------------------------------------------------ */

/**
 * Confirms a task id appeared in the Tasks tab, with the same backoff the
 * Events verify uses. Returns the whole row so the caller can assert the
 * column contents, not just presence.
 */
async function verifyTaskRow(taskId) {
  var lastSeen = null;

  for (var attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt++) {
    await sleep(VERIFY_DELAYS_MS[attempt]);

    var tail;
    try {
      tail = await readTasksTail();
    } catch (err) {
      lastSeen = err.message;
      continue;
    }

    var idx = {};
    tail.header.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    var at = idx["id"];
    if (at === undefined) {
      lastSeen = 'the Tasks tab has no "id" column';
      continue;
    }

    for (var i = tail.rows.length - 1; i >= 0; i--) {
      if (String(tail.rows[i][at] || "").trim() === taskId) {
        return { found: true, attempts: attempt + 1, row: tail.rows[i], idx: idx };
      }
    }
    lastSeen = "not in the last " + TAIL_ROWS + " Tasks rows yet (attempt " + (attempt + 1) + ")";
  }

  return { found: false, reason: lastSeen };
}

async function createTaskHappyPath(label, partial) {
  var payload = Object.assign(
    { action: "createTask", sprintId: SPRINT_ID, actor: ACTOR },
    partial
  );

  var res = await postEvent(payload);

  if (res.parseError) { fail(label + " — response not JSON", res.parseError); return null; }
  if (!res.body || res.body.ok !== true) {
    fail(label + " — server rejected an expected-valid createTask", JSON.stringify(res.body));
    return null;
  }

  pass(label + " accepted  (id=" + res.body.id + ")");

  check(label + " — id is in the T-NNNN namespace",
    /^T-\d{4}$/.test(res.body.id || ""), "got " + res.body.id);
  check(label + " — response carries the pin's eventId",
    /^E-\d{13}-[0-9a-z]{4}$/.test(res.body.eventId || ""), "got " + res.body.eventId);
  check(label + " — createdAt is a full ISO datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(res.body.createdAt || ""),
    "got " + res.body.createdAt);
  check(label + " — server-side verify reported the row present",
    res.body.verified === true, JSON.stringify(res.body));

  /* The Tasks row really landed, read back through the API. */
  var v = await verifyTaskRow(res.body.id);
  check(label + " — write-then-verify: row present in Tasks", v.found,
    v.found ? "" : "never appeared: " + v.reason);

  if (v.found) {
    function cell(name) {
      var at = v.idx[name.toLowerCase()];
      return at === undefined || v.row[at] === undefined ? "" : String(v.row[at]).trim();
    }
    check(label + " — Tasks row carries the desc, owner and workDays we sent",
      cell("desc") === String(payload.desc) &&
      cell("owner") === String(payload.owner) &&
      Number(cell("workDays")) === Number(payload.workDays),
      JSON.stringify(v.row));
    check(label + " — createdBy is the acting person",
      cell("createdBy") === ACTOR, "got " + cell("createdBy"));
  }

  /* And so did its pin — this is the D-066(b) guarantee, not a nice-to-have:
     a task with no week is invisible in every view and has no backlog to be
     found in, so the pin's presence is the thing worth asserting hardest. */
  var pinned = await verifyRow({
    taskId: res.body.id, action: "pin", value: payload.week, actor: ACTOR
  });
  check(label + " — the accompanying pin event is in Events (§11.6 guarantee)",
    pinned.found, pinned.found ? "" : "no pin row for " + res.body.id + ": " + pinned.reason);

  return res.body;
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
    var verdict = await assertNoRow(opts.taskId);
    if (verdict.inconclusive) {
      fail(label + " — could not confirm nothing was written", verdict.reason);
    } else {
      check(label + " — nothing written to Events", verdict.clean,
        "a row with taskId " + opts.taskId + " appeared despite the rejection");
    }
  }
}

/**
 * createTask rejections can't be checked by task id — the server assigns it,
 * and on a rejection it never gets that far. So this compares the Tasks tab's
 * row count across the call instead.
 *
 * A read that FAILS is inconclusive and reported as a failure, never as a
 * clean pass — same D-044 discipline as assertNoRow: a check that goes green
 * exactly when it can no longer see the sheet is worse than no check.
 */
async function createTaskRejection(label, payloadPartial, expectedCode) {
  var before;
  try {
    before = (await readTasksTail()).rows.length;
  } catch (err) {
    fail(label + " — could not read Tasks before the call (inconclusive)", err.message);
    return;
  }

  var payload = Object.assign({ action: "createTask", actor: ACTOR }, payloadPartial);
  var res = await postEvent(payload);

  if (res.parseError) { fail(label + " — response not JSON", res.parseError); return; }
  if (!res.body) { fail(label + " — empty response body"); return; }

  if (res.body.ok === false && res.body.code === expectedCode) {
    pass(label + " rejected with " + expectedCode);
  } else {
    fail(label + " — expected rejection " + expectedCode, "got " + JSON.stringify(res.body));
  }

  await sleep(1500);
  var after;
  try {
    after = (await readTasksTail()).rows.length;
  } catch (err) {
    fail(label + " — could not confirm no Tasks row was written (inconclusive)", err.message);
    return;
  }

  check(label + " — no Tasks row written", after === before,
    "Tasks went from " + before + " to " + after + " rows despite the rejection");
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
  console.log("  Referer : " + REFERER);
  console.log("  Run tag : " + RUN);

  /* ---------------- preflight ----------------
     Prove the read leg works BEFORE writing anything. Without this the run
     spends minutes appending rows and only then discovers it can never verify
     them, which is exactly how the first run of this test failed. */
  console.log("\n--- preflight: can we read the Events tab? ---\n");
  try {
    var probe = await readEventsTail();
    pass("Sheets API read works (" + probe.rows.length + " row(s) in the tail)");

    var expectedHeader = ["Event ID","Sprint ID","Task ID","Action","Value","Actor","Timestamp","Note"];
    var headerOk = expectedHeader.every(function (h, i) {
      return String(probe.header[i] || "").trim().toLowerCase() === h.toLowerCase();
    });
    check("Events header matches the D-033 schema", headerOk,
      "found [" + probe.header.join(" | ") + "]");
  } catch (err) {
    console.log("  FAIL  Sheets API read failed — stopping before writing anything\n");
    console.log("        " + err.message + "\n");
    console.log("  Nothing was written to the sheet. Fix the read access and re-run.\n");
    process.exit(1);
  }

  /* The Tasks tab is new in v2 — probe it the same way, and stop the same way.
     Reaching the createTask cases with an unreadable Tasks tab would make every
     one of them inconclusive-but-green-looking. */
  try {
    var tprobe = await readTasksTail();
    pass("Tasks tab readable (" + tprobe.rows.length + " row(s) in the tail)");

    var expectedTasksHeader =
      ["id","desc","owner","workDays","deadline","sourceIssueId","createdBy","createdAt"];
    var tHeaderOk = expectedTasksHeader.every(function (h, i) {
      return String(tprobe.header[i] || "").trim().toLowerCase() === h.toLowerCase();
    });
    check("Tasks header matches the D-066 schema", tHeaderOk,
      "found [" + tprobe.header.join(" | ") + "]");
  } catch (err) {
    console.log("  FAIL  Tasks tab could not be read — stopping before writing anything\n");
    console.log("        " + err.message + "\n");
    console.log("  Create the Tasks tab with headers:\n");
    console.log("    id | desc | owner | workDays | deadline | sourceIssueId | createdBy | createdAt\n");
    console.log("  Nothing was written to the sheet. Fix it and re-run.\n");
    process.exit(1);
  }

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

  /* ---------------- v2 happy paths ---------------- */
  console.log("\n--- v2 happy paths: createTask (D-066) ---\n");

  var created = await createTaskHappyPath("createTask (minimum fields)", {
    desc: "Smoke: call the supplier " + RUN,
    owner: ACTOR, workDays: 0.5, week: "2026-08-17"
  });

  var created2 = await createTaskHappyPath("createTask (every optional field)", {
    desc: "Smoke: full payload " + RUN,
    owner: ACTOR, workDays: 2, week: "2026-08-17",
    deadline: "2026-08-20", sourceIssueId: "I-0001", note: "smoke test"
  });

  if (created && created2) {
    check("two sequential creations got DIFFERENT ids", created.id !== created2.id,
      created.id + " vs " + created2.id);
    check("the second id is strictly greater than the first",
      Number(created2.id.slice(2)) > Number(created.id.slice(2)),
      created.id + " -> " + created2.id);
  }

  console.log("\n--- v2 happy paths: discard / cancel / confirmWeek ---\n");

  /* discard/undiscard must run against a REAL ad-hoc id, which is exactly what
     createTask just produced — using a made-up T-9999 would pass the namespace
     check but wouldn't exercise the pairing against a task that exists. */
  if (created) {
    await happyPathFixedId("discard (ad-hoc, with reason)", created.id,
      { action: "discard", value: "", note: "Smoke: no longer needed" });
    await happyPathFixedId("undiscard (the reversal, D-069)", created.id,
      { action: "undiscard", value: "" });
  } else {
    fail("discard/undiscard happy paths skipped — createTask did not return an id");
  }

  await happyPathFixedId("cancel (plan-namespace id, with reason)", "SMOKEPLAN-" + Date.now(),
    { action: "cancel", value: "", note: "Smoke: scope dropped" });

  await happyPathFixedId("uncancel (the reversal, D-069)", "SMOKEPLAN-" + Date.now(),
    { action: "uncancel", value: "" });

  await happyPathFixedId("confirmWeek (freezes §12's denominator, D-070)",
    "WEEK-2026-08-17",
    { action: "confirmWeek", value: "2026-08-17", note: '["M2-t1","' + (created ? created.id : "T-0001") + '"]' });

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

  /* ---------------- v2 rejections: createTask (D-066) ---------------- */
  console.log("\n--- v2 rejections: createTask ---\n");

  var baseTask = { desc: "Smoke reject " + RUN, owner: ACTOR, workDays: 1, week: "2026-08-17" };

  await createTaskRejection('owner "Both" (its own code, never OWNER_UNKNOWN)',
    Object.assign({}, baseTask, { owner: "Both" }), "OWNER_BOTH_NOT_ALLOWED");

  await createTaskRejection("unknown owner",
    Object.assign({}, baseTask, { owner: "NotARealPerson_" + RUN }), "OWNER_UNKNOWN");

  await createTaskRejection("empty desc",
    Object.assign({}, baseTask, { desc: "" }), "MISSING_DESC");

  await createTaskRejection("missing week (§11.6: no task without a week)",
    { desc: baseTask.desc, owner: ACTOR, workDays: 1 }, "MISSING_WEEK");

  await createTaskRejection("week on a non-Monday (BAD_VALUE_WEEK, distinct from MISSING_WEEK)",
    Object.assign({}, baseTask, { week: "2026-08-18" }), "BAD_VALUE_WEEK");

  await createTaskRejection("workDays of 0",
    Object.assign({}, baseTask, { workDays: 0 }), "BAD_VALUE_WORKDAYS");

  await createTaskRejection("negative workDays",
    Object.assign({}, baseTask, { workDays: -2 }), "BAD_VALUE_WORKDAYS");

  await createTaskRejection("non-numeric workDays",
    Object.assign({}, baseTask, { workDays: "soon" }), "BAD_VALUE_WORKDAYS");

  await createTaskRejection("missing workDays (mandatory per §1 v2)",
    { desc: baseTask.desc, owner: ACTOR, week: "2026-08-17" }, "BAD_VALUE_WORKDAYS");

  await createTaskRejection("malformed deadline",
    Object.assign({}, baseTask, { deadline: "next friday" }), "BAD_VALUE_DEADLINE");

  await createTaskRejection("impossible deadline date",
    Object.assign({}, baseTask, { deadline: "2026-02-30" }), "BAD_VALUE_DEADLINE");

  await createTaskRejection("unknown actor on createTask (still ACTOR_UNKNOWN, not OWNER_*)",
    Object.assign({}, baseTask, { actor: "NotARealPerson_" + RUN }), "ACTOR_UNKNOWN");

  /* ---------------- v2 rejections: namespace rules (D-067, D-068) ---------------- */
  console.log("\n--- v2 rejections: discard / cancel namespace rules ---\n");

  /* A generated SMOKE-<millis>-<n> id is outside the T-NNNN namespace, so it
     exercises DISCARD_NOT_ADHOC exactly like a real plan id would — and unlike
     a real plan id it is unique per run, which is what assertNoRow requires
     (see its comment). */
  t = nextTaskId();
  await rejection("discard on a PLAN task id (D-067 namespace rule)",
    { action: "discard", taskId: t, value: "", actor: ACTOR, note: "should be refused" },
    "DISCARD_NOT_ADHOC", { taskId: t });

  t = nextTaskId();
  await rejection("undiscard on a plan task id",
    { action: "undiscard", taskId: t, value: "", actor: ACTOR },
    "DISCARD_NOT_ADHOC", { taskId: t });

  /* These need an id INSIDE the T-NNNN namespace to exercise the rule at all,
     so they cannot be made unique per run — the namespace is exactly 4 digits.
     T-9999 is used as a sentinel rather than T-0001 (which is the first id
     createTask actually assigns, and which this file's own happy paths create
     for real). None of them passes an opts.taskId: they must skip assertNoRow,
     for the reason documented on that function. */
  var ADHOC_SENTINEL = "T-9999";

  await rejection("discard with no reason (D-067: the note is mandatory)",
    { action: "discard", taskId: ADHOC_SENTINEL, value: "", actor: ACTOR },
    "MISSING_DISCARD_REASON");

  await rejection("discard with a whitespace-only reason",
    { action: "discard", taskId: ADHOC_SENTINEL, value: "", actor: ACTOR, note: "   " },
    "MISSING_DISCARD_REASON");

  await rejection("discard carrying a value",
    { action: "discard", taskId: ADHOC_SENTINEL, value: "x", actor: ACTOR, note: "reason" },
    "BAD_VALUE_DISCARD");

  await rejection("cancel on an AD-HOC id (D-068, the mirror rule)",
    { action: "cancel", taskId: ADHOC_SENTINEL, value: "", actor: ACTOR, note: "should be refused" },
    "CANCEL_NOT_PLAN_TASK");

  await rejection("uncancel on an ad-hoc id",
    { action: "uncancel", taskId: ADHOC_SENTINEL, value: "", actor: ACTOR },
    "CANCEL_NOT_PLAN_TASK");

  t = nextTaskId();
  await rejection("cancel with no reason (D-068: the note is mandatory)",
    { action: "cancel", taskId: t, value: "", actor: ACTOR },
    "MISSING_CANCEL_REASON", { taskId: t });

  t = nextTaskId();
  await rejection("cancel carrying a value",
    { action: "cancel", taskId: t, value: "x", actor: ACTOR, note: "reason" },
    "BAD_VALUE_CANCEL", { taskId: t });

  /* "discarded"/"cancelled" are DERIVED from those events, never setStatus
     values — the §1-vs-§3 conflict D-067 resolved. */
  t = nextTaskId();
  await rejection('setStatus "discarded" (a derived state, not a status — D-067)',
    { action: "setStatus", taskId: t, value: "discarded", actor: ACTOR },
    "BAD_VALUE_STATUS", { taskId: t });

  t = nextTaskId();
  await rejection('setStatus "cancelled"',
    { action: "setStatus", taskId: t, value: "cancelled", actor: ACTOR },
    "BAD_VALUE_STATUS", { taskId: t });

  /* ---------------- v2 rejections: confirmWeek (D-070) ---------------- */
  console.log("\n--- v2 rejections: confirmWeek ---\n");

  /* A WEEK- id is constrained to WEEK-<ISO Monday>, so it cannot be unique per
     run either. These use a Monday the happy path never confirms, so they can
     never collide with the real row it writes; like the ad-hoc sentinel above,
     none of them passes an opts.taskId. */
  var REJECT_WEEK = "2026-09-07";      // a Monday, deliberately not the happy path's
  var REJECT_WEEK_ID = "WEEK-" + REJECT_WEEK;

  await rejection("confirmWeek whose Task ID date does not match its Value",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: "2026-08-24",
      actor: ACTOR, note: "[]" },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek on a non-Monday",
    { action: "confirmWeek", taskId: "WEEK-2026-08-18", value: "2026-08-18",
      actor: ACTOR, note: "[]" },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek with a Task ID missing the WEEK- prefix",
    { action: "confirmWeek", taskId: REJECT_WEEK, value: REJECT_WEEK,
      actor: ACTOR, note: "[]" },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek with NO Note (never read as an empty denominator)",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: REJECT_WEEK, actor: ACTOR },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek whose Note is not JSON",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: REJECT_WEEK,
      actor: ACTOR, note: "M2-t1, M2-t2" },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek whose Note is a JSON object, not an array",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: REJECT_WEEK,
      actor: ACTOR, note: '{"ids":[]}' },
    "BAD_VALUE_CONFIRM_WEEK");

  await rejection("confirmWeek whose Note array holds a non-string",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: REJECT_WEEK,
      actor: ACTOR, note: '["M2-t1", 42]' },
    "BAD_VALUE_CONFIRM_WEEK");

  var overLongNote = JSON.stringify(new Array(900).join("x").split("x").map(function (_, i) {
    return "M" + i + "-t1";
  }));
  await rejection("confirmWeek with an over-long Note (rejected, NEVER truncated — D-070)",
    { action: "confirmWeek", taskId: REJECT_WEEK_ID, value: REJECT_WEEK,
      actor: ACTOR, note: overLongNote },
    "NOTE_TOO_LONG");

  /* ---------------- summary ---------------- */
  console.log("\n=== summary ===\n");
  console.log("  passed:   " + passes);
  console.log("  failed:   " + failures);
  console.log("\n  Rows written by this run are tagged " + RUN + "-* in the Task ID column.");
  console.log("  createTask also wrote real T-NNNN rows to the Tasks tab (desc contains " +
    RUN + ") plus their pin events.");
  console.log("  Still to run BY HAND (see the header of this file): (A) the header-guard");
  console.log("  procedure, (B) the concurrency/LockService procedure, and (C) the");
  console.log("  concurrent-createTask procedure — two parallel creations must yield two");
  console.log("  distinct ids and two complete rows, which this serial script cannot prove.");
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + "\n");

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error("\nUnexpected failure: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
