/**
 * Operations Dashboard — Events fold (spec §3, D-009, D-036)
 *
 * The Events tab is an append-only log. Current state is DERIVED, never stored:
 * fold by (Task ID, Action) and keep the latest row by Timestamp, which yields
 * the current status, the current deliverable link and the current pin per task
 * (§3, "Current state is derived, not stored").
 *
 * The setStatus projection produces exactly the `currentState` shape D-027 fixed
 * for the engine, so its output can be handed straight to
 * OpsDashEngine.liveMode(plan, currentState, todayISO):
 *
 *     currentState[taskId] = { status: "open"|"in_progress"|"done",
 *                              statusChangedAt: ISO | null }
 *
 * A task with no setStatus event simply does not appear in the map — liveMode
 * already defaults an absent task to "open", so absence is the correct encoding
 * of "nobody has touched this yet".
 *
 * Reading is done by the caller against Sheets API v4 (D-038: the Apps Script
 * exposes no read endpoint). This module only transforms what comes back.
 *
 * Public API
 *   OpsDashEvents.HEADERS
 *   OpsDashEvents.parseRows(values)     raw Sheets API values (with header row) → events[]
 *   OpsDashEvents.fold(input)           → {byTask, events, warnings}
 *   OpsDashEvents.toCurrentState(input) → the D-027 map, exactly two keys per task
 *   OpsDashEvents.deliverables(input)   → { taskId: url }
 *   OpsDashEvents.pins(input)           → { taskId: isoMonday }
 *   OpsDashEvents.pinEvents(input)      → { taskId: {value, actor, timestamp} }  (D-078)
 *   OpsDashEvents.discards(input)       → { taskId: {note, actor, timestamp} }  (D-067)
 *   OpsDashEvents.cancels(input)        → { taskId: {note, actor, timestamp} }  (D-068)
 *   OpsDashEvents.weekCommitment(input, mondayKey) → string[] | null            (D-070)
 *   OpsDashEvents.fetchEvents()         → Promise<events[]> (full Events tab, Sheets API v4)
 *   OpsDashEvents.postEvent(action, taskId, value, actor, note) → Promise<{ok, ...}>
 *   OpsDashEvents.verifyEvent({taskId, action, value, actor})  → Promise<{ok, ...}>
 *
 * The v2 projections (discards, cancels, weekCommitment) add NO fold
 * machinery: the generic fold already indexes by (Task ID, Action) and keeps
 * the latest by Timestamp, which is all three of them need. discards and
 * cancels are the same positive/negative pair shape as pin/unpin, which is
 * what D-069 mandated. `discarded` and `cancelled` are DERIVED from those
 * events being present — neither is a setStatus value, per D-067: one way to
 * discard, not two. None of this changes the currentState shape D-027 fixed,
 * which engine.js consumes and the Phase 2 fixture pins down; they are
 * separate maps alongside it.
 *
 * pinEvents() (D-078) is pins() plus the event's actor and timestamp. §12 has
 * to tell a pin made THIS week from an older one that merely points forward,
 * and only the timestamp separates them. pins() keeps its historical
 * {taskId: isoMonday} shape and is projected from pinEvents, so the
 * pin/unpin resolution exists once.
 *
 * postEvent / verifyEvent — Phase 4 write path (§3 "Write path", D-046, D-047)
 *
 *   Client emits ONLY the shortcut payload (D-046): {action, sprintId, taskId,
 *   value, actor, note}, never the appendEvent envelope — the backend accepts
 *   both (D-039) but this is the one real form the board sends.
 *
 *   postEvent POSTs as a CORS "simple request" (text/plain body, so no preflight
 *   OPTIONS — Apps Script Web Apps don't answer one). `mode:"no-cors"` is used
 *   ONLY inside the catch on a TypeError (network/CORS-level failure) — never as
 *   the default, because an unconditional no-cors makes a server-side rejection
 *   look identical to success (the scar this project's spec calls out by name).
 *
 *   postEvent ALWAYS ends by calling verifyEvent, on every path — including a
 *   readable server response that already said ok:false. That specific,
 *   already-known reason is what postEvent resolves with either way; verify
 *   still runs (so the audit trail / caller-visible timing is consistent) but
 *   its outcome does not overwrite a clearer answer we already have. When the
 *   POST result is unreadable (no-cors) or looked like success, verify's
 *   outcome IS the answer.
 *
 *   verifyEvent re-reads the Events tab (same Sheets API v4 path the fold uses)
 *   and looks for a row matching (Task ID, Action, Value, Actor) in the last 40
 *   rows, retrying with backoff 0/500/1000/2000ms (4 attempts total) before
 *   giving up. Per D-044's lesson applied here: a read that FAILS is a
 *   different outcome from a read that SUCCEEDS but finds nothing — the first
 *   is "we couldn't check" (VERIFY_READ_FAILED), the second is "we looked and
 *   it isn't there" (VERIFY_TIMEOUT). Collapsing them would repeat the exact
 *   false-positive bug D-044 fixed in the smoke test.
 *
 *   Every caller branches on the `ok` field only, never on HTTP status (D-040) —
 *   Apps Script's ContentService always answers 200, success or error alike.
 */
