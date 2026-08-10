# Tasks: Flip the default body backend to PgBodyClient

**Input**: Design documents from `/specs/009-default-backend-pg/`
**Tests**: Included — test-first per the Prove gate.

## Phase 1: Setup

*(none — existing workspace)*

## Phase 2: US1+US2 (single file, strict sequence)

- [X] T001 [US1] Test-first in `apps/calliope/__tests__/backend.test.ts`:
      flip the bare-env default expectation to `pg`; add the US2 fail-fast
      expectations — `makeBodyClient("pg", {})` and `makeBackend("pg", {})`
      throw `/DATABASE_URL/`. Run: red (today's code returns urania and
      silently constructs a Pool).
- [X] T002 [US1] In `apps/calliope/src/mcp/backend.ts`: `backendKind()` final
      fallback → `"pg"`; update the header + `backendKind` doc comments.
- [X] T003 [US2] In the same file: both pg construction sites throw on
      absent/empty `DATABASE_URL` with a message naming the variable and the
      sovereign-store cutover. Update `apps/calliope/src/mcp/main.ts:8` doc
      comment. Run T001: green.

## Phase 3: Polish & gate

- [X] T004 Full suite + `bun run gate` + `bun audit --audit-level=high` — all
      green, output captured.

## Dependencies

T001 → T002 → T003 → T004.
