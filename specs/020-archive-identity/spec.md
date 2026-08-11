# Feature Specification: Archive identity amendment (F7 prelude)

**Status**: Draft | **Input**: Rob's F7 decision, 2026-08-10 — "Option 1, but
add an isArchived predicate/edge to exclude them from default views."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every archive document gets its own identity (Priority: P1)

The phdb-migration corpus used `source_path` as a source-container field
(`F:\OneDrive` = 1,900 distinct documents), so path-keyed identity stacked
them into mega-notes. After this amendment, each non-vault row resolves to
its OWN note: identity = `source_path :: (file_path | title | raw_hash)`,
carrying an `isArchived` attribute so default views exclude it, and
`document_id` attribute edges so legacy document-id handles keep resolving
after the table drops (F7 proper).

**Acceptance Scenarios**:

1. **Given** two phdb rows sharing a source_path with distinct file_paths,
   **When** migrated, **Then** two notes exist, each `isArchived`, each
   carrying its `document_id`(s) and truthful provenance (the REAL
   source_path attr, the composite only as the graph name).
2. **Given** the two non-phdb rows (vault-shaped paths), **Then** their
   identity model is unchanged (no isArchived, no composite).
3. **Given** a converged store, **Then** a re-run performs zero writes.

### User Story 2 - The mega-notes unwind (Priority: P1)

The container-path notes minted by the F6 run (7, led by `F:\OneDrive`)
lose their body rows and lineage, and their graph edges are retracted —
they stop existing as notes. Reversible at the substrate level (retractions
are logged ops); the documents table is still intact beneath (it drops only
at F7 proper).

**Acceptance Scenarios**:

1. **Given** a stale container-path note, **When** the unwind runs, **Then**
   its sections and lineage rows are gone and its edges retracted; the new
   composite-identity notes carry the corpus instead.

## Requirements

- **FR-001**: identity fn: phdb-migration rows → composite graph name;
  other rows → source_path (unchanged).
- **FR-002**: `isArchived: "true"` attribute on every archive note; the
  attr rides the F6 provenance contract (B6/Grace exclude by it).
- **FR-003**: additive `document_id` attribute edges (one per table row id)
  — the id-handle bridge F7's table drop needs.
- **FR-004**: unwind mode: stale container-path notes' sections +
  supersessions deleted, edges retracted; idempotent.
- **FR-005**: migration remains parity-gated and zero-delta on re-run.

## Success Criteria

- **SC-001**: fixture: composite splitting, isArchived, document_id edges,
  vault rows untouched, re-run zero-delta.
- **SC-002**: live run: ~2,040 archive notes minted; the 7 mega-notes
  unwound; parity clean; re-run zero; spot-check one archive note's edges.

## Assumptions

- Composite name form: `${source_path} :: ${file_path ?? title ?? raw_hash
  prefix}` — unambiguous, collision-free with vault paths (` :: ` never
  appears in them). [Default]
- Within one composite identity, multiple rows (same doc, re-captured)
  remain versions — correct stacking. [Default]