(function (root) {
  "use strict";

  var HEADERS = [
    "Event ID", "Sprint ID", "Task ID", "Action", "Value", "Actor", "Timestamp", "Note"
  ];

  // Header label → the key used on the parsed event object.
  var FIELD_BY_HEADER = {
    "event id": "eventId",
    "sprint id": "sprintId",
    "task id": "taskId",
    "action": "action",
    "value": "value",
    "actor": "actor",
    "timestamp": "timestamp",
    "note": "note"
  };

  var STATUS_VALUES = ["open", "in_progress", "done"];

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function trimStr(v) {
    if (v === undefined || v === null) return "";
    return String(v).trim();
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  /**
   * Timestamp → epoch ms for ordering. Returns null when it cannot be read.
   * Ordering is numeric, never string-compared: the Apps Script writes offsets
   * (e.g. -05:00) and a DST change inside a sprint would shift that offset, so
   * lexical comparison is not safe.
   */
  function parseTimestampMs(raw) {
    if (raw instanceof Date) {
      var t = raw.getTime();
      return isNaN(t) ? null : t;
    }
    var s = trimStr(raw);
    if (!s) return null;
    var ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
  }

  /**
   * Canonical ISO string for statusChangedAt (D-027). liveMode truncates this to
   * its first 10 chars (D-028), so the value must start with YYYY-MM-DD.
   * A value already in that form is preserved verbatim (keeping its offset);
   * anything else that still parses is normalised to a real ISO string.
   */
  function canonicalIso(raw) {
    if (raw instanceof Date) {
      var t = raw.getTime();
      return isNaN(t) ? null : raw.toISOString();
    }
    var s = trimStr(raw);
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
    var ms = Date.parse(s);
    if (isNaN(ms)) return null;
    return new Date(ms).toISOString();
  }

  /* ------------------------------------------------------------------ *
   * parseRows
   * ------------------------------------------------------------------ */

  /**
   * Turns the raw Sheets API `values` block (header row first) into event objects,
   * mapping columns BY HEADER NAME rather than by position, so an added trailing
   * column cannot silently shift the fold.
   */
  function parseRows(values) {
    var out = { events: [], warnings: [] };

    if (!isArray(values) || !values.length) {
      out.warnings.push({
        code: "NO_ROWS",
        message: "No rows returned from the Events tab (not even a header row)."
      });
      return out;
    }

    var header = values[0] || [];
    var fieldAt = [];
    var seen = {};

    for (var c = 0; c < header.length; c++) {
      var label = trimStr(header[c]).toLowerCase();
      var field = FIELD_BY_HEADER[label];
      fieldAt[c] = field || null;
      if (field) seen[field] = true;
    }

    for (var h = 0; h < HEADERS.length; h++) {
      var expectedField = FIELD_BY_HEADER[HEADERS[h].toLowerCase()];
      if (!seen[expectedField]) {
        out.warnings.push({
          code: "MISSING_COLUMN",
          message: 'Events tab has no "' + HEADERS[h] + '" column; ' +
            "every value from it will read as empty."
        });
      }
    }

    for (var r = 1; r < values.length; r++) {
      var raw = values[r] || [];
      var ev = {
        eventId: "", sprintId: "", taskId: "", action: "",
        value: "", actor: "", timestamp: "", note: "",
        rowIndex: r + 1 // 1-based sheet row, header is row 1
      };

      var any = false;
      for (var i = 0; i < fieldAt.length; i++) {
        if (!fieldAt[i]) continue;
        var cell = raw[i];
        // Preserve Date objects on `timestamp`; everything else is text.
        ev[fieldAt[i]] = (fieldAt[i] === "timestamp" && cell instanceof Date)
          ? cell
          : trimStr(cell);
        if (trimStr(cell) !== "") any = true;
      }

      if (!any) continue; // blank spacer row
      out.events.push(ev);
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Normalisation — accept raw values, a parseRows result, or events[]
   * ------------------------------------------------------------------ */

  function normalize(input) {
    if (!input) return { events: [], warnings: [] };

    // { events, warnings } from parseRows
    if (!isArray(input) && isArray(input.events)) {
      return { events: input.events, warnings: (input.warnings || []).slice() };
    }

    // Sheets API response { values: [...] }
    if (!isArray(input) && isArray(input.values)) {
      return parseRows(input.values);
    }

    if (isArray(input)) {
      // Raw values block (array of arrays) vs. already-parsed events (objects)
      if (input.length && isArray(input[0])) return parseRows(input);

      var events = [];
      for (var i = 0; i < input.length; i++) {
        var e = input[i] || {};
        events.push({
          eventId: trimStr(e.eventId),
          sprintId: trimStr(e.sprintId),
          taskId: trimStr(e.taskId),
          action: trimStr(e.action),
          value: trimStr(e.value),
          actor: trimStr(e.actor),
          timestamp: e.timestamp instanceof Date ? e.timestamp : trimStr(e.timestamp),
          note: trimStr(e.note),
          rowIndex: e.rowIndex === undefined ? i + 2 : e.rowIndex
        });
      }
      return { events: events, warnings: [] };
    }

    return { events: [], warnings: [] };
  }

  /* ------------------------------------------------------------------ *
   * fold
   * ------------------------------------------------------------------ */

  /**
   * Latest event per (Task ID, Action) — D-009.
   *
   * Ordering is (timestamp, rowIndex): an event whose timestamp cannot be parsed
   * ranks below any event that has one, and ties fall back to sheet row order,
   * which for an append-only log means the later write wins. That makes the fold
   * deterministic even with duplicate timestamps.
   */
  function fold(input) {
    var normalized = normalize(input);
    var events = normalized.events;
    var warnings = normalized.warnings;
    var byTask = {};

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];

      if (!ev.taskId) {
        warnings.push({
          code: "ROW_NO_TASK_ID", rowIndex: ev.rowIndex,
          message: "Row " + ev.rowIndex + " has no Task ID; skipped."
        });
        continue;
      }
      if (!ev.action) {
        warnings.push({
          code: "ROW_NO_ACTION", rowIndex: ev.rowIndex, taskId: ev.taskId,
          message: "Row " + ev.rowIndex + " (task " + ev.taskId + ") has no Action; skipped."
        });
        continue;
      }

      var ms = parseTimestampMs(ev.timestamp);
      if (ms === null) {
        warnings.push({
          code: "ROW_BAD_TIMESTAMP", rowIndex: ev.rowIndex, taskId: ev.taskId,
          message: "Row " + ev.rowIndex + " (task " + ev.taskId + ", action " +
            ev.action + ") has an unreadable Timestamp; it orders below any dated event."
        });
      }

      if (!byTask[ev.taskId]) byTask[ev.taskId] = {};

      var current = byTask[ev.taskId][ev.action];
      var incoming = { event: ev, ms: ms };

      if (!current || isNewer(incoming, current)) {
        byTask[ev.taskId][ev.action] = incoming;
      }
    }

    // Unwrap to the plain event per (task, action).
    var result = {};
    for (var taskId in byTask) {
      if (!Object.prototype.hasOwnProperty.call(byTask, taskId)) continue;
      result[taskId] = {};
      for (var action in byTask[taskId]) {
        if (!Object.prototype.hasOwnProperty.call(byTask[taskId], action)) continue;
        result[taskId][action] = byTask[taskId][action].event;
      }
    }

    return { byTask: result, events: events, warnings: warnings };
  }

  function isNewer(a, b) {
    var am = a.ms === null ? -Infinity : a.ms;
    var bm = b.ms === null ? -Infinity : b.ms;
    if (am !== bm) return am > bm;
    return a.event.rowIndex > b.event.rowIndex;
  }

  /* ------------------------------------------------------------------ *
   * Projections
   * ------------------------------------------------------------------ */

  /**
   * The D-027 contract, ready to hand to OpsDashEngine.liveMode().
   * Each entry carries exactly two keys: status and statusChangedAt.
   *
   * An out-of-enum status is passed through rather than silently rewritten, with
   * a warning on the fold result — liveMode treats anything that is not "done" or
   * "in_progress" as open, so the projection stays safe while the oddity remains
   * visible instead of being swallowed.
   */
  function toCurrentState(input) {
    var folded = input && input.byTask ? input : fold(input);
    var out = {};

    for (var taskId in folded.byTask) {
      if (!Object.prototype.hasOwnProperty.call(folded.byTask, taskId)) continue;

      var ev = folded.byTask[taskId].setStatus;
      if (!ev) continue; // no status event → absent → liveMode defaults to open

      var status = trimStr(ev.value);
      if (indexOf(STATUS_VALUES, status) === -1 && folded.warnings) {
        folded.warnings.push({
          code: "UNKNOWN_STATUS", taskId: taskId, rowIndex: ev.rowIndex,
          message: 'Task ' + taskId + ' has status "' + status + '" (row ' + ev.rowIndex +
            "), which is not one of [" + STATUS_VALUES.join(", ") + "]."
        });
      }

      out[taskId] = {
        status: status,
        statusChangedAt: canonicalIso(ev.timestamp)
      };
    }

    return out;
  }

  /** Current deliverable link per task (§3). */
  function deliverables(input) {
    var folded = input && input.byTask ? input : fold(input);
    var out = {};
    for (var taskId in folded.byTask) {
      if (!Object.prototype.hasOwnProperty.call(folded.byTask, taskId)) continue;
      var ev = folded.byTask[taskId].setDeliverable;
      if (ev && trimStr(ev.value)) out[taskId] = trimStr(ev.value);
    }
    return out;
  }

  /**
   * Current pin per task WITH the pin event's own metadata (§3, §6.3).
   *
   * Added in the D-078 correction pass because §12 has to tell a pin made
   * THIS week (a real move, decided in this meeting) from an old pin that
   * merely happens to point at a future week — and only the timestamp can
   * separate them.
   *
   * pins() below is defined in terms of this and keeps its historical
   * {taskId: isoMonday} shape exactly, because board.js compares that value
   * against a Monday string in five places. One fold, two views of it.
   *
   * @returns { taskId: {value, actor, timestamp} }
   */
  function pinEvents(input) {
    var folded = input && input.byTask ? input : fold(input);
    var out = {};

    for (var taskId in folded.byTask) {
      if (!Object.prototype.hasOwnProperty.call(folded.byTask, taskId)) continue;

      var pinEv = folded.byTask[taskId].pin;
      var unpinEv = folded.byTask[taskId].unpin;
      if (!pinEv) continue;

      if (unpinEv) {
        var pinMs = parseTimestampMs(pinEv.timestamp);
        var unpinMs = parseTimestampMs(unpinEv.timestamp);
        var pinKey = pinMs === null ? -Infinity : pinMs;
        var unpinKey = unpinMs === null ? -Infinity : unpinMs;
        var unpinWins = unpinKey > pinKey ||
          (unpinKey === pinKey && unpinEv.rowIndex > pinEv.rowIndex);
        if (unpinWins) continue;
      }

      // The value check is part of the historical contract: a pin carrying a
      // blank Monday is not a pin.
      if (trimStr(pinEv.value)) {
        out[taskId] = {
          value: trimStr(pinEv.value),
          actor: trimStr(pinEv.actor),
          timestamp: canonicalIso(pinEv.timestamp)
        };
      }
    }

    return out;
  }

  /**
   * Current pin per task (§3, §6.3). pin sets the ISO Monday; unpin clears it.
   * Because pin and unpin are separate actions, the fold keeps the latest of
   * EACH — so the winner is whichever of the two happened most recently.
   *
   * Shape is UNCHANGED ({taskId: isoMonday}); it is now projected from
   * pinEvents() so there is one implementation of the pin/unpin resolution
   * rather than two that could drift.
   */
  function pins(input) {
    var events = pinEvents(input);
    var out = {};
    for (var taskId in events) {
      if (!Object.prototype.hasOwnProperty.call(events, taskId)) continue;
      out[taskId] = events[taskId].value;
    }
    return out;
  }

  /**
   * Shared resolver for a positive/negative action pair folded onto ONE slot
   * — the shape D-069 mandated by mirroring pin/unpin. pins() predates it and
   * keeps its own inlined copy so its behaviour stays provably untouched;
   * every later pair (discard/undiscard, cancel/uncancel) routes through here.
   *
   * The winner is whichever of the two is later by timestamp, tie-broken by
   * rowIndex — for an append-only log the later write wins, the same rule
   * fold() itself uses.
   *
   * @returns { taskId: {note, actor, timestamp} }. Absence from the map means
   *          "not discarded" / "not cancelled": the negative member REMOVES
   *          the key rather than recording a false entry.
   */
  function foldPositiveNegativePair(input, positiveAction, negativeAction) {
    var folded = input && input.byTask ? input : fold(input);
    var out = {};

    for (var taskId in folded.byTask) {
      if (!Object.prototype.hasOwnProperty.call(folded.byTask, taskId)) continue;

      var onEv = folded.byTask[taskId][positiveAction];
      var offEv = folded.byTask[taskId][negativeAction];
      if (!onEv) continue;

      if (offEv) {
        var onMs = parseTimestampMs(onEv.timestamp);
        var offMs = parseTimestampMs(offEv.timestamp);
        var onKey = onMs === null ? -Infinity : onMs;
        var offKey = offMs === null ? -Infinity : offMs;
        var offWins = offKey > onKey || (offKey === onKey && offEv.rowIndex > onEv.rowIndex);
        if (offWins) continue;
      }

      out[taskId] = {
        note: trimStr(onEv.note),
        actor: trimStr(onEv.actor),
        timestamp: canonicalIso(onEv.timestamp)
      };
    }

    return out;
  }

  /**
   * Current discard state per ad-hoc task (§11.4, D-067, D-069). "discarded"
   * is DERIVED from the presence of this event — deliberately NOT a setStatus
   * value, so there is exactly one way to discard something.
   */
  function discards(input) {
    return foldPositiveNegativePair(input, "discard", "undiscard");
  }

  /**
   * Current cancel state per PLAN task (§11.4, D-068, D-069). Same shape and
   * same fold as discards; kept separate because a discard and a cancellation
   * are different acts and §12 counts them apart.
   */
  function cancels(input) {
    return foldPositiveNegativePair(input, "cancel", "uncancel");
  }

  /**
   * The frozen §12 denominator for one ops week (D-070).
   *
   * Reads the confirmWeek event whose Task ID is "WEEK-<mondayKey>". The
   * generic fold already keeps the latest per (Task ID, Action), so
   * re-confirming a week replaces its denominator with no new machinery.
   *
   * @returns null      the week was never confirmed
   *          string[]  the frozen task ids — INCLUDING [] for a week that was
   *                    confirmed with nothing in it
   *
   * That null-vs-[] distinction is load-bearing and has to survive the fold:
   * it is exactly what D-072(a) made the server enforce. §12 divides by this,
   * so "nobody confirmed yet" and "confirmed, nothing committed" cannot look
   * alike — one has no rate at all, the other has a real denominator of zero.
   */
  function weekCommitment(input, mondayKey) {
    var folded = input && input.byTask ? input : fold(input);
    var key = "WEEK-" + trimStr(mondayKey);

    var byAction = folded.byTask[key];
    var ev = byAction && byAction.confirmWeek;
    if (!ev) return null;

    var raw = trimStr(ev.note);
    var parsed = null;
    var bad = false;

    if (raw === "") {
      bad = true; // server rejects this; only reachable by hand-editing the Sheet
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        bad = true;
      }
    }

    if (!bad) {
      var okShape = isArray(parsed) &&
        parsed.every(function (x) { return typeof x === "string"; });
      if (!okShape) bad = true;
    }

    if (bad) {
      // Only reachable by editing the Sheet by hand — the server rejects both an
      // absent and a malformed Note. Reported as UNCONFIRMED rather than as an
      // empty commitment: silently returning [] would manufacture a denominator
      // of zero out of corrupt data, which is the D-070 failure in reverse.
      // Never throws, never silent.
      if (typeof console !== "undefined" && console && console.warn) {
        console.warn('[OpsDash] Events: confirmWeek for "' + key + '" has a Note that is not ' +
          "a JSON array of strings; treating that week as UNCONFIRMED (no denominator) " +
          "rather than as an empty commitment. Fix the Note in the Sheet. Raw: " +
          raw.slice(0, 120));
      }
      return null;
    }

    return parsed;
  }

  function indexOf(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * Config access
   * ------------------------------------------------------------------ */

  function getConfig() {
    var cfg = root.OpsDashConfig;
    if (!cfg) throw new Error("OpsDashEvents requires OpsDashConfig to be loaded first.");
    return cfg;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ------------------------------------------------------------------ *
   * Read path (§3): full Events tab via Sheets API v4
   * ------------------------------------------------------------------ */

  /** Fetches the whole Events tab and returns parsed events[] (not folded). */
  function fetchEvents() {
    var cfg = getConfig();
    var url = cfg.sheetUrl(cfg.TABS.EVENTS);

    return fetch(url).then(function (response) {
      return response.text().then(function (text) {
        var body;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw new Error("Events read: response was not JSON: " + text.slice(0, 200));
        }
        if (!response.ok) {
          var msg = (body && body.error && body.error.message) || ("HTTP " + response.status);
          throw new Error("Events read failed: " + msg);
        }
        return parseRows(body.values || []).events;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * verifyEvent (§3 "Write-then-verify", D-047)
   * ------------------------------------------------------------------ */

  var VERIFY_TAIL = 40;
  var VERIFY_DELAYS_MS = [0, 500, 1000, 2000];

  function matches(ev, want) {
    return trimStr(ev.taskId) === trimStr(want.taskId) &&
      trimStr(ev.action) === trimStr(want.action) &&
      trimStr(ev.value) === trimStr(want.value === undefined ? "" : want.value) &&
      trimStr(ev.actor) === trimStr(want.actor);
  }

  /**
   * Confirms a (Task ID, Action, Value, Actor) row landed, re-reading the tail
   * of Events with backoff. Resolves {ok:true, event} on a hit — `event` is the
   * matched row, carrying the server's real Timestamp (a superset of the
   * {ok:true} the spec calls for; callers that only check `.ok` are unaffected,
   * and it saves the caller from approximating statusChangedAt with the
   * client's own clock). Otherwise {ok:false, error:"VERIFY_TIMEOUT"} (read
   * succeeded every time, row never appeared) or
   * {ok:false, error:"VERIFY_READ_FAILED", detail} (the read itself kept
   * failing — a different, less certain outcome; see D-044).
   */
  function verifyEvent(want) {
    function attempt(i, lastReadError) {
      return sleep(VERIFY_DELAYS_MS[i])
        .then(fetchEvents)
        .then(function (events) {
          var tail = events.slice(Math.max(0, events.length - VERIFY_TAIL));
          var hit = null;
          for (var i2 = tail.length - 1; i2 >= 0; i2--) {
            if (matches(tail[i2], want)) { hit = tail[i2]; break; }
          }
          if (hit) return { ok: true, event: hit };
          if (i + 1 < VERIFY_DELAYS_MS.length) return attempt(i + 1, null);
          return { ok: false, error: "VERIFY_TIMEOUT" };
        })
        .catch(function (err) {
          if (i + 1 < VERIFY_DELAYS_MS.length) return attempt(i + 1, err);
          return { ok: false, error: "VERIFY_READ_FAILED", detail: String(err.message || err) };
        });
    }
    return attempt(0, null);
  }

  /* ------------------------------------------------------------------ *
   * postEvent (§3 "Write path", D-046)
   * ------------------------------------------------------------------ */

  function doPostRequest(cfg, body, mode) {
    var opts = {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body
    };
    if (mode) opts.mode = mode; // "no-cors" only ever passed by the TypeError fallback below
    return fetch(cfg.WEB_APP_URL, opts);
  }

  /**
   * Posts one event and always resolves — never rejects — with either the
   * server's own result or verifyEvent's. See the module header for the exact
   * decision rule of which one wins.
   */
  function postEvent(action, taskId, value, actor, note) {
    var cfg = getConfig();
    var want = { taskId: taskId, action: action, value: value === undefined ? "" : value, actor: actor };
    var payload = {
      action: action,
      sprintId: cfg.SPRINT_ID,
      taskId: taskId,
      value: want.value,
      actor: actor,
      note: note || ""
    };
    var body = JSON.stringify(payload);

    function verify() {
      return verifyEvent(want);
    }

    return doPostRequest(cfg, body)
      .then(function (response) {
        return response.text().then(function (text) {
          var parsed = null;
          try { parsed = JSON.parse(text); } catch (err) { /* fall through to verify */ }

          if (parsed && parsed.ok === false) {
            // Server gave a definitive, specific reason — verify still runs (an
            // event this function "always ends in"), but that known reason is
            // what the caller sees, not a possible VERIFY_TIMEOUT masking it.
            return verify().then(function () { return parsed; });
          }
          // ok:true, or a response we couldn't parse: treat as "looked successful",
          // verify decides the real answer per §3.
          return verify();
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          // Network/CORS-level failure — the one case §3 allows a no-cors retry.
          // The response is opaque either way, so verify is the only source of truth.
          return doPostRequest(cfg, body, "no-cors")
            .catch(function () { /* still fall through to verify below */ })
            .then(verify);
        }
        // Anything else (e.g. a bad config throwing before fetch) must NOT
        // silently retry as no-cors (§3: only on TypeError). We still don't know
        // for certain the server never received it, so verify before giving up.
        return verify().then(function (v) {
          if (v.ok) return v;
          return { ok: false, error: "POST_FAILED", detail: String(err.message || err) };
        });
      });
  }

  root.OpsDashEvents = {
    HEADERS: HEADERS,
    parseRows: parseRows,
    fold: fold,
    toCurrentState: toCurrentState,
    deliverables: deliverables,
    pins: pins,
    pinEvents: pinEvents,
    discards: discards,
    cancels: cancels,
    weekCommitment: weekCommitment,
    fetchEvents: fetchEvents,
    postEvent: postEvent,
    verifyEvent: verifyEvent,
    _internals: {
      parseTimestampMs: parseTimestampMs,
      canonicalIso: canonicalIso,
      normalize: normalize,
      matches: matches
    }
  };
})(typeof window !== "undefined" ? window : this);
