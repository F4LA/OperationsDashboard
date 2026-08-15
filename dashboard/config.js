/**
 * Operations Dashboard — Config
 * See /docs/spec.md §3 (backend), §10 (conventions), D-045 (safe to commit real
 * values here: the read key is referrer-restricted, and a browser-side Web App
 * URL is never secret regardless of where it lives).
 */
(function (root) {
  "use strict";

  var CONFIG = {
    /* ---------- Identity of the sprint this deployment tracks ---------- */
    // Must match the `sprint.id` inside sprint-plan.json. Used only as the
    // sprintId field on every posted event — the plan's own sprint.id (once
    // fetched) is what the rest of the app treats as authoritative.
    SPRINT_ID: "S3-2026",

    /* ---------- Structure source: the plan JSON, read-only (§3, §10) ---------- */
    // Production path is the repo root per §10. Fetched cache-busted because the
    // raw CDN can serve a stale copy for a while after a push (§3).
    SPRINT_PLAN_URL: "https://raw.githubusercontent.com/F4LA/OperationsDashboard/main/sprint-plan.json",

    /* ---------- Backend (§3) ---------- */
    SHEET_ID: "1eYyKrIIRmBSH0tzq5T0JxZJahK8Hepxl2-UNwPbJZ9Q",
    API_KEY: "AIzaSyBEVkTpgPdKMkvx5Bp4EuExWsPqRiTvLJc",
    WEB_APP_URL: "https://script.google.com/macros/s/AKfycbz_t2Z5jDc15oaXyYXA-JirD31EBEgqPJrv0HRRn33_TTNqMWPRgA0sTFojKd4v1HFR3Q/exec",

    /* ---------- Sheet tabs (D-033 schema; Tasks added D-066/D-080) ---------- */
    TABS: {
      PEOPLE: "People",
      EVENTS: "Events",
      SETTINGS: "Settings",
      TASKS: "Tasks"
    },

    /* ---------- Identity persistence (§3 "Option B") ---------- */
    ACTOR_STORAGE_KEY: "opsdash.actor",

    /* ---------- View persistence (§6.3, D-062) ---------- */
    VIEW_STORAGE_KEY: "opsdash.view",

    /**
     * The single source of this number for the WHOLE frontend (D-075). Must
     * match backend/Code.gs's own MAX_NOTE_LEN exactly — that file is the
     * enforcement, this one is only so the reason/note input can show a live
     * counter and disable its confirm button before the round-trip, instead
     * of the person typing a paragraph and finding out only after the server
     * rejects it. Two copies of one number is the exact D-024/D-088 scar this
     * project keeps citing; if the server's cap ever changes, this is the
     * one other place that has to change with it.
     */
    MAX_NOTE_LEN: 5000,

    /**
     * Builds a Sheets API v4 read URL for one tab (§3 read path). `range`,
     * if given, is appended after "!" (e.g. "A:H"); omitted reads the whole tab.
     */
    sheetUrl: function (tabName, range) {
      var base = "https://sheets.googleapis.com/v4/spreadsheets/" + this.SHEET_ID + "/values/";
      var target = range ? tabName + "!" + range : tabName;
      return base + encodeURIComponent(target) + "?key=" + this.API_KEY;
    },

    /** True once SHEET_ID/API_KEY/WEB_APP_URL have real values. */
    isConfigured: function () {
      return !!(this.SHEET_ID && this.API_KEY && this.WEB_APP_URL);
    },

    /**
     * "Today" as YYYY-MM-DD in the VIEWER's local calendar — deliberately local
     * getters (getFullYear/getMonth/getDate), not toISOString(). The engine's
     * whole axis is local operational days (§4.1); toISOString() reports the UTC
     * date, which is already "tomorrow" for hours every evening in US time
     * zones. Read fresh on every call — never cached — so a tab left open past
     * midnight picks up the new day on its next mark/refresh.
     */
    todayISO: function () {
      var d = new Date();
      var m = d.getMonth() + 1;
      var day = d.getDate();
      return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
    }
  };

  root.OpsDashConfig = CONFIG;
})(typeof window !== "undefined" ? window : this);
