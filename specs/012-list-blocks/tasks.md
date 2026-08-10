# Tasks: read_plan dissolves into list_blocks and read_block

**Input**: `/specs/012-list-blocks/` · **Tests**: test-first.

## Phase 2: Calliope (US1 + US3)

- [X] T001 [US1] Test-first: `__tests__/mcp-plan-ingest.test.ts` — HTTP
      round-trips for `list_blocks` (document family: index, no body_text)
      and `read_block` (document family: one block's markdown; the three
      miss shapes); `__tests__/mcp-tools.test.ts` — `listContainerBlocks`
      node-family index over the fixture; `__tests__/mcp-http.test.ts` —
      fence grows to 22 with `list_blocks`. Run: red.
- [X] T002 [US1] Implement `listContainerBlocks` in `src/mcp/tools.ts`;
      register `list_blocks` + extend `read_block` + LEGACY-ize `read_plan`
      in `src/mcp/server.ts`. Run: green.
- [X] T003 Gate: `bun run gate` + audit high — green. Land calliope (PR,
      CI, merge).

## Phase 3: Athena (US2 — the consumer swap)

- [ ] T004 [US2] Worktree in `repo:athena`; test-first: the fake Calliope
      dial gains `read_block`; the block-path tests pin the NEW verb name
      (red against the old path).
- [ ] T005 [US2] `src/athena/calliope.py`: `CalliopeDial.read_block` +
      Live/Null impls; `resolve_plan` block path swaps to it. Run: green.
- [ ] T006 Athena gate (its lint/type/test set) — green. Land athena (PR,
      CI, merge).

## Dependencies

T001 → T002 → T003 → T004 → T005 → T006 (strict — calliope lands first).
