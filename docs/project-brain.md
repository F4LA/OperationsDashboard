# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-13 — Bernardo (Fase 4 completa y probada E2E, D-049; pase de
rediseño visual intercalado antes de Fase 5, D-050)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v1.1).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live: https://f4la.github.io/OperationsDashboard/ (Sprint Board, since Fase 4 — commit 1acc181)

## Current phase
Fase 4 (Sprint Board, Views 1+3, §6) — COMPLETA y probada E2E en navegador real
(commit 1acc181, D-049). Antes de Fase 5 se intercala un pase de rediseño visual
(D-050) en un chat de diseño dedicado: jerarquía visual (proyecto/milestone/tarea),
control de status como dropdown, y alertas de overshoot auto-explicadas. Fase 5
(métricas) queda detrás del pase visual.

## Status
Fase 3 backend completo, desplegado y probado de punta a punta contra el servidor REAL. Componentes: (1) backend/Code.gs — Apps Script doPost con todas las garantías del §3 (People leído en vivo, Event ID server-side formato D-034, Timestamp server-side con offset real y celda forzada a texto D-041, LockService, header guard, validación de Actor/Action/Value); (2) dashboard/events.js — fold de Events (D-009) que produce el shape currentState de D-027, verificado por round-trip completo contra el fixture de Fase 2 (events→fold→currentState→liveMode da idéntico a expected-live-mode.json); (3) tests/appsscript-smoke.test.js — harness Node que pega al Web App real.

Resultado del smoke test contra el Web App desplegado por Bernardo: 74/74 verde — 7 escrituras aceptadas con write-then-verify real vía Sheets API v4, 16+ rechazos server-side (actor desconocido/inactivo, action inválida, cada Value mal formado, javascript: URL bloqueada, pin no-lunes). Header-guard verificado a mano: renombrar Events!D1 de "Action" a "Actions" hizo que TODA escritura fallara con HEADER_DRIFT nombrando la columna, sin escribir nada; restaurado, 74/74 de nuevo. Concurrencia verificada a mano: 20 escrituras casi simultáneas (mismo taskId, disparadas en paralelo) → 20 filas completas, 20 Event ID distintos, cero colisiones, cero filas a medio escribir.

Motor de Fase 2 sin cambios (plan 60/60, live 17/17). Node sigue sin estar instalado en la máquina de build para las suites de Fase 2 (D-022): el smoke test de Fase 3 SÍ corrió con Node real en la máquina de Bernardo.

Nota de seguridad (consistente con el "no auth" del §3, no es un defecto): la URL del Web App no tiene restricción de origen — cualquiera que la tenga puede escribir en el log. La API key de lectura sí está restringida por referrer a https://f4la.github.io/*.

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
- Fase 2 live mode (diseño): algoritmo de 3 pasadas fijado (D-027–D-031). Motor de referencia construido reutilizando validate.js real + los helpers exactos de engine.js (mismo eje D-020, mismo comparador D-021). Fixture sintético generado y verde: tests/expected-live-mode.json (5 tareas, 4 milestones, escenario: done-temprano, done-tarde-con-wait, in_progress-con-clamp, open-Both, open-join-cruzado). today fijo = 2026-08-13.
- Fase 2 live mode: dashboard/engine.js extendido con OpsDashEngine.liveMode (algoritmo de 3 pasadas, D-027–D-032), commit b55e2be. Test harness y fixtures commiteados: tests/live-engine.test.js, tests/expected-live-mode.json, tests/scenario-live-mode.json, tests/current-state-live-mode.json.
- Fase 4 (Sprint Board, Views 1+3, §6): dashboard/config.js (3 valores de producción
  horneados), events.js extendido con postEvent/verifyEvent (write-then-verify,
  backoff 0/500/1000/2000ms), board.js (Sprint Board completo), metrics.js (§5.1/§5.2
  como módulo propio — adelanta parte de Fase 5), app.js bootstrap, styles.css base
  CoachPulse, más divisor visual de Project para el badge cuttable de §7. Commit 1acc181.
  Regresión 157/157. Probada E2E en navegador real (D-049).

## Repo layout (as built)
```
OperationsDashboard/
├── README.md · index.html · app.js · styles.css   (real, Fase 4, commit 1acc181)
├── sprint-plan.json   (real, root — production, per D-016)
├── backend/Code.gs   (real, Apps Script Web App, D-035)
├── dashboard/  network.js thisweek.js  (stubs) · validate.js engine.js events.js board.js metrics.js (real)
├── tests/  engine.test.js · expected-plan-mode.json   (real, D-022)
│          live-engine.test.js · expected-live-mode.json
│          scenario-live-mode.json · current-state-live-mode.json   (real, D-027–D-032)
│          appsscript-smoke.test.js   (real, D-037)
├── data/rock3-seed.json   (real, test fixture, per D-016)
└── docs/  spec.md (real, v1.1) · decision-log.md · project-brain.md
```
Module globals use the `OpsDash` prefix; stubs in `/dashboard`, `app.js` at root — matching CoachPulse.

## In progress
- Nada activo en build. Siguiente: pase de rediseño visual (chat de diseño, D-050),
  luego Fase 5.

## Next up (per spec §9)
- **Pase de rediseño visual** (fuera de la secuencia §9, intercalado por D-050): chat
  de diseño dedicado. No agrega funcionalidad; fija jerarquía visual y patrones que
  Fases 5–7 reúsan.
- **Fase 5:** Métricas (§5) — barra de progreso ya existe (metrics.js); falta la
  gráfica burn-up planned-vs-actual y confirmar la reproyección live en cada marca.

## Blocked / waiting
- Nada bloqueado. Pendiente NO bloqueante: los dos procedimientos manuales de D-037 (header-guard y concurrencia) YA se corrieron y pasaron — ya no quedan pendientes.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014.
- Retire Asana, Project Builder emitting the JSON, Operating System producing Rock-3-level planning detail — all downstream, after the dashboard is built and proven (D-014).
- This Week, pin, Gantt — not started; they come in later phases per §9. Metrics (§5) partially started (progress bar in metrics.js per Fase 4); burn-up chart still pending Fase 5.

## Open decisions
- D-025 provisional: semántica de executionOrder y de "Both" multi-persona, a confirmar antes del primer plan que las ejercite. No bloquea nada hoy (Rock 3 no las usa).
- D-030 es una aproximación práctica (seeding de availableFrom desde done); revisar si un sprint real la contradice. (Mismo tono que D-025.)

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; Gantt (View 2) and This Week + pin + link layer follow. (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
