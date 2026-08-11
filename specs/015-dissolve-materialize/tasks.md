# Tasks: Dissolve and Materialize as container verbs

**Input**: `/specs/015-dissolve-materialize/` · **Tests**: test-first.

- [X] T001 Test-first in `__tests__/notes-sink.test.ts`: dissolveContainer —
      multi-block mint; identical-blocks no-op; changed blocks = one
      superseding generation; tags + provenance as in F6. Run: red.
- [X] T002 Implement `dissolveContainer` in `src/notes-sink.ts` (shared
      internals with sinkNoteVersion). Run: green.
- [X] T003 Register `dissolve_note` + `materialize_note` (chaos-gated) in
      `src/mcp/server.ts`; wire-level round-trip test (dissolve → read_body
      → materialize → no-op retry → superseding re-dissolve;
      container_not_found); fence → 25. Run: green.
- [X] T004 Gate + audit — green. Land. Close C6 node as retired (graph).

## Dependencies

T001 → T002 → T003 → T004.
