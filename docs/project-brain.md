# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-13 — Bernardo (Phase 2 plan mode completa y verde; D-024–D-026 registradas)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v1.1).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live (placeholder): https://f4la.github.io/OperationsDashboard/

## Current phase
Phase 2 (date engine) — plan mode COMPLETO y verde (commit 8246e65). Falta live mode (§4.7), que depende de timestamps reales. En un chat nuevo se decide si live mode va ahora (testeable con timestamps sintéticos) o después de la Fase 3 (backend).

## Status
Motor de fechas en plan mode implementado, commiteado (8246e65) y verde: 60 checks, 0 fallos, las 46 tareas activas reproducen tests/expected-plan-mode.json EXACTO (fixture byte-idéntico, verificado con diff). M13-t1 correctamente excluida (deferred, D-017). Rollup §4.6: Rock R3 cierra 2026-09-14 → rojo (1 día pasado sprint.end), con M4/M7/M20/M23 en rojo — exactamente lo anticipado por D-023, no es bug. NOTA OPERATIVA: Node NO está instalado en la máquina de build; el test (script Node plano por D-022) se corrió sin modificar bajo JavaScriptCore con un shim CommonJS del scratchpad, y se verificó además en el navegador real (camino window) con idéntico resultado. Pendiente: correr `node tests/engine.test.js` una vez con Node real.

## Done
- Full design approved and captured (decision-log D-006 … D-015): data model, date engine logic, metrics, views, identity/backend, This Week + pin + deliverable link, and what's deferred.
- Engineering spec written and approved — `docs/spec.md`, v1.1 (hand-reformatted from the Word original; content complete, worth a diff against the original if byte-exactness ever matters).
- Rock 3 seed written and validated — `data/rock3-seed.json` (6 projects, M1–M23, 47 tasks, 40.75 work-days, zero unresolved dependencies).
- Repo `F4LA/OperationsDashboard` created (public), scaffolded, and pushed — commit `cdc249a` "Phase 0: repo scaffold, stub modules, and reference docs". Local and origin identical, clean tree.
- GitHub Pages enabled and live (placeholder loads, 9 scripts load with zero console errors, unstyled as expected).
- `gh` CLI installed to `~/bin/gh`, `~/.zshrc` PATH updated, authenticated to the shared F4LA account via device flow.
- Phase 1 built and committed — `sprint-plan.json` (root) + §7 validation in `dashboard/validate.js` — commit `3a43bb5` "Phase 1: sprint-plan.json load + §7 validation (D-016)". Validation semantics fixed via D-017 (milestone-level deferred propagation), D-018 (split cycle detection: task-scheduling graph vs. milestone dependsOn graph), D-019 (errors-vs-warnings taxonomy).
- Fase 2 (diseño): semántica y algoritmo del motor de fechas congelados (D-020–D-023) y validados con motor de referencia contra Rock 3. Fixture de fechas esperadas (plan mode, 46 tareas activas) generado para commitear en tests/expected-plan-mode.json.
- Fase 2 plan mode: dashboard/engine.js escrito, commiteado (8246e65) y verde contra el fixture (46/46, 0 desvíos). tests/engine.test.js + tests/expected-plan-mode.json commiteados (D-022). Semántica D-020/D-021 confirmada por las cadenas fraccionarias reales de Rock 3. Guardas de milestone deferred/vacío (§4.6) implementadas y probadas.

## Repo layout (as built)
```
OperationsDashboard/
├── README.md · index.html (placeholder) · app.js (stub) · styles.css (stub)
├── sprint-plan.json   (real, root — production, per D-016)
├── dashboard/  events.js metrics.js board.js network.js thisweek.js  (stubs) · validate.js engine.js (real)
├── tests/  engine.test.js · expected-plan-mode.json   (real, D-022)
├── data/rock3-seed.json   (real, test fixture, per D-016)
└── docs/  spec.md (real, v1.1) · decision-log.md · project-brain.md
```
Module globals use the `OpsDash` prefix; stubs in `/dashboard`, `app.js` at root — matching CoachPulse.

## In progress
- Nada activo. Fase 2 plan mode cerrada. Live mode (§4.7) o Fase 3 es lo siguiente, en chat nuevo.

## Next up (per spec §9)
- **Decisión de secuencia (pendiente con Bernardo):** live mode §4.7 ahora (reproyección desde timestamps; testeable YA con un fixture de timestamps sintéticos, sin backend) vs. Fase 3 primero (Sheet + Apps Script §3) y live mode después con timestamps reales.
- **Fase 3:** Google Sheet (tabs People/Events/Settings) + Apps Script doPost con todas las garantías del §3 (identidad, event id/timestamp server-side, LockService, header guard, write-then-verify).
- Pendiente técnico menor: correr el test con `node` real cuando Node esté instalado.

## Blocked / waiting
- Nothing.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014.
- Retire Asana, Project Builder emitting the JSON, Operating System producing Rock-3-level planning detail — all downstream, after the dashboard is built and proven (D-014).
- Google Sheet + Apps Script backend, Sprint Board, metrics, This Week, pin, Gantt — all not started; they come in later phases per §9.

## Open decisions
- D-025 provisional: semántica de executionOrder y de "Both" multi-persona, a confirmar antes del primer plan que las ejercite. No bloquea nada hoy (Rock 3 no las usa).
- Secuencia live mode vs Fase 3 — a decidir al abrir el próximo chat.

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; Gantt (View 2) and This Week + pin + link layer follow. (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
