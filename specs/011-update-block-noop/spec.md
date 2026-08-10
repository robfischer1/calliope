# Feature Specification: update_block as the plan-edit path

**Status**: Draft | **Input**: Master-plan F4 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]`.
> The WHAT lives here; the HOW lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Editing a plan is a store write, at block cost (Priority: P1)

Editing one paragraph of a plan writes to the store directly — no file edit
someone must remember to re-dissolve (the mechanical cause of a plan copy
sitting 22 days stale). The cost is one block: exactly one superseding row,
with the container's other blocks untouched and shared by reference, and the
write carrying provenance.

**Why this priority**: this is the verb B3's plan pipeline depends on.

**Independent Test**: update one block of an N-block container and count the
store's new rows: exactly one; siblings' ids unchanged; provenance persisted.

**Acceptance Scenarios**:

1. **Given** a container of N blocks, **When** one block is updated, **Then**
   exactly one new row is written and N-1 are reused by reference.
2. **Given** the updated row, **Then** it carries the writer's provenance.

### User Story 2 - An identical re-submit is a no-op (Priority: P1)

Re-submitting a block's current text writes nothing: no new row, no lineage
edge, no revision event, and the block keeps its id. A retrying caller (or a
pipeline that re-runs) cannot inflate history by repeating itself.

**Independent Test**: update a block with its own current text; row count,
lineage and revision list are unchanged and the returned block carries the
same id.

**Acceptance Scenarios**:

1. **Given** a block, **When** `update_block` is called with byte-identical
   text, **Then** the store is unchanged (rows, lineage, revisions) and the
   returned block id equals the current id.
2. **Given** a block, **When** updated with different text, **Then** the
   normal copy-on-write applies (one superseding row, fresh id).

## Requirements *(mandatory)*

- **FR-001**: a single-block update MUST write exactly one superseding row;
  sibling rows MUST be reused, not rewritten.
- **FR-002**: a byte-identical re-submit MUST be a no-op observable in rows,
  lineage and revisions, returning the current block unchanged.
- **FR-003**: the no-op decision MUST be race-safe (made under the same lock
  the write path takes, not by a separate read).
- **FR-004**: the updated row MUST carry the configured provenance.

## Success Criteria *(mandatory)*

- **SC-001**: row-count delta of an N-block container after one update = 1.
- **SC-002**: identical re-submit: row/edge/revision deltas = 0, id stable.
- **SC-003**: provenance readable on the superseding row.

## Assumptions

- "Identical" means byte-identical text (no normalization). [Default]
- The no-op applies to the single-block edit path (`update_block` /
  `edit_section`); the editor's batch path (`apply_section_ops`) keeps its
  existing semantics — the editor sends diffs, not re-submits. [Default —
  smallest reading of the Tail Scope, which names the single-block path]
