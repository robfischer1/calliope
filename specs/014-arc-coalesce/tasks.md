# Tasks: Coalesce block writes per writing arc

**Input**: `/specs/014-arc-coalesce/` · **Tests**: test-first.

- [X] T001 Test-first in `__tests__/pg-client.test.ts`: 4-pause chain →
      coalesce → exactly pre-arc + final remain (row/edge deltas exact);
      lineage final→pre-arc both directions; endpoint reconstructions
      byte-identical pre/post; a split inside the window stops the walk;
      stale block id rejects; bad since_revision (nothing to collapse) is a
      zero-removed no-op. Run: red.
- [X] T002 Implement `coalesceArc` in `apps/calliope/src/pg-client.ts`.
      Run: green.
- [X] T003 Register `coalesce_block_writes` behind `CALLIOPE_COALESCE_ARCS`
      in `apps/calliope/src/mcp/server.ts`; wire-level disabled-refusal test
      + fence → 23 in `__tests__/mcp-http.test.ts`. Run: green.
- [X] T004 `bun run gate` + audit high — green. Land.

## Dependencies

T001 → T002 → T003 → T004.
