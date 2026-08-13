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
   * Current pin per task (§3, §6.3). pin sets the ISO Monday; unpin clears it.
   * Because pin and unpin are separate actions, the fold keeps the latest of
   * EACH — so the winner is whichever of the two happened most recently.
   */
  function pins(input) {
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

      if (trimStr(pinEv.value)) out[taskId] = trimStr(pinEv.value);
    }

    return out;
  }

  function indexOf(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
    return -1;
  }

  root.OpsDashEvents = {
    HEADERS: HEADERS,
    parseRows: parseRows,
    fold: fold,
    toCurrentState: toCurrentState,
    deliverables: deliverables,
    pins: pins,
    _internals: {
      parseTimestampMs: parseTimestampMs,
      canonicalIso: canonicalIso,
      normalize: normalize
    }
  };
})(typeof window !== "undefined" ? window : this);
