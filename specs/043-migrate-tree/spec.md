# Feature Specification: Migrate Sections to Blobs and Tree

**Status**: Draft | **Input**: Master-plan feature F6 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nothing is lost (Priority: P1)

Every block in the old store — every note, plan, and dissolved document in
the vault — moves into the new model: its prose becomes a blob, its
membership and order become tree facts, its history becomes a chain of
transactions. A migration that loses one paragraph is worse than no
migration; verification is per-row and any mismatch fails the run.

**Acceptance Scenarios**:

1. **Given** the old store, **When** migrated, **Then** each active section
   has a blob with byte-identical text and a tree member at the same
   position, and every container reads back in the same order.
2. **Given** a multi-generation block, **Then** its versions appear as
   ordered transactions: reconstruction at each old revision matches the
   new model's read as-of that revision's transaction.
3. **Given** any parity mismatch, **Then** the run exits nonzero and names
   the rows.

### User Story 2 - Idempotent and resumable (Priority: P1)

A re-run of a converged store writes nothing. A run interrupted mid-way
resumes: migrated containers are marked and skipped; unmigrated ones
proceed.

**Acceptance Scenarios**:

1. **Given** the migration re-run, **Then** it writes nothing new (marker
   check, zero admits).
2. **Given** a container whose old store changed AFTER its migration
   marker, **Then** the run refuses that container loudly (the old store
   must be frozen during migration) rather than silently diverging.

### User Story 3 - Comments migrate with their threads (Priority: P2)

A comment is a block in its document's comment container plus one edge to
its target block. Both survive: comment containers migrate like any
container (into the comments graph), and each `comments_on` row becomes a
fact between the two slots.

**Acceptance Scenarios**:

1. **Given** a comment on a block, **When** migrated, **Then** the comment's
   slot carries a comments_on fact to the target's slot, resolvable from
   the comments graph.

### Edge Cases

- Ops-only bodies (never coarse-saved) reconstruct correctly (the old
  store's anchor coalescing) and replay correctly.
- A merge generation (one successor, N predecessors) repoints the first
  predecessor's slot and removes the others'.
- A revision whose net change is empty opens no transaction; its parity
  checks against the previous transaction.
- Containers whose old id is not a graph token (ULIDs, `#comments` derived
  ids) get a minted container node with the old id recorded on it.

## Requirements *(mandatory)*

- **FR-001**: Replay per container, oldest revision first, one transaction
  per non-empty revision, blob-first within each.
- **FR-002**: Every slot MUST carry provenance to its old section id (a
  fact), so cross-container references (comments) and audits resolve
  without the old tables.
- **FR-003**: Per-row parity MUST cover: HEAD texts+order per container,
  and per-revision reconstruction vs as-of reads. The report covers the
  whole store; any mismatch fails the run.
- **FR-004**: Idempotency MUST be marker-based (a fact on the container),
  resumable per container, and drift after migration MUST refuse.
- **FR-005**: `comments_on` rows MUST become slot-to-slot facts in the
  comments graph.
- **FR-006**: The tool MUST have a read-only probe mode and follow the
  repo's probe-then-execute migration precedent.
- **FR-007**: The old tables are NOT touched — reads stay on them until the
  cut (F12), which is gated on this run's parity report.

## Success Criteria *(mandatory)*

- **SC-001**: on a store with multi-revision bodies (incl. edits, reorders,
  removals, merges), full parity: HEAD and every revision.
- **SC-002**: second run: zero admits, zero mints.
- **SC-003**: post-migration old-store drift → the container refuses.
- **SC-004**: a comment thread resolves slot-to-slot after migration.

## Assumptions

- **Original per-revision authorship and timestamps are NOT stamped onto
  the graph transactions** (the admit wire carries no author/time override
  — deliberately, N5's anti-spoofing). They are preserved in the run
  report (revision → tx → author/timestamp), and the old rows remain until
  F12. Surfaced as an [OPEN] for Rob: extending the gate with a
  migration-only override is a themis decision, not taken here.
- **Tenant derivation** (Default): `#comments`-suffixed containers → the
  comments graph; everything else → notes (documents ARE notes post-F7
  merge; the documents graph activates with new writes at F10).
- **The live run is an ops act** (Default): this feature ships and verifies
  the tool; running it against the production store — and the Poseidon
  per-graph visibility check the master plan requires first — is Rob's
  call, listed in the run's completion report.
