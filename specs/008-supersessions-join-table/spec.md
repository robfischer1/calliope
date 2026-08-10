# Feature Specification: The supersessions join table

**Status**: Draft | **Input**: Master-plan F1 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. A reasonable default is allowed but must be logged in
> Assumptions as a Default-provenance decision, not left implicit. The WHAT lives
> here; the HOW (architecture, contracts) lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A merge can record all of its predecessors (Priority: P1)

Today a block's lineage record can name at most one predecessor, so a merge
(A+B→C) cannot record that C supersedes two blocks. Anything anchored to A or B
— a comment, a pin, a plan feature — silently loses its anchor when the two
paragraphs are merged. After this feature, a successor block can record N
predecessors, so every anchor on a merged-away block can still resolve forward
to the surviving block.

**Why this priority**: every downstream feature that anchors to a block id
(B4's comments, B5's pins, B3's plan features) depends on lineage that survives
a merge; the plan's merge verb (F3) is inexpressible without it.

**Independent Test**: record a supersession with two predecessors and read it
back from both directions — successor → both predecessors, each predecessor →
the successor.

**Acceptance Scenarios**:

1. **Given** a merge of two blocks, **When** the supersession is recorded,
   **Then** both predecessors are queryable from the successor and both
   directions resolve (successor→predecessors, predecessor→successor).
2. **Given** a block with one predecessor (an ordinary edit), **When** its
   lineage is recorded, **Then** it reads identically to how single-parent
   lineage reads today.

### User Story 2 - Existing lineage survives the backfill unchanged (Priority: P1)

The store already holds single-predecessor lineage. Backfilling it into the new
lineage record must not change what any reader observes: revision history and
as-of reconstruction return exactly what they returned before.

**Why this priority**: the backfill touches every existing row's lineage; a
silent behavior change here corrupts history for every body in the store.

**Independent Test**: capture as-of reconstructions for bodies with mixed
lineage (saves, edits, batch ops, deletes) before the backfill, run the
backfill, and compare byte-for-byte.

**Acceptance Scenarios**:

1. **Given** a block with one predecessor, **When** the backfill runs, **Then**
   the new lineage record carries the same edge and reconstruction is
   unchanged.
2. **Given** any body with existing history, **When** reconstruction is asked
   for any prior revision after the backfill, **Then** the returned body is
   byte-identical to the pre-backfill answer.

### Edge Cases

- What happens to tombstone (delete-marker) lineage rows during the backfill?
  They carry a predecessor edge too — the backfill must carry them or state why
  not. `[OPEN: backfill behaviour for tombstone rows — surfaced by the
  master-plan as a gap]`
- What happens to add-marker rows whose lineage value is the empty marker (an
  add, not a supersession)? They must NOT produce a lineage edge.
- Re-running the backfill must not duplicate edges (idempotence).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The store MUST be able to record that one successor block
  supersedes N predecessor blocks (N ≥ 1) within one owning node.
- **FR-002**: Lineage MUST be queryable in both directions: given a successor,
  list its predecessors; given a predecessor, find its successor(s).
- **FR-003**: Every existing single-predecessor lineage edge MUST be backfilled
  into the new record, and the backfill MUST be idempotent.
- **FR-004**: The existing single-predecessor storage MUST remain in place and
  continue to be written until the block-verb surface (F3) cuts over; the new
  record is written alongside it.
- **FR-005**: Revision listing and as-of reconstruction MUST return identical
  results before and after the backfill.

### Key Entities

- **Supersession edge**: one (successor block, predecessor block) pair within
  an owning node, stamped with when it was recorded. A merge produces several
  edges sharing one successor; a split produces several edges sharing one
  predecessor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A successor records N predecessors and both query directions
  resolve, for N = 1 and N = 2.
- **SC-002**: Existing single-parent lineage reads identically after the
  change (revision listing unchanged for a body with save/edit/ops history).
- **SC-003**: As-of reconstruction returns byte-identical bodies before and
  after the backfill, across bodies with saves, edits, batch ops and deletes.

## Assumptions

- The new lineage record lives beside the existing one rather than replacing
  it in this feature; removal or demotion of the old storage is F3's decision
  (master-plan: "leave the column until F3 cuts over"). [Default — carried
  from the master-plan Brief]
- "Both directions resolve" means point queries by successor id and by
  predecessor id; no recursive ancestry walk is required by this feature.
  [Default — smallest reading of the Brief; F3's split/merge consumes point
  queries]
