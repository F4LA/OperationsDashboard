# Operations Dashboard — Engineering Specification v2.0

> **v2.0 (2026-08-14)** — El producto se reencuadra: deja de ser un dashboard de Rocks y pasa a ser el dashboard de operaciones del leadership team, la herramienta con la que se corre el L10. El motor de Rocks (§2, §4, §5) queda intacto y pasa a ser un módulo. Se agregan: tareas ad-hoc y la vista de to-dos (§11), cierre semanal (§12) e issues (§13, por especificar). Las secciones §2, §4 y §5 NO cambiaron respecto de v1.1 — están construidas, probadas y referenciadas por el decision log. La numeración existente se conserva entera a propósito: el decision log referencia secciones por número 78 veces.

> **v2.0.1 (2026-08-14)** — Enmiendas del diseño de la Fase 8, antes de construir: cancelación de tareas de Rock (§11.4, D-068), contrato de createTask (§3, D-066), eventos discard/cancel/confirmWeek y sus reversas (§3, D-067/D-068/D-069/D-070), y tratamiento de lo cancelado en métricas (§5.1, §5.2, §12). La numeración de secciones no cambia.

**Company:** Strong Standard
**Author of spec:** design chat (Operating System project)
**Status:** For approval. Nothing gets built until this is approved.
**Builder:** Claude Code (separate step, after approval). This chat does not build.

---

## 0 · Purpose & scope

### What this is

A single central view of every Rock in a sprint, in the structure Sprint → Rock → Project → Milestone → Task, that answers — without asking anyone — three questions: what is done, is each Rock going to close on time, and where is the work blocked or waiting.

It replaces Asana for Rock/sprint execution. Everyone on the team opens it, marks their own tasks as they finish them, and Bernardo reads progress and on-track status mid-week and at L10 without chasing people. The machine does the accountability; it does not add supervision work.

### What v1 IS

