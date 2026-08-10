# Feature Specification: Consolidate the documents and notes stores

**Status**: Draft | **Input**: Master-plan F6 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A document becomes a note (Priority: P1)

Today the searchable half (`documents` rows) has no identity, no tags and no
edges; the identity half (graph-backed notes) is indexed nowhere. After this
feature, every dissolved document exists as a NOTE: a graph identity carrying
its provenance as attributes, whose body is a one-block container in the
sovereign store — tags and edges like any other note.

**Why this priority**: this is simultaneously the identity fix and the
cheapest path to searchable notes (B6 inherits the ingest path).

**Independent Test**: migrate a documents corpus; every source_path resolves
to one note whose newest body is byte-identical to the newest stored version,
whose provenance attributes match the row, and whose inline tags exist as
real tag edges.

**Acceptance Scenarios**:

1. **Given** a `documents` row, **When** migrated, **Then** a one-block
   container exists carrying the same body (byte-for-byte) and its
   provenance as attributes on the note.
2. **Given** several versions of one source_path, **When** migrated in
   stored order, **Then** they become copy-on-write generations of ONE note
   (the insert-only → CoW reconciliation), and as-of reconstruction serves
   each version.
3. **Given** a note body containing inline tags, **Then** the note carries
   real tag edges (like any other note).

### User Story 2 - The dissolve sink writes the merged store (Priority: P1)

A new dissolve (`write_document`) lands in BOTH the legacy table and the
note container during the strangler bridge window (the table is retired by
the next feature, F7). Dedup semantics are unchanged: an identical re-submit
is a no-op in both stores.

**Acceptance Scenarios**:

1. **Given** a fresh dissolve, **When** `write_document` runs with the graph
   facet wired, **Then** the note exists/updates (mint or superseding
   generation) AND the table row lands, atomically-per-store and idempotent.
2. **Given** an identical re-submit, **Then** both stores no-op (`deduped`
   true; container body unchanged; no new generation).

### User Story 3 - The migration is gated and idempotent (Priority: P1)

The migration tool follows the repo's proven pattern (the C2 carve): probe
mode (read-only counts), migrate mode with a byte-for-byte parity gate, and
full idempotence (a re-run converges with zero new writes).

**Acceptance Scenarios**:

1. **Given** a migrated corpus, **When** the tool re-runs, **Then** zero new
   generations, zero new mints, zero attribute changes.
2. **Given** any parity mismatch, **Then** the tool exits nonzero naming the
   source_path.

### Edge Cases

- A documents row whose `title` collides with another note's name: identity
  is keyed on `source_path` (unique by constraint), not title.
- Rows with NULL title/mtime/ctime: absent attributes are simply not written.
- The live corpus is FROZEN (measured 2026-08-10: 2,486 rows / 444 paths /
  61 MB, newest row 2026-07-19, 2,484 of them `phdb-migration`) — the
  master-plan's "~36k bodies" is the Eros CHUNK count, not rows. Measured
  divergence; the graph-volume gate passes trivially (~444 mints).

## Requirements *(mandatory)*

- **FR-001**: every distinct `source_path` MUST resolve to exactly one note
  (graph identity), keyed by source_path as its name.
- **FR-002**: version history MUST become CoW generations in stored order;
  the newest version is the active body, byte-for-byte.
- **FR-003**: provenance MUST ride as attributes on the note — source_path,
  raw_hash (newest), source_kind, mtime, ctime, title, schema_type,
  file_path, dissolved_at (the newest row's created_at) — never as a second
  table.
- **FR-004**: inline tags MUST be reconciled as real tag edges at migration
  and at each bridged write.
- **FR-005**: `write_document` MUST dual-write (table + note) during the
  bridge window, idempotently in both stores; `read_documents`/`read_plan`
  reads stay on the table until F7 cuts over (no torn read surface).
- **FR-006**: the migration MUST be re-runnable with zero effect on a
  converged store, and MUST fail loudly on any parity mismatch.

## Success Criteria *(mandatory)*

- **SC-001**: fixture-corpus migration: every path's newest body
  reconstructs byte-identically; per-version as-of reads serve each stored
  version; provenance attrs match the newest row's columns exactly.
- **SC-002**: re-run of the migration = zero deltas (rows, edges, events).
- **SC-003**: `write_document` with the graph facet: note minted + body
  landed + attrs + tags; identical re-submit no-ops in both stores.
- **SC-004**: live run (post-merge): 444 paths converge, parity clean,
  verbatim output pasted into the feature report.

## Assumptions

- The note's graph name = `source_path` (the unique, stable vault identity;
  human titles collide). [Default — logged binding]
- Original per-version `created_at` stamps are not reproducible as section
  event stamps (transaction-stable `now()`); the newest row's stamp rides as
  the `dissolved_at` attribute, and pre-F7 the table still serves the
  originals. Accepted loss at F7 is F7's to record. [Default]
- `content_hash` is derivable (sha256 of body) and not carried. [Default]
