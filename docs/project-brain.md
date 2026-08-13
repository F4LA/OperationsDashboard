# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-13 — Bernardo (D-017–D-019 locked; Phase 1 complete)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v1.1).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live (placeholder): https://f4la.github.io/OperationsDashboard/

## Current phase
Phase 1 complete → Phase 2 (date engine) is next, and should start in a fresh chat.

## Status
`sprint-plan.json` created at the repo root (production) alongside `data/rock3-seed.json` (test fixture, per D-016). `dashboard/validate.js` now has real §7 validation logic — errors vs. warnings taxonomy (D-019), milestone-level deferred propagation (D-017), and cycle detection split across the task-scheduling graph and the milestone dependsOn graph (D-018). Remaining modules (`engine.js`, `events.js`, `metrics.js`, `board.js`, `network.js`, `thisweek.js`) are still empty stubs.

## Done
- Full design approved and captured (decision-log D-006 … D-015): data model, date engine logic, metrics, views, identity/backend, This Week + pin + deliverable link, and what's deferred.
- Engineering spec written and approved — `docs/spec.md`, v1.1 (hand-reformatted from the Word original; content complete, worth a diff against the original if byte-exactness ever matters).
- Rock 3 seed written and validated — `data/rock3-seed.json` (6 projects, M1–M23, 47 tasks, 40.75 work-days, zero unresolved dependencies).
- Repo `F4LA/OperationsDashboard` created (public), scaffolded, and pushed — commit `cdc249a` "Phase 0: repo scaffold, stub modules, and reference docs". Local and origin identical, clean tree.
- GitHub Pages enabled and live (placeholder loads, 9 scripts load with zero console errors, unstyled as expected).
- `gh` CLI installed to `~/bin/gh`, `~/.zshrc` PATH updated, authenticated to the shared F4LA account via device flow.
- Phase 1 built and committed — `sprint-plan.json` (root) + §7 validation in `dashboard/validate.js` — commit `3a43bb5` "Phase 1: sprint-plan.json load + §7 validation (D-016)". Validation semantics fixed via D-017 (milestone-level deferred propagation), D-018 (split cycle detection: task-scheduling graph vs. milestone dependsOn graph), D-019 (errors-vs-warnings taxonomy).

## Repo layout (as built)
```
OperationsDashboard/
├── README.md · index.html (placeholder) · app.js (stub) · styles.css (stub)
├── sprint-plan.json   (real, root — production, per D-016)
├── dashboard/  config.js engine.js events.js metrics.js board.js network.js thisweek.js  (stubs) · validate.js (real, §7 logic)
├── data/rock3-seed.json   (real, test fixture, per D-016)
└── docs/  spec.md (real, v1.1) · decision-log.md · project-brain.md
```
Module globals use the `OpsDash` prefix; stubs in `/dashboard`, `app.js` at root — matching CoachPulse.

## In progress
- Nothing actively being coded. Phase 1 done; Phase 2 (date engine) is next and should start in a fresh chat.

## Next up (per spec §9)
- **Phase 2 (the heavy one):** the date engine (§4), plan mode first, validated so computed dates reproduce Rock 3's expected parallelism/floor. Everything depends on it, so it goes before any UI.
- **Carry into Phase 2 (from D-017):** a fully-deferred milestone (all tasks deferred, e.g. M13) has no non-deferred tasks, so §4.6 rollup (max over non-deferred tasks) and the §5.1 denominator must skip it, not compute over an empty set.
- **Carry into Phase 2:** an empty milestone (0 tasks) hits the same empty-max in §4.6 — only a warning today (none exist in Rock 3), but the engine must guard against it.

## Blocked / waiting
- Nothing.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014.
- Retire Asana, Project Builder emitting the JSON, Operating System producing Rock-3-level planning detail — all downstream, after the dashboard is built and proven (D-014).
- Google Sheet + Apps Script backend, Sprint Board, metrics, This Week, pin, Gantt — all not started; they come in later phases per §9.

## Open decisions
- None. D-005 resolved by D-016; D-017/D-018/D-019 (this session) locked.

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; Gantt (View 2) and This Week + pin + link layer follow. (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
