/**
 * Operations Dashboard — App bootstrap
 *
 * Sequence: config sanity → sprint-plan.json (cache-busted + §7 validated) →
 * People + Settings (parallel, Sheets API v4) → Events (initial fold) →
 * planMode ONCE (frozen baseline for §5.2, never recomputed after this) →
 * OpsDashBoard.mount(). From that point board.js owns the page.
 */
(function (root) {
  "use strict";

  var statusEl;

  function showStatus(message, kind) {
    if (!statusEl) return;
    statusEl.className = "status " + kind;
    statusEl.textContent = message;
    statusEl.classList.remove("hidden");
  }

  function hideStatus() {
    if (!statusEl) return;
    statusEl.classList.add("hidden");
  }

  /* ------------------------------------------------------------------ *
   * Sheet parsers (D-033 schema)
   * ------------------------------------------------------------------ */

  function trimStr(v) {
    return v === undefined || v === null ? "" : String(v).trim();
  }

  /**
   * Same leniency as backend/Code.gs's isActive_ (D-040): blank means active,
   * so a half-filled-in People tab doesn't lock the whole team out. Kept
   * consistent with the server so the client-side actor list never offers a
   * name the backend would actually reject.
   */
  function isActiveCell(cell) {
    if (cell === true) return true;
    if (cell === false) return false;
    var s = trimStr(cell).toLowerCase();
    if (s === "") return true;
    return s === "true" || s === "yes" || s === "y" || s === "1" || s === "si" || s === "sí";
  }

  function parsePeople(rows) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var name = trimStr(r[0]);
      if (!name) continue;
      out.push({ name: name, active: isActiveCell(r[2]) });
    }
    return out;
  }

  function parseSettings(rows) {
    var settings = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var key = trimStr(r[0]);
      if (!key) continue;
      settings[key] = trimStr(r[1]);
    }
    return settings;
  }

  /**
   * Tasks tab (D-066, D-080) — one row per ad-hoc task, the plan-equivalent
   * for emergent work. Positional, same style as parsePeople/parseSettings.
   * Column order is the ACTUAL schema backend/Code.gs writes (TASKS_HEADERS):
   *   id | desc | owner | workDays | deadline | sourceIssueId | createdBy | createdAt
   *
   * Structural fields ONLY. status is deliberately absent: an ad-hoc task's
   * status is derived from the Events fold exactly like a plan task's (§3),
   * so there is one source of state, never two. `week` is likewise absent —
   * it is not a column on this row at all; it lives on the task's `pin`
   * event (D-066b — "every ad-hoc task is born with a week" is a guarantee
   * about the Events log, not about this tab). Callers needing a task's week
   * read it from OpsDashEvents.pins()/pinEvents(), the single source §3 fixes.
   *
   * @returns { [id]: {id, desc, owner, workDays, deadline, sourceIssueId, createdBy, createdAt} }
   */
  function parseTasks(rows) {
    var out = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var id = trimStr(r[0]);
      if (!id) continue;
      var workDaysRaw = r[3];
      var workDays = workDaysRaw === undefined || workDaysRaw === "" ? null : Number(workDaysRaw);
      out[id] = {
        id: id,
        desc: trimStr(r[1]),
        owner: trimStr(r[2]),
        workDays: (typeof workDays === "number" && isFinite(workDays)) ? workDays : null,
        deadline: trimStr(r[4]),
        sourceIssueId: trimStr(r[5]),
        createdBy: trimStr(r[6]),
        createdAt: trimStr(r[7])
      };
    }
    return out;
  }

  /**
   * Issues tab (§13.1, D-096) — one row per issue. Same D-080 discipline as
   * parseTasks above, and for the same reason: the row carries what is
   * STRUCTURAL and nothing that changes.
   *   id | sprintId | title | desc | raisedBy | raisedAt
   *
   * `status` and `resolution` are deliberately absent. An issue's open/
   * resolved state and HOW it resolved come from folding the Events log
   * (resolveIssue/unresolveIssue), exactly like a task's status — one source
   * of state, never two. That is also why the tab has no resolvedBy/
   * resolvedAt: the resolving event already carries its own actor and
   * timestamp, server-generated, and §13.4 reads the weeks-since-resolved
   * straight off it.
   *
   * @returns { [id]: {id, sprintId, title, desc, raisedBy, raisedAt} }
   */
  function parseIssues(rows) {
    var out = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var id = trimStr(r[0]);
      if (!id) continue;
      out[id] = {
        id: id,
        sprintId: trimStr(r[1]),
        title: trimStr(r[2]),
        desc: trimStr(r[3]),
        raisedBy: trimStr(r[4]),
        raisedAt: trimStr(r[5])
      };
    }
    return out;
  }

  function fetchSheetValues(cfg, tabName) {
    return fetch(cfg.sheetUrl(tabName)).then(function (response) {
      return response.text().then(function (text) {
        var body;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw new Error("Reading “" + tabName + "”: response was not JSON.");
        }
        if (!response.ok) {
          var msg = (body && body.error && body.error.message) || ("HTTP " + response.status);
          throw new Error("Reading “" + tabName + "” failed: " + msg);
        }
        return body.values || [];
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */

  function init() {
    statusEl = document.getElementById("board-status");
    var cfg = root.OpsDashConfig;

    if (!cfg) {
      showStatus("Load failure: dashboard/config.js did not load.", "error");
      return;
    }

    if (!cfg.isConfigured()) {
      showStatus(
        "Setup needed: dashboard/config.js is missing SHEET_ID / API_KEY / WEB_APP_URL. " +
        "Fill those in (Bernardo has the real values) and reload.",
        "error"
      );
      return;
    }

    showStatus("Loading sprint data…", "loading");

    root.OpsDashValidate.load(cfg.SPRINT_PLAN_URL)
      .then(function (loaded) {
        if (!loaded.ok) {
          throw new Error("sprint-plan.json failed validation:\n" +
            root.OpsDashValidate.formatReport(loaded.report));
        }
        var plan = loaded.plan;

        return Promise.all([
          fetchSheetValues(cfg, cfg.TABS.PEOPLE),
          fetchSheetValues(cfg, cfg.TABS.SETTINGS),
          root.OpsDashEvents.fetchEvents(),
          fetchSheetValues(cfg, cfg.TABS.TASKS),
          fetchSheetValues(cfg, cfg.TABS.ISSUES)
        ]).then(function (results) {
          var people = parsePeople(results[0]);
          var settings = parseSettings(results[1]);
          var events = results[2];
          var tasks = parseTasks(results[3]);   // D-080
          var issues = parseIssues(results[4]); // §13.1, D-096

          var band = Number(settings.onTrackBandWorkDays);
          if (!(band >= 0)) band = 1; // fallback documented at the call site, never silently NaN

          var opsWeekStartDay = settings.opsWeekStartDay;
          if (!opsWeekStartDay) opsWeekStartDay = "Friday"; // fallback documented at the call site, never silently missing (D-061)

          var folded = root.OpsDashEvents.fold(events);
          var currentState = root.OpsDashEvents.toCurrentState(folded);
          var deliverables = root.OpsDashEvents.deliverables(folded);
          var pins = root.OpsDashEvents.pins(folded);
          // §11/§12 (Phase 8 part 2B) — read once here, alongside the maps
          // above, so the todos view never re-folds Events on its own.
          var pinEvents = root.OpsDashEvents.pinEvents(folded);
          var discards = root.OpsDashEvents.discards(folded);
          var cancels = root.OpsDashEvents.cancels(folded);

          if (folded.warnings.length && root.console) {
            root.console.warn("[OpsDash] Events fold warnings:", folded.warnings);
          }

          // Frozen once, per §5.2 — nothing after this line ever calls planMode again.
          var frozenPlan = root.OpsDashEngine.planMode(plan);
          if (!frozenPlan.ok && root.console) {
            root.console.warn("[OpsDash] plan-mode baseline had scheduling errors:", frozenPlan.errors);
          }

          hideStatus();
          root.OpsDashBoard.mount({
            plan: plan,
            frozenPlan: frozenPlan,
            currentState: currentState,
            deliverables: deliverables,
            pins: pins,
            people: people,
            band: band,
            opsWeekStartDay: opsWeekStartDay
          });

          if (root.OpsDashTodos) {
            root.OpsDashTodos.mount({
              plan: plan,
              currentState: currentState,
              deliverables: deliverables,
              pins: pins,
              pinEvents: pinEvents,
              discards: discards,
              cancels: cancels,
              tasks: tasks,
              people: people,
              opsWeekStartDay: opsWeekStartDay,
              // The raw folded Events result (D-009), NOT just the derived
              // maps above: weekCommitment() (D-070) has to be re-read for
              // whichever week the person selects at runtime, so the view
              // needs the fold itself, not only a one-time snapshot of it.
              folded: folded
            });
          }

          if (root.OpsDashIssues) {
            root.OpsDashIssues.mount({
              issues: issues,
              tasks: tasks,            // the §13.4 join is on sourceIssueId
              currentState: currentState,
              resolutions: root.OpsDashEvents.issueResolutions(folded),
              people: people,
              opsWeekStartDay: opsWeekStartDay,
              folded: folded
            });
          }
        });
      })
      .catch(function (err) {
        showStatus("Load failed: " + err.message, "error");
        if (root.console) root.console.error("[OpsDash]", err);
      });
  }

  /**
   * The bootstrap's two Sheet readers, exported for ONE caller: the Issues
   * view (§13), which after raising an issue or creating a to-do has to
   * re-read the Issues and Tasks tabs. Both writes append a ROW, which no
   * amount of Events folding would reveal — refreshFromServer() in todos.js
   * re-folds events and would show neither.
   *
   * Exported rather than copied so there is one definition of "how a tab is
   * read and parsed". parseIssues/parseTasks in particular encode the D-080
   * rule that the row carries structure and never state; a second copy is
   * exactly where that rule would quietly rot.
   */
  root.OpsDashApp = {
    fetchSheetValues: fetchSheetValues,
    parseIssues: parseIssues,
    parseTasks: parseTasks,
    parsePeople: parsePeople,
    parseSettings: parseSettings
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : this);
