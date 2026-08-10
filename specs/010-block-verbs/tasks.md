# Tasks: CRUD_block, split and merge

**Input**: Design documents from `/specs/010-block-verbs/`
**Tests**: Included — test-first per the Prove gate.

## Phase 1: Setup

*(none — existing workspace)*

## Phase 2: Foundational — the store seam (blocks both stories)

- [X] T001 Add optional `splitSection?` / `mergeSections?` to `BodyClient` in
      `apps/calliope/src/types.ts` with full contract docs (offset domain,
      adjacency, lineage semantics).

## Phase 3: US2 — split and merge preserve identity (P1, store layer first)

- [X] T002 [US2] Test-first in `__tests__/pg-client.test.ts`: split at an
      interior offset → two children, keys between neighbours, both lineage
      edges resolve both directions; split at 0/len boundary; merge two
      adjacent → survivor carries both predecessors (join table) and column
      names first; merge non-adjacent → rejects `not_adjacent`, nothing
      applied; stale ids reject `stale_section`; SC-005 reconstruction
      matrix across save → split → merge. Run: red.
- [X] T003 [US2] Implement `splitSection` + `mergeSections` in
      `apps/calliope/src/pg-client.ts` per the plan's tx design. Run T002:
      green.
- [X] T004 [US2] Implement fixture twins in
      `apps/calliope/src/fixture-client.ts` (same visible semantics,
      snapshot events: split="ops", merge="edit").

## Phase 4: US1 + US3 — the verb surface (P1/P2)

- [X] T005 [US1] Test-first in `__tests__/mcp-tools.test.ts`: handler
      round-trips over the fixture — create (after + append + empty
      container), read (hit + structured `block_not_found`), update, delete,
      split, merge; stale rejections surface as thrown `stale_section`.
      Run: red.
- [X] T006 [US1] Implement the six handlers in `apps/calliope/src/mcp/tools.ts`
      (server-minted keys via `between`; capability guards mirroring
      `edit_section`'s). Run T005: green.
- [X] T007 [US1+US3] Register the six verbs in `apps/calliope/src/mcp/server.ts`
      (after-write tag reconcile on every mutating verb, like the existing
      writes); demote `write_body` (title/description → LEGACY, pointing at
      the block verbs); update the header tool list.
- [X] T008 [US1] Extend `__tests__/mcp-http.test.ts` or the tools test to
      assert the tool listing carries all six (SC-001).

## Phase 5: Polish & gate

- [X] T009 Full `bun run gate` + `bun audit --audit-level=high` — green,
      output captured.

## Dependencies

T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009.
