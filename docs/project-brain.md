# Project Brain — Operations Dashboard
The current state in one page. Updated at the close of every chat via the push Code session.
_Last updated: 2026-08-16 — Bernardo (D-087 deadline de milestone aprobado y pendiente de build; D-088 descarta la integración con Rock Projects; D-089 ataca la raíz del §8)_

> **Source of truth for WHAT to build** is the spec: `docs/spec.md` (v2.0.2).
> **Source of truth for WHY** is `docs/decision-log.md`.
> This Brain tracks WHERE the build stands.
> Repo: `F4LA/OperationsDashboard` (public). Local clone: `~/Desktop/StrongStandard/OperationsDashboard`.
> Live: https://f4la.github.io/OperationsDashboard/ (Sprint Board + métricas, desde Fase 5 — commit 06b568d)

## Current phase
Fase 8 parte 1 (backend) CERRADA y desplegada. createTask, discard/undiscard, cancel/uncancel y confirmWeek en producción en el Web App (Version 2 en su momento, misma URL; hoy en Version 3, ver Blocked/waiting). Pestaña Tasks creada con el esquema de D-066. Próximo: parte 2, partida por D-076 en 2A (lógica: events.js, engine.js, thisweek.js, metrics.js) y 2B (vista: todos.js, retiro de renderTw*, bump de versión). Parte 2A construida y pusheada en c025459 (regresión 478 verde; 60/60 plan y 17/17 live sin cambios; scope verificado byte a byte contra e84f718). Pase de correcciones de D-078 hecho y verificado en 626557e (regresión 525 verde; 60/60 y 17/17 sin cambios; board.js, app.js e index.html byte a byte idénticos a e84f718; versión sin subir en 20260814b). FASE 8 PARTE 2A CERRADA en d288b6a, verificada contra los archivos commiteados y no contra el reporte (precedente D-056): regresión 536 verde, 60/60 plan y 17/17 live sin cambios y sin un solo fixture editado, board.js / app.js / index.html byte a byte idénticos a e84f718, versión sin subir en 20260814b, todos.js sin crear. Toda la lógica del §11 y del §12 existe y está probada; no hay una sola pantalla que la consuma todavía. Próximo: parte 2B (la vista) en chat nuevo. Diseño de la parte 2B CERRADO en chat (D-080, D-081): layout de ficha por persona, confirmación única de semana desde el filtro Everyone, y un lector nuevo de la pestaña Tasks que la parte 1 dejó sin construir del lado del cliente. Falta construir: dashboard/todos.js, el lector de Tasks, el retiro de los renderTw* de board.js, el wiring en app.js y el bump de versión. Fase 8 parte 2B CONSTRUIDA, revisada contra los archivos commiteados y CERRADA en e67d20c. Regresión 536/536 sin cambios, 60/60 plan y 17/17 live intactos, ningún fixture editado, network.js borrado y confirmado 404, versión subida a 20260815a en los 8 assets. D-083 acepta la única desviación encontrada (MAX_NOTE_LEN duplicado en config.js). Las tres preguntas abiertas que BUILD había reportado quedaron cerradas por D-084/D-085/D-086: "current" ratificado igual a "closing"; done-antes-de-confirmar resultó estructuralmente inalcanzable, no una regla nueva; y createTask no necesita re-verificación propia del lado del cliente.

## Status
Fase 5 completa: la burn-up planned-vs-actual existe en dos scopes y la reproyección viva de §4.7 ahora se ve en pantalla en cada marca (antes se recalculaba en memoria pero solo se repintaba la fila marcada). Regresión 181/181. El tracking real arrancó el 2026-08-14 por backfill (D-058): las tareas completadas desde el 27 de julio se cargan con fecha de hoy, así que la curva "actual" tiene un salto vertical ese día por diseño, no por defecto.

Fase 3 backend completo, desplegado y probado de punta a punta contra el servidor REAL. Componentes: (1) backend/Code.gs — Apps Script doPost con todas las garantías del §3 (People leído en vivo, Event ID server-side formato D-034, Timestamp server-side con offset real y celda forzada a texto D-041, LockService, header guard, validación de Actor/Action/Value); (2) dashboard/events.js — fold de Events (D-009) que produce el shape currentState de D-027, verificado por round-trip completo contra el fixture de Fase 2 (events→fold→currentState→liveMode da idéntico a expected-live-mode.json); (3) tests/appsscript-smoke.test.js — harness Node que pega al Web App real.

