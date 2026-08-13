/**
 * Operations Dashboard — Config
 * See /docs/spec.md §3 (backend) and §10 (conventions).
 */
(function (root) {
  "use strict";

  var CONFIG = {
    /* ---------- Structure source: the plan JSON, read-only (§3, §10) ---------- */
    PLAN: {
      // Production path is the repo root per §10. Fetched cache-busted because the
      // raw CDN can serve a stale copy for a while after a push (§3).
      RAW_URL: "https://raw.githubusercontent.com/F4LA/OperationsDashboard/main/sprint-plan.json"
    }

    /* ---------- Sheets API key / Apps Script Web App URL: later phase (§9 step 3) ---------- */
  };

  root.OpsDashConfig = CONFIG;
})(typeof window !== "undefined" ? window : this);
