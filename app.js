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
          root.OpsDashEvents.fetchEvents()
        ]).then(function (results) {
          var people = parsePeople(results[0]);
          var settings = parseSettings(results[1]);
          var events = results[2];

          var band = Number(settings.onTrackBandWorkDays);
          if (!(band >= 0)) band = 1; // fallback documented at the call site, never silently NaN

          var opsWeekStartDay = settings.opsWeekStartDay;
          if (!opsWeekStartDay) opsWeekStartDay = "Friday"; // fallback documented at the call site, never silently missing (D-061)

          var folded = root.OpsDashEvents.fold(events);
          var currentState = root.OpsDashEvents.toCurrentState(folded);
          var deliverables = root.OpsDashEvents.deliverables(folded);
          var pins = root.OpsDashEvents.pins(folded);

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
        });
      })
      .catch(function (err) {
        showStatus("Load failed: " + err.message, "error");
        if (root.console) root.console.error("[OpsDash]", err);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : this);