Resultado del smoke test contra el Web App desplegado por Bernardo: 74/74 verde — 7 escrituras aceptadas con write-then-verify real vía Sheets API v4, 16+ rechazos server-side (actor desconocido/inactivo, action inválida, cada Value mal formado, javascript: URL bloqueada, pin no-lunes). Header-guard verificado a mano: renombrar Events!D1 de "Action" a "Actions" hizo que TODA escritura fallara con HEADER_DRIFT nombrando la columna, sin escribir nada; restaurado, 74/74 de nuevo. Concurrencia verificada a mano: 20 escrituras casi simultáneas (mismo taskId, disparadas en paralelo) → 20 filas completas, 20 Event ID distintos, cero colisiones, cero filas a medio escribir.

Motor de Fase 2 sin cambios (plan 60/60, live 17/17). Node sigue sin estar instalado en la máquina de build para las suites de Fase 2 (D-022): el smoke test de Fase 3 SÍ corrió con Node real en la máquina de Bernardo.

Nota de seguridad (consistente con el "no auth" del §3, no es un defecto): la URL del Web App no tiene restricción de origen — cualquiera que la tenga puede escribir en el log. La API key de lectura sí está restringida por referrer a https://f4la.github.io/*.

## Done
- Full design approved and captured (decision-log D-006 … D-015): data model, date engine logic, metrics, views, identity/backend, This Week + pin + deliverable link, and what's deferred.
- Engineering spec written and approved — `docs/spec.md` (v1.1 en su momento, hoy en v2.0.2; hand-reformatted from the Word original; content complete, worth a diff against the original if byte-exactness ever matters).
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
- Fase 5 (Métricas, §5): metrics.js con burnupSeries (D-053), gráfica SVG inline sprint-wide + por Rock, y diffAndRepaint (D-054). Commits 45f8afd y 06b568d. Probada E2E en f4la.github.io con la reproyección cross-dependencia visible en pantalla. tests/burnup.test.js (24 checks) commiteado; regresión total 181/181.
- Fase 7 (This Week §6.3 + pin manual): dashboard/thisweek.js con opsWeek/buckets/availableToPull/cascadeOf, todas puras; vista con control segmentado y persistencia en opsdash.view; pull, postpone-con-cascada y release por el postEvent/verifyEvent existente; opsWeekStartDay por fin consumido en app.js. Commit 9c0ee25. tests/thisweek.test.js: 67 checks; regresión total 248/248. Decisiones: D-061, D-062, D-063, D-064.
- Fase 8 parte 1 — backend (commits 5262844 + b08646f). Regresión 327 (mock harness de 55 → 134). Smoke contra el Web App real: 155/0. Ids T-0001…T-0004 creados por las corridas de prueba.
- Fase 8 parte 2A — lógica del §11 y §12 (d288b6a). events.js: proyecciones discards / cancels / weekCommitment y pinEvents con timestamp, con pins() reproyectada desde ella y su shape intacto. engine.js: cancel por el camino de collectActive, pasado solo desde liveMode; plan mode inmune por firma. thisweek.js: opsWeek con offset y availableToPull devolviendo las bloqueadas con blockedBy nombrando dueño. metrics.js: weeklyCompletion del §12, cancelado fuera del denominador del §5.1, escalar de cancelados en la burn-up sin recalcular la curva planificada. backend/Code.gs: tope de Note para todo evento (D-075). Decisiones que salieron de acá: D-075 a D-079.
- Fase 8 parte 2B — la vista (e67d20c): lector de Tasks en app.js (D-080), dashboard/todos.js completo (§11 layout de D-081, §12 resumen), retiro de renderTw* de board.js y borrado de network.js (D-082b), versión 20260815a. Decisiones que salieron de acá: D-080, D-081, D-082, D-083.

