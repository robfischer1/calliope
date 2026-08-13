---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: Stamp Block Writes with the Session Log Offset

**Input:** plan.md · spec.md · contracts/kafka-offset.md.
**Binding contract:** every task is binding spec; deviation is surfaced, not decided locally. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T002 → T003 (sequential this run; T002's files are distinct from T003's, so lanes 2/3 are parallelizable after T001).

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | types.ts · __tests__/write-provenance.test.ts |
| 2 | T002 | T001 | pg-client.ts · fixture-client.ts · __tests__/pg-client.test.ts · __tests__/fixture-provenance.test.ts |
| 3 | T003 | T001 | mcp/server.ts · mcp/tools.ts · __tests__/mcp-authored-by.test.ts |
| 4 | T004 | T002, T003 | — (gate run) |

## Work-chunks

### T001 — The guard and the widened write signatures  ·  S  ·  lane-1
- **Serves:** the offset⇒principal invariant (spec FR-003) and every downstream chunk.
- **Acceptance:** `validateWriteProvenance(undefined, undefined)` and `(PRINCIPAL, 42)` pass; `("human", 42)`, `("calliope", 0)`, `(undefined, 42)` throw naming the rule; `(PRINCIPAL, undefined)` passes. `BodyClient` write methods accept the trailing `kafkaOffset?: number`. **Tests first, red before green.**
- **Exposes:** `fn:validateWriteProvenance` per contracts/kafka-offset.md — decided.
- **Touches (RR):** write `file:apps/calliope/src/types.ts` (guard + method params); write `file:apps/calliope/__tests__/write-provenance.test.ts` (new).
- **Decisions-slice:** offset requires session principal [Claude, Default — binding]; positional param shape [Claude, Default — binding].
- **Conflicts-with:** none.
- **Size basis:** one predicate + five signature touches → S.

### T002 — The column and store stamping  ·  M  ·  lane-2
- **Serves:** spec US1/US2 at the store; SC-001…SC-003.
- **Acceptance:** pg contract tests — `applySectionOps(node, ops, PRINCIPAL, 42)` stores `'42'` on every row of the event (add, update, tombstone); absent offset stores NULL; `saveBody`/`editSection`/`splitSection`/`mergeSections` same; `materialize` never stamps; `ensureSchema()` idempotent over a populated table (run twice); store-level guard throws on offset-without-principal. Fixture records `kafkaOffset` per event. **Tests first.**
- **Exposes:** `db_field:sections.kafka_offset` (bigint NULL) — decided.
- **Touches (RR):** write `file:apps/calliope/src/pg-client.ts` (SCHEMA_SQL ALTER + 7 INSERT sites + params + guard call); write `file:apps/calliope/src/fixture-client.ts` (event parity); write `file:apps/calliope/__tests__/pg-client.test.ts` · `file:apps/calliope/__tests__/fixture-provenance.test.ts` (new cases).
- **Decisions-slice:** one nullable bigint, no default [Claude, Default — binding]; `materialize` exempt [Claude, Default — binding].
- **Conflicts-with:** none in-lane.
- **Size basis:** DDL line + 7 sites + parity + tests → M.

### T003 — The boundary: accept and enforce  ·  M  ·  lane-3
- **Serves:** spec FR-001/FR-003/FR-004 at the MCP surface.
- **Acceptance:** each of the nine 024 verbs accepts `kafka_offset` with a principal author and the fixture event records it; `kafka_offset` with legacy/absent author rejects naming the rule, zero writes; negative/float offsets reject via schema; absent behaves byte-identically to 024. **Tests first** (extends `mcp-authored-by.test.ts`).
- **Exposes:** `mcp_tool:*` optional `kafka_offset` per contracts/kafka-offset.md — decided.
- **Touches (RR):** write `file:apps/calliope/src/mcp/server.ts` (shared `kafkaOffsetField` + nine schemas + contract check); write `file:apps/calliope/src/mcp/tools.ts` (helper threading); write `file:apps/calliope/__tests__/mcp-authored-by.test.ts` (new describe).
- **Decisions-slice:** boundary + store double enforcement [Claude, Default — binding, per research R3].
- **Conflicts-with:** Clover4's 028–031 server/tools edits — pull merged main before landing (process).
- **Size basis:** nine schema touches + threading + contract tests → M.

### T004 — Gate run + quickstart validation  ·  S  ·  sequential
- **Serves:** Constitution V; SC-001…SC-004.
- **Acceptance:** full repo gate green; quickstart items 1–4 each traced to a passing test; diff shows exactly ONE DDL line added (the idempotent ALTER).
- **Touches (RR):** — .
- **Size basis:** verification only → S.

---
Done-when (the gate):
[x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[x] lanes 2/3 share no file
[x] critical path T001→T002→T004; no cycles
[x] every Exposes shape traces to plan.md Contracts & Seams
[x] State/Budget: n/a (no modes; no perf budget load-bearing)
