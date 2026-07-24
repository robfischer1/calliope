---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: C8 — The Note-Native Mint (`create_note`)

**Critical path:** T001 → T002 → T003 → T004 (strictly sequential).

### T001 — `ChaosClient` (the graph-write muscle) · M

- **Acceptance:** Given a fake transport, When `admit(ops, scope)` / `findByName(kind, label)` run, Then the wire calls match the pinned grammar (`tools/call` JSON-RPC; ops exactly `court.py`'s dict shapes; scope threaded; `minted[]` surfaced; violations → structured error verbatim); `ensureNotesRoot()` finds-or-mints the `NoteRoot`/"Notes" singleton (`hasName` + `anchorsRole → "Notes"`), re-finds after mint, resolves a race to the lowest token; unit tests cover reuse-hit, mint, refusal, race.
- **Touches:** write `apps/calliope/src/chaos-client.ts`, `apps/calliope/__tests__/chaos-client.test.ts`.

### T002 — `create_note` handler + verb registration · M

- **Acceptance:** Given the injected ChaosClient, When `create_note(title, parent?, tags?)` runs, Then: reuse-hit answers `{node_id, created:false}` with zero admits; a miss runs admit#1 (`createNode Note/title`) then admit#2 (`hasName`/`hasType:"Note"`/`parent`) on scope `notes`, parent = caller's or the ensured root; `tags` validates as `string[]` and is otherwise inert; structured errors (`bad_title`, `admit_refused` with violations, `parent_not_found`); the verb registers in `server.ts` behind env (`CALLIOPE_THEMIS_URL` / `CALLIOPE_CHAOS_URL` / `CALLIOPE_NOTES_SCOPE`, defaults per plan); handler tests over the fake; the full existing suite stays green.
- **Touches:** write `apps/calliope/src/mcp/tools.ts`, `apps/calliope/src/mcp/server.ts`, `apps/calliope/__tests__/mcp-tools.test.ts`.

### T003 — Shape canonize + gate · S

- **Acceptance:** `urania_canonize_shape("c8a6c340…")` runs and `urania_shape_for("Note")` answers `status: canonical`; the calliope gate (lint, types, tests, build) is green in the worktree.
- **Touches:** gateway act (recorded in the completion report); no repo files.

### T004 — Land + deploy + live E2E probe · M

- **Acceptance:** branch lands via the door (merge-commit discipline + Serves trailer); the auto pin/deploy completes; then the live probe through the Hades gateway: `create_note("c8-probe-…")` mints (graph read on `notes` shows node + `hasName`/`hasType`; `read_body` answers the empty body); identical re-run answers same `node_id`, `created:false`; parentless create parents to the root; root singleton verified after repeated creates; `admit` flagged-vs-refused attribution behavior recorded (the plan's [OPEN if refused]).
- **Touches:** door land; deploy watch; live probes (debris labeled `c8-probe-*`, kept deliberately).
