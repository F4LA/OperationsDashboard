# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-13 — Bernardo (D-016: resolved D-005, plan-JSON location)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v1.1).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live (placeholder): https://f4la.github.io/OperationsDashboard/

## Current phase
Phase 0 complete → starting Phase 1 (spec §9 step 1: load + validate the seed JSON).

## Status
Repo scaffolded and live. All logic still to be written — every `.js` module is an empty stub. Next real work is the JSON fetch + validation, then the date engine.

## Done
- Full design approved and captured (decision-log D-006 … D-015): data model, date engine logic, metrics, views, identity/backend, This Week + pin + deliverable link, and what's deferred.
- Engineering spec written and approved — `docs/spec.md`, v1.1 (hand-reformatted from the Word original; content complete, worth a diff against the original if byte-exactness ever matters).
- Rock 3 seed written and validated — `data/rock3-seed.json` (6 projects, M1–M23, 47 tasks, 40.75 work-days, zero unresolved dependencies).
- Repo `F4LA/OperationsDashboard` created (public), scaffolded, and pushed — commit `cdc249a` "Phase 0: repo scaffold, stub modules, and reference docs". Local and origin identical, clean tree.
- GitHub Pages enabled and live (placeholder loads, 9 scripts load with zero console errors, unstyled as expected).
- `gh` CLI installed to `~/bin/gh`, `~/.zshrc` PATH updated, authenticated to the shared F4LA account via device flow.

## Repo layout (as built)
```
OperationsDashboard/
├── README.md · index.html (placeholder) · app.js (stub) · styles.css (stub)
├── dashboard/  config.js validate.js engine.js events.js metrics.js board.js network.js thisweek.js  (all stubs, OpsDash* globals)
├── data/rock3-seed.json   (real)
└── docs/  spec.md (real, v1.1) · decision-log.md · project-brain.md
```
Module globals use the `OpsDash` prefix; stubs in `/dashboard`, `app.js` at root — matching CoachPulse.

## In progress
- Nothing actively being coded right now. Design and scaffold are done; build resumes at Phase 1.

## Next up (per spec §9)
- **Phase 1, first step:** create `sprint-plan.json` at the repo root (production copy of the Rock 3 content, per D-016 / spec §10) — a BUILD session task, not yet done.
- **Phase 1:** write the cache-busted raw-URL fetch of the seed + the §7 validation logic in `dashboard/validate.js`, pointed at the root `sprint-plan.json`.
- **Phase 2 (the heavy one):** the date engine (§4), plan mode first, validated against the Rock 3 seed. Everything depends on it, so it goes before any UI.

## Blocked / waiting
- Nothing.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014.
- Retire Asana, Project Builder emitting the JSON, Operating System producing Rock-3-level planning detail — all downstream, after the dashboard is built and proven (D-014).
- Google Sheet + Apps Script backend, Sprint Board, metrics, This Week, pin, Gantt — all not started; they come in later phases per §9.

## Open decisions
- None. D-005 resolved by D-016 (2026-08-13): Option B — keep both `sprint-plan.json` (root, production) and `data/rock3-seed.json` (test fixture).

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; Gantt (View 2) and This Week + pin + link layer follow. (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
