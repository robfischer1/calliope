---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: Widen AuthoredBy to a Session Principal

**Input:** plan.md · spec.md · contracts/authored-by.md (the seam shapes).
**Binding contract:** every task is binding spec. The executor follows it and does NOT
use judgment outside items marked `[OPEN]`. A needed deviation is surfaced back, not
decided locally. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T002 → T004 (T003 parallelizable with T002 after T001; this run executes sequentially anyway).

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | types.ts · urania-client.ts · __tests__/authored-by.test.ts |
| 2 | T002 | T001 | pg-client.ts · fixture-client.ts · __tests__/pg-client.test.ts · __tests__/fixture-provenance.test.ts |
| 3 | T003 | T001 | mcp/server.ts · mcp/tools.ts · __tests__/mcp-authored-by.test.ts |
| 4 | T004 | T002, T003 | — (gate run only) |

## Work-chunks

### T001 — Widen the type; relocate its home; guard it  ·  S  ·  lane-1
- **Serves:** plan Slice "Type widening + re-export" — the unlock for every other chunk.
- **Acceptance:** Given `isAuthoredBy`, When called with `"human"`, `"calliope"`, or `spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0`, Then it returns true and narrows the type; When called with `"gandalf"`, `"spiffe://td/workload/x"`, an uppercase-hex or non-UUID tail, Then false. Legacy assignments (`const a: AuthoredBy = "human"`) still compile. `BlockOp.authored_by` accepts a principal. **Tests written first, red before green.**
- **Exposes:** `type:SessionPrincipal` · `type:AuthoredBy` (widened) · `const:SESSION_PRINCIPAL_RE` · `fn:isAuthoredBy` — all in `types.ts`, re-exported from `urania-client.ts` · decided (contracts/authored-by.md).
- **Touches (RR, field-level):** write `file:apps/calliope/src/types.ts` (define family; widen `BlockOp.authored_by` L105; add optional trailing `authoredBy?` to `BodyClient` write methods `saveBody`/`editSection`/`applySectionOps`/`splitSection`/`mergeSections`); write `file:apps/calliope/src/urania-client.ts` (delete local `AuthoredBy` L45, re-export from `./types.js`); write `file:apps/calliope/__tests__/authored-by.test.ts` (new).
- **Decisions-slice:** type home = types.ts + re-export [Claude, Default — binding]; principal grammar = UUID-tailed regex [Claude, Default — binding].
- **Conflicts-with:** none (T002/T003 wait on it by dependency, not file overlap).
- **Size basis:** one type family + one re-export + interface param additions → S.

### T002 — Thread per-call author through the store clients  ·  S  ·  lane-2
- **Serves:** plan Slice "Client per-call threading."
- **Acceptance:** Given `PgBodyClient` (real-postgres contract test), When `applySectionOps(node, [{op:"add",…}], principal)` runs, Then `sections.authored_by` = the exact principal; When the param is absent, Then the instance default stamps exactly as today (existing tests untouched and green); `readRevisions` reports each revision's author verbatim (principal and legacy in one history). Same override semantics through `saveBody`/`editSection`/`splitSection`/`mergeSections`. Fixture client mirrors the behavior. **Tests written first.**
- **Exposes:** client contract per contracts/authored-by.md §Client — decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/pg-client.ts` (per-call `authoredBy ?? this.#authoredBy` at the 7 `INSERT INTO sections` sites L146–459; `materialize` unchanged); write `file:apps/calliope/src/fixture-client.ts` (same optional param into fixture revisions); write `db_field:sections.authored_by` (values only — **no DDL**); write `file:apps/calliope/__tests__/pg-client.test.ts` (new cases) · `file:apps/calliope/__tests__/fixture-provenance.test.ts` (new).
- **Decisions-slice:** per-call override, instance default preserved [Claude, Default — binding]; `materialize` default unchanged [Claude, Default — binding].
- **Conflicts-with:** none in its lane (distinct files from T003).
- **Size basis:** one nullish-coalescing seam repeated at the INSERT sites + tests → S.

### T003 — Accept and validate the principal at the MCP boundary  ·  M  ·  lane-3
- **Serves:** plan Slice "MCP boundary (zod + threading)" — spec FR-001/FR-005.
- **Acceptance:** Given each sections-writing verb (`write_body`, `edit_section`, `append_section`, `apply_section_ops`, `create_block`, `update_block`, `delete_block`, `split_block`, `merge_block` — `coalesce_block_writes` excluded, correction surfaced in contracts/authored-by.md: it removes rows, stamps nothing), When called with a valid `authored_by` (either legacy literal or principal), Then the value reaches the client call and lands in the row; When called with an invalid value, Then the verb rejects naming the three accepted forms and writes nothing; When the field is absent, Then behavior is byte-identical to today. **Tests written first** (fixture backend, MCP layer).
- **Exposes:** `mcp_tool:*` optional `authored_by` input per contracts/authored-by.md §MCP — decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/mcp/server.ts` (zod `.refine(isAuthoredBy, …)` optional field on the ten write-verb input schemas; thread to tools/client calls); write `file:apps/calliope/src/mcp/tools.ts` (optional `authoredBy` param on `createBlock`/`updateBlock`/`deleteBlock`/`splitBlock`/`mergeBlock`/`coalesceBlockWrites`, passed to `applySectionOps` etc.); write `file:apps/calliope/__tests__/mcp-authored-by.test.ts` (new).
- **Decisions-slice:** validation at the MCP ingress only [Claude, Default — binding]; all ten sections-writing verbs, not a subset [Claude, Default — binding].
- **Open:** [OPEN — surfaced, do not resolve] authenticity (Kairos PoP vs gateway trust) is out of F1; form-validation only.
- **Conflicts-with:** Clover4's concurrent append-shaped `server.ts`/`tools.ts` edits land via their own PRs — pull merged main before landing (process, not a task edit).
- **Size basis:** ten schema touches + threading + boundary tests → M.

### T004 — Gate run + quickstart validation  ·  S  ·  sequential (after T002+T003)
- **Serves:** Constitution V; spec SC-001…SC-004.
- **Acceptance:** `bun run lint`, `bun run typecheck`, `bun run test` all green in `apps/calliope` (pg contract suite runs if docker present — run it); quickstart.md scenarios 1–5 each traced to a passing test by name; the diff contains **no DDL change** (SC-003 verified by inspection).
- **Touches (RR):** — (gate run only).
- **Conflicts-with:** none.
- **Size basis:** verification only → S.

---
Done-when (the gate):
[x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[x] every [P] verified conflict-free (lanes 2/3 share no file)
[x] critical path identified (T001→T002→T004); no dependency cycles
[x] every Exposes shape traces to plan.md Contracts & Seams
[x] State + Budget: not stateful, no perf-load-bearing budget — n/a
