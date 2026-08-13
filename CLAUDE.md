# CLAUDE.md — Operations Dashboard repo

This is the single repo for the Strong Standard Operations Dashboard: the app code **and** its memory live here. It is built from the approved spec at `docs/spec.md` (the source of truth for WHAT to build) and its decisions are recorded in `docs/decision-log.md` (the source of truth for WHY). The current build state is `docs/project-brain.md`.

Two kinds of Claude Code session run against this repo, both following the rules below:
- **BUILD session** — writes and edits the app code (`index.html`, `app.js`, `styles.css`, `dashboard/*.js`) and the seed/data.
- **PUSH session** — writes only the memory docs in `/docs` (`decision-log.md`, `project-brain.md`), pasted from a Claude Project chat.

## ⚠️ Non-negotiable workflow (every session, every change)
1. **Always `git pull` on `main` BEFORE touching any file. No exceptions.** The other session may have pushed since this one last ran. This is the single most important rule in this file.
2. Apply the change with **targeted edits only**. Never rewrite or regenerate a whole file — edit exactly what was handed to you and nothing else. If the pasted content conflicts with what's already in a file (e.g. a decision ID already taken, or a code section that moved), STOP and tell the person before editing.
3. **Always commit and push immediately after editing.** An unpushed change does not exist for the rest of the work. Never leave the tree dirty at the end of a task.
4. After pushing, report the commit hash and a one-line summary of what changed.
5. Never declare something absent from a single revision — check history/other files before concluding a thing isn't there.

## Which session touches what
- The **BUILD session** never edits `docs/decision-log.md` or `docs/project-brain.md`. If a code change implies a decision or a state change, it reports that back in plain text so the Claude Project chat can produce the closing package for the PUSH session. (Rationale: one writer per memory file avoids the two-sources-of-truth drift the team has hit before.)
- The **PUSH session** never edits code. It only applies pasted memory changes to `/docs`.
- Both always pull first (rule 1), so the shared folder never desyncs between the two sessions.

## Rules per document (PUSH session)

### docs/decision-log.md
- New rows go at the TOP of the table, directly under the header.
- Never edit or delete an old row, except changing Status when a decision is superseded ("Replaced by D-XXX") or resolved.
- IDs are sequential. Read the top row to confirm the last used ID — never invent one. If the pasted ID isn't the next sequential ID, flag it before committing.
- Columns: ID | Date | Decision | Context (2–3 lines max) | Who | Status.

### docs/project-brain.md
- Update only the sections that changed (Current phase / Status / Done / In progress / Next up / Blocked / Deferred / Open decisions / Key dates).
- Always update the "Last updated" line (date + who) in the same edit.
- Sweep for dangling cross-references (a "blocked" or "in progress" note that no longer applies), not just the lines mentioned.

## Rules for the code (BUILD session)
- Follow the spec (`docs/spec.md`). Build one phase at a time per §9; stop for testing before the next.
- Match the house conventions already scaffolded: vanilla HTML/CSS/JS, no build step, modules in `/dashboard` attaching to `OpsDash*` window globals, `app.js` as the root bootstrap, served via GitHub Pages.
- If the spec is ambiguous or silent on something, do NOT invent behavior — surface it to the person as a decision to resolve in the Claude Project chat and log via the PUSH session.

## Scope & data
- The plan structure lives in the seed JSON (currently `data/rock3-seed.json`; the production location vs. spec §10's root `sprint-plan.json` is Decision D-005, open — resolve before writing fetch code).
- Task state (status, deliverable link, pin) lives in a Google Sheet via an Apps Script Web App — not in this repo. That backend is a later phase; none of it exists yet.

## Commit messages
Short and specific, referencing decision IDs when applicable. Examples: `Engine: plan-mode scheduling (D-008)` · `Brain: date engine validated against Rock 3` · `Docs: add D-016 (backend Sheet schema)`.
