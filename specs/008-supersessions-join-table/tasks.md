# Tasks: The supersessions join table

**Input**: Design documents from `/specs/008-supersessions-join-table/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Included — the constitution's Prove gate is test-first, and every
Success Criterion in the spec is a falsifiable conformance target.

**Organization**: Phase 2 is the schema foundation both stories need; US1 and
US2 then land in story order. All work is in `apps/calliope/`.

## Phase 1: Setup

*(none — existing workspace, no new deps, no new files beyond the touched two)*

---

## Phase 2: Foundational (blocking both stories)

- [X] T001 Add the `supersessions` DDL (table + `supersessions_predecessor`
      index) and the idempotent backfill statement to `SCHEMA_SQL` in
      `apps/calliope/src/pg-client.ts`, exactly as written in data-model.md.

---

## Phase 3: US1 — a merge can record all of its predecessors (P1)

**Goal**: a successor records N predecessors; both directions resolve.
**Independent test**: `recordSupersession` 2-predecessor round-trip via `lineageOf`.

- [X] T002 [US1] Test-first: in `apps/calliope/__tests__/pg-client.test.ts`,
      add contract tests — (a) `recordSupersession(node, C, [A, B])` then
      `lineageOf(node, C)` lists A and B as predecessors; (b) `lineageOf(node, A)`
      and `lineageOf(node, B)` each name C as successor; (c) re-applying the
      same recording is a no-op (idempotent); (d) a single-predecessor edit via
      `editSection` yields an edge equal to its `supersedes` value (SC-002
      dual-write half). Run: red (methods absent).
- [X] T003 [US1] Implement `recordSupersession(nodeId, successorId,
      predecessorIds)` and `lineageOf(nodeId, blockId)` on `PgBodyClient` in
      `apps/calliope/src/pg-client.ts` (one transaction; `ON CONFLICT DO
      NOTHING`; both-direction point queries). Run T002: green.
- [X] T004 [US1] Dual-write the edge in every superseding write arm —
      `editSection`, `applySectionOps` update / reorder / delete (tombstone)
      arms; add arms write no edge — same transaction as the section insert,
      in `apps/calliope/src/pg-client.ts`. Extend T002(d) to cover an ops
      batch (update + reorder + delete each produce exactly one edge; add
      produces none). Run: green.

---

## Phase 4: US2 — existing lineage survives the backfill unchanged (P1)

**Goal**: backfill carries every historical edge; reconstruction byte-identical.
**Independent test**: SC-003 snapshot matrix, plus the non-vacuity red run.

- [X] T005 [US2] Test-first: build a mixed-lineage body (save → edit → ops
      batch incl. delete + add), snapshot `readRevisions` and every
      `readRevisionAt`; then simulate a pre-F1 store by `DELETE FROM
      supersessions` for that node; re-run `ensureSchema` (backfill); compare
      all snapshots byte-identically. Also assert tombstone edges and NO
      add-marker edges exist post-backfill.
- [X] T006 [US2] Cut `readRevisionAt`'s supersession `NOT EXISTS` over from
      `sections.supersedes` to the `supersessions` table in
      `apps/calliope/src/pg-client.ts`. Run T005 + the whole existing suite:
      green.
- [X] T007 [US2] Non-vacuity proof: temporarily remove the backfill statement,
      run T005, observe red (deleted section resurrected / stale edit
      visible), restore, observe green. Paste the verbatim red output into the
      feature report (plan Open & risk requires it).

---

## Phase 5: Polish & gate

- [X] T008 Run `bun run gate` at the repo root (format:check + lint +
      typecheck + test + build) — all green, output captured.

## Dependencies

- T001 → everything.
- US1: T002 → T003 → T004.
- US2: T005 → T006 → T007 (T005 depends on T004's dual-writes existing).
- T008 last.

## Implementation strategy

Strict sequence — the feature is S-sized and single-file; parallelism buys
nothing. MVP = US1 (the capability F3 needs); US2 is the safety half that
makes it landable.