- A **date engine**: dates are computed from task durations + dependencies + per-person capacity. No dates are ever typed in.
- A **task board**: tasks grouped by milestone, each with a checkbox. Marked live by whoever did the work. No order is imposed on screen.
- Two **derived metrics** whose primary unit is the Rock: a duration-weighted progress bar, and an on-track / behind indicator (real progress vs. the plan's expected progress for today). A sprint-wide roll-up exists but is a small secondary summary, not the main signal.
- A **"This Week" view**: per person, three buckets — done this week / working on / not started — scoped to the operations week (Friday after the L10 → Thursday).
- A **manual pin** inside This Week: pull a future task forward or postpone one; every move is validated by the engine first (allowed / refused-with-reason / allowed-but-cascades).
- A **deliverable link box** on every task: paste the Drive/GHL/PDF link, stored with the task, so every output lives in one place.
- A **network/timeline (Gantt) view** driven by the engine's computed dates (evolution of the existing `Rock3_Network_Graph.html` prototype).
- **Multi-user** with a person-selector (identity, not login), reusing the proven testimonial-dashboard pattern.

### What v2 adds (the reframe)

v1 assumed all work comes from the sprint plan. It doesn't. The L10 also produces to-dos that belong to no Rock, and issues that generate more to-dos. A dashboard that only shows Rock work shows a fraction of what a person actually committed to that week, which makes it useless as an accountability surface — the exact job it exists to do.

So v2 recognises **two origins of work**:

- **Planned work** — born in Sprint Planning, lives in `sprint-plan.json`, projected by the engine (§4).
- **Emergent work** — born during the week (an ad-hoc to-do, or a to-do that came out of an issue), lives in the Sheet, never touched by the engine.

Both are tasks. Both are marked the same way. Both appear in the to-do view (§11). What differs is where they come from and whether the engine computes them.

### What v1 is NOT (explicitly out of scope — see §8)

- No auto-update from the Rock Projects (the "Vista 4" idea). Confirmed not viable today: Rock Projects do not store per-task status in any machine-readable field. Deferred.
- No in-app editing of the plan structure. To change the plan, regenerate the JSON (§2).
- Note the boundary this draws: v2 lets people CREATE emergent work in-app (§11, §13), but still never lets them edit the sprint plan's structure in-app. The plan stays immutable per sprint; only emergent work is authored live.
- No login/password/auth. Identity is honor-based name-selection.
- Does not itself modify the Project Builder, the Rock 3 project, or the sprint-planning process. Those are downstream changes made after this spec is approved and the dashboard is proven (see §8).

---

## 1 · Core concepts & data model

Five levels. The Task is the atomic unit — everything is computed and marked at the task level.

```
Sprint
└── Rock
    └── Project
        └── Milestone
            └── Task   ← atomic unit (owner, type, durations, dependencies, live status)
```

### Task properties

| Field | Meaning | Source |
|---|---|---|
| `id` | Unique task id, e.g. `M2-t1` | INPUT (JSON) |
| `desc` | Human-readable description | INPUT |
| `owner` | `"Brent"`, `"Bernardo"`, or `"Both"` | INPUT |
| `type` | `"work"` (active work), `"meeting"` (live/joint), `"approval"` (waiting on a yes) | INPUT |
| `workDays` | Active working days the owner is occupied (fractions allowed, e.g. 0.5) | INPUT |
| `waitDays` | Calendar days of waiting after the work, during which the owner is free | INPUT |
| `dependsOn` | List of task or milestone ids that must finish first (may point anywhere in the sprint) | INPUT |
| `crossDependsOn` | Same as `dependsOn`, but semantically flagged as crossing Rocks/Projects (for the visual) | INPUT |
| `hardDeadline` | Optional ISO date; used only as a priority tiebreak | INPUT (optional) |
| `deferred` | If true, excluded from projection and from the progress denominator until activated | INPUT (optional) |
| `status` | `open` / `in_progress` / `done` | STATE — marked live, NOT in the JSON |
| `plannedStart`, `plannedFinish` | Computed dates | COMPUTED (engine) |

### The four data responsibilities (this is the whole philosophy in one table)

| Class | What | Who owns it |
|---|---|---|
| **INPUT** | Structure, owners, type, workDays, waitDays, dependencies, optional executionOrder | The `sprint-plan.json` file (§2), regenerated when the plan changes |
| **COMPUTED** | Every start/finish date, milestone dates, Rock finish date | The date engine (§4). Never typed. |
| **MARKED** | status per task | The person, live, in the dashboard (§3) |
| **DERIVED** | Milestone status, Rock health, progress %, on-track | Folded from MARKED + COMPUTED (§5) |

Key separation: structure and state live in different places, mirroring how a Rock Project separates `master-plan.md` (structure) from `project-brain.md` (state).

- **Structure** = `sprint-plan.json`, committed to the dashboard repo, fetched read-only. Immutable per sprint; changing it means regenerating and re-committing the file.
- **State** = the Google Sheet event log, mutable, written live as people mark tasks.

The two are joined by `id`: a status event in the Sheet references the id of a task in the JSON.

### Emergent work — the second origin (v2)

Ad-hoc tasks (§11) and issues (§13) are created live, so they are structure and state at the same time. Rather than bend them into the JSON (immutable per sprint) or into the event log (which records changes, not objects), they get their own Sheet tabs — and then reuse the existing state machinery unchanged.

**Ad-hoc task properties**

| Field | Meaning | Source |
|---|---|---|
| `id` | Server-assigned, `T-0001` — a namespace that cannot collide with plan task ids (`M9-t2`) | SERVER |
| `desc` | What has to be done | Typed |
| `owner` | Exactly one person from the People tab. `"Both"` is NOT valid — emergent work has one owner | Typed |
| `workDays` | Estimated working days, fractions allowed (0.5, 1, 2). MANDATORY on creation | Typed |
| `deadline` | Optional ISO date. Only flags overdue in the view; never feeds the engine | Typed (optional) |
| `sourceIssueId` | The issue this came out of, if any (§13) | Set by the convert-to-todo flow |
| `createdBy`, `createdAt` | Server-generated identity and timestamp, per §3 | SERVER |
| `status` | `open` / `in_progress` / `done` / `discarded` — the SAME status set and the SAME event as a plan task | STATE (event log) |
| `week` | Which ops week it sits in — carried by the `pin` event, see below | STATE (event log) |

An ad-hoc task has **no dependencies**. That is deliberate: work with dependencies belongs in a Rock plan. It does carry an estimated `workDays`, but that estimate feeds exactly one thing — the capacity warning in §11.5 — and never the engine. An ad-hoc task never moves a projected date, never creates a dependency, and never changes a Rock's on-track chip.

The estimate is mandatory rather than optional on purpose. Ad-hoc tasks are normally created together during the L10, where the person is asked how long it will take, so the estimate costs nothing there. Making it optional outside the meeting would reintroduce partial data through the back door, and a capacity total where some tasks are estimated and some are not is worse than no total at all: it looks trustworthy and isn't.

**The consequence, stated plainly so nobody misreads the chip:** the on-track indicator means "on track against the Rock's plan", not "on track against this person's real week". Someone can carry three days of ad-hoc work and still show green. The dashboard tells you whether the Rock is advancing as planned; it does not tell you whether the person is overloaded. The capacity warning in §11.5 is what covers that, and it is a separate signal.

**Week assignment reuses `pin`.** The `pin` event (§3) already assigns a task to an ops week via that week's ISO Monday (D-061). For plan tasks it overrides the engine's projection. For ad-hoc tasks it is the ONLY source of week. Three states fall out with no new machinery:

- **No week** = an ad-hoc task with no pin. Representable, but not built in v2 (§11.6).
- **In a week** = pinned to that week's Monday key.
- **Moved** = a later pin to a different Monday key. Every move stays in the append-only log, so "moved three weeks running" is visible without tracking it separately.

There is deliberately no pipeline and no stage field. A stage would be a second, redundant way to express what status + pin already express.

**Discarding, not deleting.** A task that will not be done is closed with a `discard` event carrying a mandatory reason. It leaves the view and stays in the log. Nothing is ever deleted — the discard rate is itself a signal (§12).

**Issue properties**

| Field | Meaning | Source |
|---|---|---|
| `id` | Server-assigned, `I-0001` | SERVER |
| `title` | Short name, what shows in the list | Typed |
| `desc` | The context needed to discuss it later | Typed |
| `raisedBy`, `raisedAt` | Server-generated | SERVER |
| `status` | `open` / `resolved` | STATE (event log) |
| `resolution` | `discussed_no_action` or `todo_created` — mandatory on resolve | STATE |

Issues are raised **during the week**, not only in the meeting, so the Issues view has to be usable on its own and not only inside the L10 flow.

An issue cannot be closed without stating how it closed. That single constraint is what makes the IDS measurable: at sprint end you can see how many issues closed with no action versus how many produced work. One issue may produce more than one to-do.

**A resolved issue is not finished work.** Closing the issue and doing what came out of it are different things. That is why a generated to-do keeps `sourceIssueId`: not to reopen the issue, but so the dashboard can surface "this issue was closed in week 3 and its to-do is still open three weeks later" — the case that silently disappears today.

---

## 2 · The input contract — sprint-plan.json

This is the file Bernardo (or, later, the Project Builder — see §8) produces for each sprint. The dashboard reads it; it never writes it. It contains structure only, no status and no dates (dates are computed, status is marked).

### Schema

```json
{
  "schemaVersion": "1.0",
  "sprint": {
    "id":     "S3-2026",
    "name":   "Sprint 3 2026",
    "start":  "2026-07-27",          // ISO. First working day the engine counts from.
    "end":    "2026-09-13",          // sprint end; anything computed past this flags red
    "goLive": "2026-09-14"
  },
  "people": ["Brent", "Bernardo"],   // participants in this sprint (informational; the
                                     // actionable actor list lives in the People sheet, §3)
  "rocks": [
    {
      "id":       "R3",
      "name":     "Improve the onboarding experience",
      "owners":   ["Brent", "Bernardo"],
      "cuttable": false,             // informational; if a whole Rock/Project can be cut
      "projects": [
        {
          "id":        "P1",
          "name":      "Baseline Data and Measurement System",
          "objective": "Establish historical baselines and ongoing measurement.",
          "owner":     "Both",
          "milestones": [
            {
              "id":        "M2",
              "name":      "Baselines locked + refund target % set",
              "dependsOn": ["M1"],
              "tasks": [
                { "id": "M2-t1", "desc": "Pull satisfaction data → overwhelm baseline",
                  "owner": "Brent",    "type": "work", "workDays": 1, "waitDays": 0,
                  "dependsOn": ["M1"], "crossDependsOn": [] },
                { "id": "M2-t2", "desc": "Pull refund rate post-kickoff, set target %",
                  "owner": "Bernardo", "type": "work", "workDays": 1, "waitDays": 0,
                  "dependsOn": ["M1"], "crossDependsOn": [] },
                { "id": "M2-t3", "desc": "Lock refund target into Rock KPI",
                  "owner": "Both",     "type": "work", "workDays": 1, "waitDays": 0,
                  "dependsOn": ["M2-t1", "M2-t2"], "crossDependsOn": [] }
              ]
            }
          ]
        }
      ],
      "executionOrder": {            // OPTIONAL — see §4.4
        "Brent":    ["M1", "M2-t1"],
        "Bernardo": ["M12-t1", "M2-t2"]
      }
    }
  ]
}
```

### Rules the file must obey (the dashboard validates on load — §7)

- Every id is unique across the whole sprint.
- Every id in any `dependsOn` / `crossDependsOn` must resolve to a real task id or milestone id in the sprint.
- `owner` ∈ {a name from `people`, `"Both"`}.
- `type` ∈ {`work`, `meeting`, `approval`}.
- `workDays` ≥ 0, `waitDays` ≥ 0, fractions allowed.
- No dependency cycles.
- `status` MUST NOT appear in this file. If present, the dashboard ignores it (status is Sheet-owned).

### Illustrative real fragments (from Rock 3), showing the concepts the engine must handle

- **Parallel, different owners:** `M2-t1` (Brent) and `M2-t2` (Bernardo) both depend only on `M1` → they run at the same time.
- **A "Both" join task:** `M2-t3` waits for both `M2-t1` and `M2-t2` and occupies both people.
- **Wait time:** `M3-t1` = `workDays: 0.5`, `waitDays: 4` (reach out, then wait 3–4 days for replies; owner free during the wait).
- **Meeting task:** `M12-t2` `type: "meeting"` (live framework decision, both owners present).
- **Cross-dependency across Projects:** the shipment-dashboard task in Project 5 has `crossDependsOn: ["M6-t3"]` (needs the address field from the new intake form in Project 2).
- **Deferred:** `M13` (`deferred: true`) — personality inputs, revisited only at end of sprint.

The complete Rock 3 seed JSON (all 6 projects, M1–M23) is produced as the next deliverable, once this schema is approved. It is the real data the dashboard is first built and tested against.

---

## 3 · State & backend — identity, storage, write path

Reuses the testimonial-dashboard pattern verbatim where it earned its complexity, plus the three improvements agreed from that project's own "what I'd change" notes.

### Architecture

```
Frontend (GitHub Pages, vanilla JS, no build step)
  ├── GET  sprint-plan.json     via raw.githubusercontent.com  (structure, read-only, no token)
  ├── GET  Sheet tabs           via Sheets API v4 + referrer-restricted key  (state, read)
  └── POST status events        via Apps Script Web App (doPost)             (state, write)
```

Structure comes from the repo (versioned, like the Rock Projects' `.md` files). Mutable state comes from the Sheet. Two different mechanisms, one HTTP verb each — same split as the testimonial dashboard.

### Identity — Option B (person-selector), not login

- A person-selector in the topbar ("Acting as ▾"). Picking a name sets the actor.
- Single source for the people list: a dedicated **People** tab in the Sheet, read by the frontend on load and by the Apps Script on every write. (Improvement #1 — do NOT hardcode the list twice; the testimonial project's own incident D-088 was two copies drifting apart.)
- Selection persists in `localStorage` (key e.g. `opsdash.actor`), re-validated against the live People list on read; an optional `?actor=` URL param may override once and then persist.
- No auth. Anyone with the link can act as any listed name. This is an internal audit trail, not access control — a deliberate, explicit choice for a small trusted team.
- The selector only answers "whose view is this." It does not impose task order and does not gate marking. The board is identical regardless of who is selected; the selector enables an optional "show only my tasks" filter and attributes each mark.

### Sheet tabs

| Tab | Columns | Purpose |
|---|---|---|
| **People** | Name \| Slack/email (opt) \| Active | Single source of who can act. |
| **Events** | Event ID \| Sprint ID \| Task ID \| Action \| Value \| Actor \| Timestamp \| Note | Append-only log of every action. |
| **Settings** | Key \| Value \| Notes | Runtime thresholds (on-track amber/red bands, the operations-week start day). Never hardcoded. |

One generalized append-only log holds every kind of action, distinguished by the Action column with the payload in Value:

- `setStatus` → Value ∈ {`open`, `in_progress`, `done`} — a task's live status.
- `setDeliverable` → Value = a URL (Drive/GHL/PDF) — the task's deliverable link.
- `pin` / `unpin` → Value = the ISO Monday of the week the task is pinned into (blank for unpin) — a manual override of the projection (§6.3).
- `discard` / `undiscard` → Value blank, Note mandatory on discard (the reason). Only valid for ad-hoc ids (`T-NNNN`); the server rejects any other id (D-067).
- `cancel` / `uncancel` → Value blank, Note mandatory on cancel (the reason). Only valid for ids NOT in the `T-NNNN` namespace, i.e. plan tasks (D-068).
- `confirmWeek` → Task ID = `WEEK-<ISO Monday>`, Value = the ISO Monday, Note = the JSON array of frozen task ids. Freezes §12's denominator for that week (D-070).

Current state is derived, not stored: fold Events by (Task ID, Action), take the latest by Timestamp → current status, current deliverable link, current pin, current discard/cancel state per task, and the frozen week commitments. Append-only gives a full audit trail (who did what, when) and the completion timestamps the burn-up needs.

Two more tabs, added in v2:

- **Tasks** — one row per ad-hoc task (§11). Columns: `id | desc | owner | workDays | deadline | sourceIssueId | createdBy | createdAt`. Row ids are server-assigned in the `T-NNNN` namespace and never reused.
- **Issues** — one row per issue (§13). Columns: `id | title | desc | raisedBy | raisedAt | status | resolution | resolvedBy | resolvedAt`.

The Events log is NOT extended structurally. Marking an ad-hoc task uses the same `setStatus` event as a plan task, and assigning it to a week uses the same `pin` event — one status mechanism for both origins of work. The new actions are discard/undiscard, cancel/uncancel and confirmWeek. discard and cancel carry a mandatory note (the reason); their reversals mirror pin/unpin and fold onto the same slot (D-069).

Every §3 guarantee already in force applies to these tabs verbatim: server-generated timestamps and identity, write-then-verify, People read from one source, stable row ids.

### Write path (ported from testimonial — these are scars, not preferences)

- POST as a CORS "simple request": `fetch(WEB_APP_URL, { method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body: JSON.stringify(payload) })`. Body is valid JSON; Apps Script reads `e.postData.contents` regardless of the declared type. This avoids the preflight OPTIONS that Apps Script Web Apps don't answer, and keeps the response readable.
- `mode:"no-cors"` ONLY as a fallback inside the `catch` on a `TypeError`. Never as the default. (An earlier version used `no-cors` unconditionally; a server-side failure looked identical to success because the body was opaque. That bug is why this is written this way.)
- Write-then-verify: after a successful-looking POST, re-read the last ~40 rows of Events via the read API and confirm a row matching (Task ID, Action, Value, Actor) appeared, retrying with backoff before reporting success. Apps Script append and Sheets read are not instantly consistent.

### Apps Script `doPost` — server-side guarantees

Two RPC actions: `appendEvent` (the event log) and `createTask` (a row in the Tasks tab, D-066). On every write, the server:

- Reads the People tab live and rejects an Actor not in it. (This — not the dropdown — is the real enforcement.)
- Rejects an Action not in {`setStatus`, `setDeliverable`, `pin`, `unpin`, `discard`, `undiscard`, `cancel`, `uncancel`, `confirmWeek`}, and validates Value for that action: the status enum for `setStatus`; a well-formed URL for `setDeliverable`; an ISO Monday for `pin` and for `confirmWeek`; blank for `unpin`, `discard`, `undiscard`, `cancel` and `uncancel`. It also enforces the namespace rules (D-067, D-068) and the mandatory note on `discard` and `cancel`.
- Rejects an empty Task ID.
- Generates the Event ID server-side — a real stable id (e.g. a monotonic counter or `Date.now()+"-"+rand`), never row position. (Improvement #4 — position-based identity breaks on any insert/sort/restore.)
- Generates the Timestamp server-side from the spreadsheet's own timezone. Client clock is irrelevant.
- Serializes concurrent writes with `LockService`.
- Runs a header guard: refuses to write if the tab's headers have drifted.
- For `createTask`: assigns the row id server-side in the `T-NNNN` namespace under the same lock, rejects an owner that is not exactly one active person ("Both" gets its own named error), requires `workDays > 0` and a mandatory `week`, and appends that week's `pin` event inside the same locked section — so an ad-hoc task can never exist without a week.

### Read path

Sheets API v4 with a browser API key restricted by referrer to the GitHub Pages origin (`https://f4la.github.io/*`, origin-scoped, not path-scoped — browsers send only the origin as Referer, so a path restriction silently fails every request).

For `sprint-plan.json`, fetch the raw GitHub URL with a cache-busting query param (`?nocache=<timestamp>`), because the raw CDN can serve a stale copy for a while after a push.

---

## 4 · The date engine (the core; heaviest piece)

Dates are outputs. The engine takes the JSON structure + (optionally) the live statuses and produces a start/finish date for every task, milestone, and Rock. It runs in two modes: plan mode (all tasks assumed open → the frozen baseline) and live mode (using real completion timestamps → the current projection).

### 4.1 Calendar helpers

```
isWorkingDay(date)         → true if Mon–Fri (weekend list from sprint.workweek; default Mon–Fri)
addWorkingDays(date, n)    → advance n working days, skipping weekends; supports fractional n
                             (a 0.5 workDay occupies half of one working day)
addCalendarDays(date, n)   → advance n calendar days (weekends included) — used for waitDays
nextWorkingDay(date)       → date itself if a working day, else the following Monday
```

### 4.2 Graph construction

```
tasks   = flatten every task across all rocks/projects/milestones
depsOf(task):
    resolve each id in task.dependsOn + task.crossDependsOn:
      - if it is a TASK id      → that task must be finished
      - if it is a MILESTONE id → ALL tasks of that milestone must be finished
    return the resulting set of prerequisite tasks
validate: no cycles (topological sort must succeed); every referenced id resolves
exclude: tasks with deferred=true are removed from scheduling entirely (until activated)
```

### 4.3 Resource model

Each person has an `availableFrom` date, initialized to `nextWorkingDay(sprint.start)`.
A task with owner `"Both"` consumes BOTH owners: it can only start when every one of its owners is free, and it advances all of their `availableFrom` dates.
A person does exactly one task at a time.

### 4.4 Ordering of ready tasks (resolves the open decision)

When one person has several tasks whose dependencies are all satisfied at the same time, the engine needs an order to project dates. This order is invisible — it never appears on screen and never tells anyone what to do. It exists only to compute a finish date.

If `rock.executionOrder[person]` is provided → use it as the order for that person.
Otherwise (default) → auto-order ready tasks by priority:

```
(a) unblocks the most downstream work   (count of tasks that transitively depend on it)
(b) has the earliest hardDeadline
(c) has the longest total duration (workDays + waitDays)
```

`executionOrder` is therefore optional. Most sprints will omit it and let the engine derive by priority. It exists as an override for when Bernardo wants to pin a specific order. Reality always wins: in live mode, the engine reprojects from actual completion timestamps, so whatever real order happened overrides both the pin and the priority guess.

### 4.5 Scheduling loop

```
scheduled = {}
while some non-deferred task is unscheduled:
    ready = tasks whose every prerequisite (4.2) is already scheduled/finished,
            and which are not yet scheduled
    if ready is empty and unscheduled tasks remain → dependency error (report it, §7)
    order `ready` per person using 4.4
    for each task in that order:
        depFinish   = max(plannedFinish of its prerequisites)   (or sprint.start if none)
        resourceFree= max(availableFrom of its owner(s))
        start       = nextWorkingDay( max(depFinish, resourceFree) )
        workEnd      = addWorkingDays(start, task.workDays)
        finish       = addCalendarDays(workEnd, task.waitDays)   // wait is calendar, owner free
        for each owner of the task: owner.availableFrom = workEnd  // free DURING the wait
        task.plannedStart  = start
        task.plannedFinish = finish
        scheduled[task.id] = task
```

### 4.6 Roll-up

```
milestone.plannedFinish = max(plannedFinish over its non-deferred tasks)
rock.plannedFinish      = max(plannedFinish over its milestones)
FLAG a milestone/Rock red if its plannedFinish > sprint.end
```

### 4.7 Live mode (reprojection)

In live mode, a task marked `done` is fixed to its ACTUAL completion date (from the latest Status Log event's Timestamp), not its planned date. Its owner became free then.
Re-run 4.5 for the remaining open/in_progress tasks starting from "today", using real `availableFrom` values implied by what has actually been completed.
This yields the CURRENT projected finish for every unfinished milestone and Rock.

> **Note on the "source plan date conflicts":** because dates are computed, not typed, conflicts like "M23 retro dated before its dependency M22 finishes" cannot occur here — the engine simply schedules M23 after M22 by construction. The dashboard's job is only to flag when a computed finish exceeds `sprint.end`.

---

## 5 · Metrics

### 5.1 Duration-weighted progress bar (per Rock, and sprint-wide)

Weight each task by `workDays` only (active work, not wait — otherwise a shipping wait would inflate progress and mislead).

```
progress(scope) = Σ workDays of DONE tasks in scope
                  ─────────────────────────────────
                  Σ workDays of ALL non-deferred tasks in scope
```

A 21-day task marked done counts far more than a 1-day task — which is the point. `in_progress` earns no partial credit in v1 (binary crediting; partial credit deferred).

Cancelled work-days (D-068) leave the denominator and are displayed beside the bar as a separate total. They are never hidden and never left inside: leaving them in would keep the Rock from ever reaching 100% and hold the light red for work nobody is going to do.

### 5.2 On-track vs. behind (burn-up)

Two cumulative-work curves over the sprint calendar:

- **Planned curve** (frozen baseline): run the engine in plan mode once at ingest and freeze it. At any date D, planned work done = Σ workDays of tasks whose planned finish ≤ D. Because waits sit correctly in the plan, the planned curve is naturally flat during a shipping/reply wait — so it will not raise a false "behind" while you wait on a supplier.
- **Actual curve:** at date D, actual work done = Σ workDays of tasks marked done on or before D (using Status Log timestamps).

On-track test at today's date:

```
gap = actual(today) − planned(today)
gap ≥ 0                     → ON TRACK (green)
−band < gap < 0            → SLIGHTLY BEHIND (amber)   band from Settings
gap ≤ −band                → BEHIND (red)
```

This compares real progress against what the plan expected for today, not against flat calendar time. That is the leading indicator — the thing Asana cannot give.

The planned curve is never recalculated when something is cancelled — it stays frozen per D-053. The numeric footer names the cancelled days separately.

### 5.3 What Bernardo sees per Rock

The Rock is the primary unit for both metrics — this is what he checks mid-week and, in the This Week view, per person. The sprint-wide roll-up (§6) is a small secondary summary he can glance at or ignore.

- Duration-weighted progress bar.
- On-track indicator (green/amber/red) + the current projected finish date vs. `sprint.end` (the red flag when it overshoots).
- Optionally the small burn-up chart (planned vs. actual line).

---

## 6 · Views

### View 1 + View 3 — the Sprint Board (one screen; input display + live tracking are the same surface)

- Topbar: sprint name, person-selector, sprint-wide progress bar + on-track chip.
- Rocks as tabs or stacked sections. Each Rock header: progress bar, on-track chip, projected finish vs sprint end.
- Inside a Rock: milestones as groups, and under each, its tasks as checkable rows. No order is imposed — tasks are shown grouped by milestone, and are checked in whatever order they actually happen.
- Each task row shows: description, owner, type badge, workDays(+waitDays if any), computed planned finish, and a status control cycling open → in_progress → done. meeting/approval and crossDependsOn get a small badge so joint/waiting/cross-Rock items are visible at a glance.
- Each task row also has a deliverable link box: paste the Drive/GHL/PDF link for that task's output; it saves a `setDeliverable` event and renders as a clickable link thereafter, so every deliverable lives on its task (no hunting through folders).
- Marking a task writes a Status Log event (§3) and triggers a live reprojection (§4.7) and metric refresh.
- Optional filter: "show only my tasks" using the selected actor.

### 6.3 View — "This Week" (per-person weekly focus + manual pin)

> **Superseded by §11 (v2.0).** What follows stays accurate for what was built in Phase 7 and is still referenced by D-061, D-062, D-063 and D-064. §11 widens it: same window, same buckets, same pin — plus ad-hoc tasks, the week selector, and the confirmation step. Where the two differ, §11 wins.

The mid-week accountability screen and the backbone of the restructured L10. For each person, three buckets scoped to the operations week (Friday after the L10 → Thursday; the start day is configurable in Settings, and is deliberately distinct from CoachPulse's Thursday→Wednesday coaching week — two dashboards, two calendars):

- **Done this week** — tasks marked done with a completion timestamp inside the current week, each showing its deliverable link.
- **Working on** — tasks currently in_progress.
- **Not started** — tasks the engine projects for this week that are still open.

By default the buckets are filled by the engine's live projection (§4.7): finish something early and next week's tasks flow in on their own; slip and they flow out — so "what we're working on this week" is always the real, current picture, never a stale list from last Friday. Bernardo opens this on Wednesday, sees who is behind on their own tasks, and sends a surgical message ("you're red on X — what happened, need help?") instead of a blanket "what are you working on?" to everyone.

**Manual pin** (overrides the projection). A person can pin what they actually commit to this week, via a drop-down (drag-and-drop is a later polish — same function, lower build risk):

- **Pull a future task into this week** ("＋ add to this week"). The drop-down lists only tasks the engine has validated as available — every candidate's dependencies (across people and across Rocks) are already done. A blocked task either doesn't appear or shows greyed with what it waits on. Every move is checked by the engine first (reusing §4.2 dependency resolution), so a manual move can never start something that is actually blocked. If a person tries, the engine refuses and names the missing dependency and its owner.
- **Postpone a task out of this week.** Allowed, but if anything depends on it the dashboard first shows the downstream cascade ("this also moves X, Y") and asks to confirm.
- Pinned tasks carry a pin marker (so it's clear which are human-set vs. engine-projected) and can be released back to automatic projection. Pins are `pin`/`unpin` events (§3); unpinned tasks keep reprojecting live.

**Net rule:** every move is validated against dependencies first. Pulling forward is usually allowed, postponing usually cascades, and either can be refused when dependencies don't hold — the engine validates, the person decides.

### View 2 — Network / Timeline (Gantt)

Evolution of `Rock3_Network_Graph.html`: same visual language (per-person lanes, parallel threads, dashed bars for wait time, owner colors, week ruler), but fed by the engine's computed dates instead of the hardcoded array in the prototype. Shows parallelism, what waits on what, and cross-Rock dependencies as connectors. This is the "next week" build; specced now so the engine output feeds it directly.

### Sprint rollup

A top-level strip: overall duration-weighted progress, and which Rocks are amber/red on the on-track test.

---

## 7 · Edge cases & validation (dashboard must handle, not crash on)

- Validation on load: unresolved dependency id, duplicate id, unknown owner/type, negative duration, or a dependency cycle → show a clear error naming the offending id; do not silently proceed.
- Deferred tasks (`deferred:true`): excluded from scheduling, from the progress denominator, and from projection. Shown in the UI in a muted "deferred" state so they aren't lost.
- Cuttable Rock/Project (`cuttable:true`): informational badge only. Cutting = regenerate the JSON without it.
- `Both` task with owners on different availability: starts only when the later owner is free (§4.3).
- Task with only `waitDays` and `workDays:0` (pure wait): allowed; occupies no one, gates dependents by calendar time.
- Stale raw JSON / stale sheet read: cache-bust the JSON fetch; write-then-verify covers the write side.
- Actor removed from People: stale localStorage actor stops resolving → selector returns to unset rather than erroring.
- Pin a still-blocked task: refused; the dashboard names the missing dependency and its owner rather than allowing an impossible move.
- Postpone a task others depend on: allowed only after showing the downstream cascade and confirming.
- Deliverable link: any pasted value is validated as a URL server-side; a malformed string is rejected, not silently stored.

---

## 8 · Out of scope for v1 / downstream changes (do NOT build now)

These are consequences of v1, made after the dashboard is built and proven, and made against this approved spec rather than guessed at:

- **Vista 4 — auto-update from Rock Projects.** Not viable today (Rock Projects store no machine-readable per-task status). If ever pursued, the clean bridge is Claude Code writing a `status.json` with the same task ids the dashboard uses. Deferred, possibly absorbed by the future company second-brain.
- **Project Builder emits the JSON.** Later, the Builder learns to output a `sprint-plan.json` conforming to §2 in addition to its `.md` files. Convenience, not a v1 requirement — the seed JSON is produced by hand for now.
- **Sprint planning produces Rock-3-level detail every time.** The root of the whole chain: this Operating System project must, going forward, produce sprint documents with the same detail Rock 3 has (owner per task, type, working-day durations, waitDays, dependencies, cross-deps). This spec defines exactly what fields that detail must include. Rock 3 is the template.
- **Retire Asana.** The Rock Project task-closing loop currently marks Asana complete; that step is removed and pointed at the dashboard once Asana is actually retired. Requires a Builder change; done during transition, not now.

---

## 9 · Build sequence for Claude Code (after approval)

- Repo + GitHub Pages scaffold; load sprint-plan.json (raw URL, cache-busted); validate (§7).
- Date engine (§4) — plan mode first. Prove computed dates against the Rock 3 seed match the expected parallelism/floor.
- Sheet + People/Status Log/Settings tabs; Apps Script `doPost` with all §3 guarantees.
- Sprint Board (View 1+3): person-selector, tasks-by-milestone, marking → event → verify.
- Metrics (§5): duration-weighted progress + burn-up on-track; live reprojection (§4.7) on each mark.
- Network/Timeline (View 2) fed by engine dates.
- "This Week" view (§6.3) + manual pin (drop-down, engine-validated) + deliverable link box. Built last on purpose: if the week tightens, this is the natural cut line without breaking anything earlier.
- **Fase 8 — La vista de to-dos (§11) + cierre semanal (§12).** Reemplaza el §6.3. Requiere que la pestaña People tenga a las cinco personas de leadership antes de construir.
- **Fase 9 — Issues (§13).** Se especifica después de correr al menos un L10 con la Fase 8 en uso.

Build order rationale: the engine is the heaviest and highest-risk piece and everything depends on it, so it goes first and gets validated against real Rock 3 data before any UI investment.

---

## 10 · Appendix — conventions

- Repo: `F4LA/OperationsDashboard`, single `index.html` + modular JS attached to `window`, served via GitHub Pages, mirroring the existing dashboards.
- Raw URL pattern: `https://raw.githubusercontent.com/F4LA/OperationsDashboard/main/sprint-plan.json?nocache=<ts>`
- Language: all UI, code, and data in English (per house convention).
- All dates ISO (YYYY-MM-DD) in the JSON; timestamps in the Status Log are server-generated in the sheet timezone.

---

## Decisions locked by this spec (recap)

Model Sprint→Rock→Project→Milestone→Task; atomic task with owner/type/workDays/waitDays/deps (broad, cross-Rock); Both occupies both queues; fractions allowed · Dates computed, never typed; ready tasks auto-ordered by priority for projection only, executionOrder optional override, reality reprojects · Duration-weighted progress + on-track = actual vs. frozen planned curve · Board = tasks-by-milestone, no imposed order · Identity = person-selector (no auth) on GitHub Pages + Sheet + Apps Script, testimonial pattern + single People source + stable row id + write-then-verify · This Week view (Fri→Thu, three buckets per person, driven by live projection) · manual pin via engine-validated drop-down (pull forward / postpone; allowed / refused-with-reason / cascade) · deliverable link box per task · Structure in `sprint-plan.json` (repo), state in a single append-only Events log in the Sheet · v1 does not edit structure in-app, does not touch Builder/Rock 3/Asana.

---

## 11 · The to-do view (v2) — supersedes §6.3

§6.3 specified "This Week" for Rock tasks only. That was too narrow: a person's real week contains Rock work AND to-dos that belong to no Rock, and a view that shows only the first shows a fraction of what someone committed to — which makes it useless as the accountability surface it exists to be. This section replaces §6.3. What §6.3 specified (the three buckets, the ops-week window, the pin) stays true and stays built; §11 widens it.

### 11.1 · Why the week selector exists

The ops week runs Friday → Thursday and the L10 is on Friday. So at the moment of the meeting one week is closing and another is opening. The L10's step 6 reviews the closing week; step 8 builds the opening one. Those are not two views — they are one movement: saying "I didn't finish this, it moves" in step 6 IS what fills step 8.

The view therefore has a **week selector** with three positions: **closing**, **current**, **opening**. Default: on the ops week's start day it opens on *closing*; on any other day it opens on *current*.

### 11.2 · Controls

Three selectors, nothing else:

- **Week** — closing / current / opening.
- **Person** — "Everyone" first, then each person from the People tab. This REPLACES the "Only my tasks" checkbox, which is removed.
- **Origin** — all / Rock only / other only. Default: all.

**Person filter and "Acting as" are separate controls and must stay separate.** "Acting as" answers *who you are* (whose identity gets written on an event); the person filter answers *who you are looking at*. In the L10, one person shares their screen and moves through everyone, so they will mark tasks while filtered to someone else. Those events are recorded under the identity of whoever actually clicked — never under the filtered person. Fusing the two controls would corrupt the one record that says who marked what.

### 11.3 · Layout

People stack vertically — one block per person, read top to bottom, which is how step 6 is walked. Not side-by-side columns: with five leadership members those get too narrow, and the list is scanned rather than compared.

Within a person, **one single list**, Rock tasks and ad-hoc tasks together. Not two sections. The point of the view is that the person committed to ONE week of work; splitting the list into two makes it read as two separate commitments. Each row carries an origin marker (Rock and task id for plan tasks, nothing for ad-hoc), so telling them apart stays trivial while the commitment stays whole.

Every row has the status dropdown from §6.2, unchanged. Ad-hoc tasks reuse it exactly — same statuses, same event, same write-then-verify.

### 11.4 · The closing week (L10 step 6)

People mark their own tasks during the week, so the list arrives already marked. Step 6 is a READ, not a marking session — the view must not be designed as one.

At the top: the completion summary (§12).

Unfinished tasks show actions, and the actions differ by origin — this asymmetry is deliberate:

- **Ad-hoc**: move to next week, or discard with a mandatory reason. A discard affects nothing else — the task was born this week, is in no plan, and blocks nobody.
- **Rock task**: move to next week, or cancel with a mandatory reason (D-068). Cancelling is a different action with a different name because it is a different act: it changes the sprint plan and may unblock somebody else's work. Before confirming, the view shows the dependency cascade (the same cascadeOf used by postpone, D-063d) — informative, never blocking. A cancelled task leaves the schedule through the same code path as a deferred task (§4.6), so its dependents become unblocked; its work-days leave the progress denominator and are shown separately as cancelled (§5.1). Cancelling a whole milestone or project in-app is deliberately NOT built: that is a plan change, and plan structure is regenerated in `sprint-plan.json`, never edited in-app (§0).

Moving is a `pin` to the next week's Monday key. Discarding is a `discard` event and cancelling a `cancel` event, both with the reason in the note.

**Drag marker.** A task moved twice or more shows a visible marker with the count. This is the case the current process loses: a task postponed five weeks running looks like a first postponement every single time, because nobody is holding the history. The event log already holds it; the view just has to say it.

A Rock task that keeps being moved while the engine still projects it for this week is a signal that the Rock's plan no longer matches reality. The dashboard surfaces it and stops there — that is material for an issue, not for a button.

### 11.5 · The opening week (L10 step 8)

This is where the week gets built. The system proposes, the people confirm.

**Proposed automatically:** Rock tasks the live projection (§4.7) places in that window. This already works.

**Confirm or remove:** each proposed Rock task can be kept or taken out of the week. Taking it out is a `pin` to a later week — the projection does not change (D-063c), only the commitment does.

**Pull others in:** the existing "add to this week" dropdown, with one change from §6.3. Today it hides blocked tasks. It must now SHOW them, flagged, naming what blocks them and who owns the blocker. That flag is the whole point: it produces the conversation "this depends on something of Emery's — Emery, can you get it done this week?" and, when the answer is yes, both commitments land in the same week where they can be seen. Hiding blocked tasks hides the coordination.

**Add ad-hoc tasks:** description, owner (exactly one person — "Both" is not valid), estimated workDays, optional deadline.

**Capacity warning:** sum the workDays of everything in that person's week, Rock and ad-hoc alike, and warn when it exceeds the working days available. The warning is an input to the conversation, not a verdict — the person decides whether to drop something or absorb it.

**Confirming the week freezes the denominator.** When step 8 closes, the list as it stands is that week's commitment, and that is what §12 measures against. Anything added mid-week counts toward the numerator when completed but never inflates the denominator, so taking on extra work can never lower someone's completion rate.

### 11.6 · Not built, deliberately

- **No backlog.** Nothing in the L10 flow looks at one, so it would be where tasks go to be forgotten. Every to-do is born with a week. "No week assigned" remains a representable state in the model, so a backlog can be added later without reworking anything.
- **No kanban and no stage field.** A kanban orders by stage; this operation has no stages, it has status. What orders the work is time — which week it sits in — and a kanban does not show time. Status plus week already expresses everything a board would.

---

## 12 · Weekly completion (L10 step 6, measured)

Read from the event log for the closing week, per person and for the team:

- **Completed** — reached `done` within the window.
- **Moved** — pinned forward to a later week.
- **Discarded** — closed with a reason.
- **Cancelled** — a Rock task closed with a reason (D-068). Counted and displayed separately from discards: a discard is noise in the meeting, a cancellation is a plan that no longer matches reality.
- **Completion rate** — completed ÷ the frozen denominator from §11.5.

**Rock tasks count.** In this company Rock tasks ARE the week's to-dos, not a separate class of work; a rate that excluded them would measure half the week.

Both numbers are shown: the team's rate at the top, each person's beside their name. No ranking, no ordering by performance.

The discard rate is worth watching on its own over a sprint. A high one means the L10 is generating noise rather than work, and that is a fact about the meeting, not about the people in it.
