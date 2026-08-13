# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-13 — Bernardo (D-020–D-023 locked; Phase 2 engine design frozen, ready for BUILD)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v1.1).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live (placeholder): https://f4la.github.io/OperationsDashboard/

## Current phase
Phase 2 (date engine) — diseño y decisiones congelados (D-020–D-023). El engine en sí NO está codeado todavía; listo para que la sesión BUILD lo implemente en dashboard/engine.js contra el fixture tests/expected-plan-mode.json.

## Status
Diseño del motor de fechas cerrado en el chat de diseño. Semántica fijada: eje continuo de días laborales para fracciones + reglas de fin/espera (D-020), algoritmo de scheduling determinista con recomputo tras cada tarea y desempate por task.id (D-021). Validado con un motor de referencia contra los 47 tasks reales de Rock 3: paralelismo de dueños distintos, tareas "Both", tiempos de espera calendario, cross-dependencia M18-t1→M6-t3, y exclusión de M13 (deferred) — todo reproduce lo esperado. Hallazgo confirmado y aceptado: Rock 3 cierra 2026-09-14, un día pasado sprint.end → rojo desde el arranque, sin ajustar el motor (D-023). Harness permanente definido en /tests (D-022). Falta: que la sesión BUILD escriba dashboard/engine.js + tests/ y reproduzca el fixture.

## Done
- Full design approved and captured (decision-log D-006 … D-015): data model, date engine logic, metrics, views, identity/backend, This Week + pin + deliverable link, and what's deferred.
- Engineering spec written and approved — `docs/spec.md`, v1.1 (hand-reformatted from the Word original; content complete, worth a diff against the original if byte-exactness ever matters).
- Rock 3 seed written and validated — `data/rock3-seed.json` (6 projects, M1–M23, 47 tasks, 40.75 work-days, zero unresolved dependencies).
- Repo `F4LA/OperationsDashboard` created (public), scaffolded, and pushed — commit `cdc249a` "Phase 0: repo scaffold, stub modules, and reference docs". Local and origin identical, clean tree.
- GitHub Pages enabled and live (placeholder loads, 9 scripts load with zero console errors, unstyled as expected).
- `gh` CLI installed to `~/bin/gh`, `~/.zshrc` PATH updated, authenticated to the shared F4LA account via device flow.
- Phase 1 built and committed — `sprint-plan.json` (root) + §7 validation in `dashboard/validate.js` — commit `3a43bb5` "Phase 1: sprint-plan.json load + §7 validation (D-016)". Validation semantics fixed via D-017 (milestone-level deferred propagation), D-018 (split cycle detection: task-scheduling graph vs. milestone dependsOn graph), D-019 (errors-vs-warnings taxonomy).
- Fase 2 (diseño): semántica y algoritmo del motor de fechas congelados (D-020–D-023) y validados con motor de referencia contra Rock 3. Fixture de fechas esperadas (plan mode, 46 tareas activas) generado para commitear en tests/expected-plan-mode.json.

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
- Sesión BUILD: implementar dashboard/engine.js (plan mode) + carpeta /tests, reproduciendo tests/expected-plan-mode.json. Live mode (§4.7) queda para después de que plan mode pase.

## Next up (per spec §9)
- **Cerrar Fase 2:** BUILD implementa el engine en plan mode; verde cuando reproduce el fixture. Luego live mode (§4.7, reproyección desde timestamps reales).
- **Fase 3:** Google Sheet (tabs People/Events/Settings) + Apps Script doPost con todas las garantías del §3.
- Las guardas de milestone deferred/vacío (§4.6, §5.1) — antes "carry into Phase 2" — ya están cubiertas en el diseño (D-017 + guard de max vacío) y probadas en la referencia; BUILD solo debe implementarlas.

## Blocked / waiting
- Nothing.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014.
- Retire Asana, Project Builder emitting the JSON, Operating System producing Rock-3-level planning detail — all downstream, after the dashboard is built and proven (D-014).
- Google Sheet + Apps Script backend, Sprint Board, metrics, This Week, pin, Gantt — all not started; they come in later phases per §9.

## Open decisions
- None. D-020–D-023 (esta sesión) locked. No quedan decisiones abiertas de diseño para el motor.

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; Gantt (View 2) and This Week + pin + link layer follow. (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
