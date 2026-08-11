# Feature Specification: Finish the phdb strangler — retire the documents table

**Status**: Draft | **Input**: Master-plan F7 Head + Rob's identity decision
(executed in the prelude, calliope PRs #107/#108; live store converged:
2,482 identities, zero-delta re-run, unwound loop fixed).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One store serves every document read (Priority: P1)

The strangler's point is that the strangled thing goes away. Every read that
served from the `documents` table serves from the merged note store instead:
`read_documents` by id (via the migrated `document_id` handles), by
source_path (vault rows by name; archive rows by attribute), and filtered
lists; `read_plan` / `list_blocks` / `read_block` document-families resolve
plans through the same store seam unchanged.

**Acceptance Scenarios**:

1. **Given** a migrated document id, **When** `read_documents {id}` runs,
   **Then** the note-backed row reconstructs (body byte-exact, provenance
   from attributes).
2. **Given** a plan dissolved through `write_document`, **When** `read_plan
   {source_path}` runs, **Then** the block index and body serve exactly as
   before — through the note store.
3. **Given** a fresh dissolve, **Then** it lands note-native ONLY (no table
   row); its handle is `source_path` (document ids are migration-legacy,
   documented).

### User Story 2 - write_document is a thin note-native alias (Priority: P1)

The wire shape survives (vault-mcp's dissolve path is a tolerant
passthrough — swept); the implementation is the F6/F9 sink alone. `table:
"notes"`, `id: null`, `deduped` = the sink's no-op signal.

### User Story 3 - The table drops, gated (Priority: P1)

A drop CLI (probe / --execute) verifies the note store's convergence
against the table before dropping, and the LIVE drop is additionally gated
on the deployed image serving the notes-backed reads (the old image still
reads the table). `file_revisions` / `revision_deltas` are re-scoped in
their registrations as FROZEN ARCHIVE.

## Requirements

- **FR-001**: `NotesDocumentStore implements DocumentStore` over
  (BodyClient, ChaosDial, scope): byId via `document_id` lookup,
  bySourcePath via name-then-attribute, list via `schema_type` /
  `hasType` value lookups with `dissolved_at` ordering, write via the sink
  (returning the sink result alongside the wire shape).
- **FR-002**: both backends (pg, fixture) wire it as `documents` — one
  model, no fixture drift; the table-backed classes remain ONLY for the
  migration tooling until the drop.
- **FR-003**: `drop-documents` CLI: probe reports convergence (identities
  vs rows); `--execute` drops only when convergence holds.
- **FR-004**: archive-verb registrations re-described as frozen archive.

## Success Criteria

- **SC-001**: full suite green with the fixture backend notes-backed —
  every existing document/plan wire test passes through the new store.
- **SC-002**: live: reads spot-checked notes-backed post-deploy;
  drop CLI probe reports convergence; the drop executes (or is recorded as
  gated on the image roll, with the exact command).

## Assumptions

- Fresh dissolves carry no document id (the table's sequence dies with it);
  `document_id` handles are migration-legacy, served forever from the
  bridge attributes. [Default — surfaced in the verb docs]
- `bySourcePath` returns the note's NEWEST state as one row; historical
  versions ride the container's revisions (the F6 model). read_plan uses
  rows[0] only — unaffected. [Default]