## Repo layout (as built)
```
OperationsDashboard/
├── README.md · index.html · app.js · styles.css   (real, Fase 4, commit 1acc181)
├── sprint-plan.json   (real, root — production, per D-016)
├── backend/Code.gs   (real, Apps Script Web App, D-035)
├── dashboard/  validate.js engine.js events.js board.js metrics.js thisweek.js todos.js (real; network.js borrado, D-082b)
├── tests/  engine.test.js · expected-plan-mode.json   (real, D-022)
│          live-engine.test.js · expected-live-mode.json
│          scenario-live-mode.json · current-state-live-mode.json   (real, D-027–D-032)
│          appsscript-smoke.test.js   (real, D-037)
│          thisweek.test.js   (real, D-061–D-064)
├── data/rock3-seed.json   (real, test fixture, per D-016)
└── docs/  spec.md (real, v2.0.2) · decision-log.md · project-brain.md
```
Module globals use the `OpsDash` prefix; stubs in `/dashboard`, `app.js` at root — matching CoachPulse.

## In progress
- Nada activo en código.

## Next up (per spec §9)
- Campo `deadline` de milestone (D-087, spec v2.0.2): construir ANTES de cargar R1 y R2, o el hard deadline del portal de afiliados de Miguel (5 de septiembre) se pierde en silencio al cargar.
- Fase 8 CERRADA por completo (parte 1 + 2A + 2B). Próximo: carga de los 2 Rocks faltantes (Miguel, Setter de Emery) sobre los 3 del sprint (R3 ya adentro), único bloqueante real que queda para que el dashboard refleje el sprint entero — en espera de datos, no de diseño.
- Fase 6 (Network / Timeline): CANCELADA por D-082. dashboard/network.js y su <script> se borran en el pase de la 2B. Prototipos de referencia si alguna vez se retoma: Rock3_Network_Graph.html (barras de espera punteadas, más simple) y Rock3_Interactive_Timeline.html (más avanzado, .deps vacío preparado); ninguno dibuja conectores de dependencia.

## Blocked / waiting
- Nada bloqueado. Pendiente NO bloqueante: los dos procedimientos manuales de D-037 (header-guard y concurrencia) YA se corrieron y pasaron — ya no quedan pendientes.
- Carga de Rocks en espera de datos, no de diseño. Se suben tres Rocks en total (además del R3 ya cargado): el de Miguel (September Challenge), el de Bernardo/Brent (R3, ya adentro) y el Setter Rock de Emery. El Closer Rock de Emery queda EXCLUIDO de este dashboard por ahora — lo confirmó Bernardo, no es parte del alcance actual. Ninguno de los documentos que llegaron trae workDays/waitDays por tarea, que es lo único que el schema de §2 exige y que las fechas objetivo por milestone no reemplazan — son la estimación de los dueños del Rock para todo el milestone junto, no una duración por tarea, y repartirlas hacia atrás se descartó a propósito por inventar precisión que nadie garantizó. Se le pidió a Emery (Setter) y a Miguel que anoten cada tarea con [DONE] o [NOT DONE — X días], más [WAIT — X días] donde aplique. Raíz del problema: el proyecto Operating System arma estos documentos con fecha-por-milestone en vez de duración-por-tarea; corregirlo de raíz implica tocar ese proyecto y el de Rock Builder (posiblemente con el Rock Builder verificando esto antes de aceptar un Rock) — diferido hasta que Bernardo comparta el contenido de ambos proyectos en un chat futuro.
- REDESPLIEGUE MANUAL DEL WEB APP: RESUELTO. Bernardo desplegó Version 3 el 2026-08-15 (backend/Code.gs ya igualado al repo, D-075 cerrado). El Web App vivo ya no está atrasado respecto al repo.
- PASE VISUAL PENDIENTE, no bloqueante y DESPUÉS de la 2B: Bernardo reporta que el dashboard se lee apretado y demasiado uniforme — tipografía, aire entre filas y falta de un color que subraye lo importante. Aplica a todo el dashboard, no solo al §11. Se abre en su propio chat cuando la 2B esté cerrada, mismo procedimiento que D-050, para no mezclar rediseño con vista nueva.
- Las tres preguntas abiertas de la 2B quedaron cerradas por D-084/D-085/D-086, sin construir nada nuevo: "current" ratificado igual a "closing", el escenario del denominador resultó estructuralmente inalcanzable, y createTask no necesita re-verificación propia.

