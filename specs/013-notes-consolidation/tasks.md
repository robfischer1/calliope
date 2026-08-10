# Tasks: Consolidate the documents and notes stores

**Input**: `/specs/013-notes-consolidation/` · **Tests**: test-first.

## Phase 2: The sink (US1 core)

T001 `listSourcePaths()` on the DocumentStore seam (pg + fixture) in
      `src/document-store.ts`, with a fixture test.
T002 Test-first `__tests__/notes-sink.test.ts`: mint keyed by
      source_path (reuse on second call); one-block body; version →
      superseding generation; container-grain no-op on identical body;
      provenance attrs written and RECONCILED on change (old value
      retracted); inline tags become edges; absent columns → absent attrs.
      Run: red.
T003 Implement `src/notes-sink.ts`. Run: green.

## Phase 3: The migration (US3)

T004 Test-first `__tests__/migrate-notes.test.ts`: fixture corpus
      (multi-version paths) → migrate → SC-001 parity (newest byte-exact,
      as-of per version, attrs match); SC-002 re-run zero deltas; parity
      mismatch exits nonzero (simulated by corrupting a container between
      runs). Run: red.
T005 Implement `src/mcp/migrate-notes.ts` (probe/migrate, the
      migrate.ts CLI pattern). Run: green.

## Phase 4: The bridge (US2)

T006 Test-first in `__tests__/mcp-documents.test.ts`: write_document
      with the chaos facet wired → note exists with body/attrs/tags;
      identical re-submit no-ops both stores; without the facet → table-only
      (today's behavior). Run: red.
T007 Wire the bridge in `src/mcp/server.ts`. Run: green.

## Phase 5: Gate + land + live run

T008 `bun run gate` + audit high — green. Land (PR, CI, merge).
- [ ] T009 Live run: ssh tunnel to chaos, `migrate-notes --probe`, then
      migrate; paste parity output; re-run to prove zero-delta convergence;
      spot-check one note's edges + body via the gateway.

## Dependencies

T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009.
