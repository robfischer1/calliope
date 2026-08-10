# Tasks: update_block as the plan-edit path

**Input**: `/specs/011-update-block-noop/` · **Tests**: test-first.

## Phase 2: US1+US2

- [X] T001 Test-first in `__tests__/pg-client.test.ts`: (a) SC-001 — update
      one block of a 3-block body; total row delta = 1, siblings' ids/keys
      stable; (b) SC-002 — re-submit identical text: row/edge/revision
      deltas = 0, returned id equals current; (c) SC-003 — `authored_by`
      readable on the superseding row. Run: red on (b).
- [X] T002 Implement the in-tx identical-text no-op in
      `apps/calliope/src/pg-client.ts` `editSection`; mirror in
      `apps/calliope/src/fixture-client.ts`; extend the `editSection`
      contract doc in `apps/calliope/src/types.ts`. Run T001: green.
- [X] T003 Handler fence in `__tests__/mcp-tools.test.ts`: `updateBlock`
      with identical text returns the same block id over the fixture.

## Phase 3: Gate

- [X] T004 `bun run gate` + `bun audit --audit-level=high` — green.

## Dependencies

T001 → T002 → T003 → T004.