## Deferred (not being actively worked)
- Vista 4 (auto-update from Rock Projects) — D-014, superseded by D-088: no longer deferred, DISCARDED outright.
- Retirar Asana y que el Project Builder emita el JSON siguen downstream (D-014). En cambio "Operating System producing Rock-3-level planning detail" YA NO está diferido: se atacó de raíz en D-089 (template nuevo con capa de tareas, Sprint Planning en tres bloques, proyecto Rock Planner para el bloque 2). Falta ejecutarlo fuera de este repo — reemplazar el template y reescribir el Sprint Planning Meeting Playbook en el proyecto Operating System, antes del próximo Sprint Planning (~13 de septiembre).
- Integración dashboard ↔ Rock Projects: DESCARTADA por D-088, no diferida. No reabrir sin argumento nuevo.
- Gantt/Network (Fase 6): CANCELADA por D-082, no diferida. Ver Next up para el detalle de qué se borra.
- Prototipos de referencia de la Fase 6 cancelada, localizados el 2026-08-14 en el disco de Bernardo (fuera de este repo): Rock3_Network_Graph.html y Rock3_Interactive_Timeline.html. Hallazgos guardados por si algún día se retoma: las filas son por MILESTONE agrupadas por Project (no carriles por persona — lo "por persona" se resolvió con botones de filtro); el Interactive Timeline es la mejor base pero perdió las barras punteadas de espera que sí tiene el Network Graph; ninguno de los dos dibuja conectores de dependencia (los muestra como texto), aunque el CSS del Interactive dejó un `.deps` preparado y vacío.
- Carga automática del documento de Rock al dashboard: hoy el §8 lo lista como "Project Builder emite el JSON", conveniencia downstream. Pedido explícito de Bernardo (2026-08-14) de dejarlo registrado.
- Pulido menor de This Week: el dropdown "+ add to this week" lista también tareas que ya se muestran en la columna de esa persona, así que aparecen duplicadas. Inofensivo. Revisar después de una semana de uso real.
- Borrar la burn-up se evaluó el 2026-08-14 y se descartó (D-071d): el pie numérico ya da el veredicto, la curva agrega cuándo empezó el desvío a costo cero.

## Open decisions
- D-025 provisional: semántica de executionOrder y de "Both" multi-persona, a confirmar antes del primer plan que las ejercite. No bloquea nada hoy (Rock 3 no las usa).
  Confirmado contra el sprint-plan.json en vivo (2026-08-13): cero apariciones de executionOrder en los 47 tasks, y people == ["Brent","Bernardo"] == el conjunto exacto de owners del Rock, así que los 18 tasks "Both" ejercitan la semántica de recurso pero no la ambigüedad. Sigue sin bloquear.
- D-030 es una aproximación práctica (seeding de availableFrom desde done); revisar si un sprint real la contradice. (Mismo tono que D-025.)
- D-060 declara que las dependencias no cruzan Rocks. Revisable: si un sprint futuro necesita entrelazar Rocks, `crossDependsOn` ya está soportado, aunque la Fase 6 que hubiera dibujado ese conector quedó cancelada por D-082, no solo diferida.
- D-063(c) fija que el pin NO reproyecta (el motor no recibe pins; es un override de bucket, no de fechas). Revisable si un sprint real pide que el pin mueva la proyección.
- D-063(e) queda superseded por D-071(b): availableToPull ahora debe devolver también las tareas bloqueadas, marcadas y nombrando su bloqueador.
- D-068(f) (no cancelación masiva de milestone/proyecto) es revisable si pasa dos veces en un sprint real.
- D-068(c) es la primera modificación a engine.js desde la Fase 2. Vigilar con especial atención la regresión del motor (60/60 plan, 17/17 live) cuando se implemente.
- Tope de Note: RESUELTO por D-075 — MAX_NOTE_LEN = 5000 aplica a todo Note, un solo número consumido por servidor y frontend. Cierra el punto que D-072 había dejado abierto.

## Key dates
- No hard external deadline on the dashboard itself. Target: Views 1–3 usable in the first build week; This Week + pin + link layer (Fase 7) shipped ahead of Gantt/Timeline (Fase 6, cancelled by D-082). (Sprint being tracked, for reference: S3-2026, ends 2026-09-13.)
