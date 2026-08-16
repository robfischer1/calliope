# Feature Specification: The Container Write

**Status**: Draft | **Input**: Master-plan feature F4 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default; WHAT here, HOW in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A save is one transaction (Priority: P1)

Saving a document mints the blobs it needs, then writes the tree that names
them — in that order, with all tree changes in one graph transaction. A crash
between the two phases leaves garbage (orphan blobs, reaped later by GC),
never corruption (no partial tree).

**Acceptance Scenarios**:

1. **Given** an N-block container and an edit to one block, **When** saved,
   **Then** exactly one blob is minted and N−1 members are untouched.
2. **Given** a save of several ops, **When** it completes, **Then** every
   tree change rode one admit batch (one graph transaction, one author).
3. **Given** the blob mint succeeded and the tree write failed, **Then** no
   tree change is visible and the blobs are orphans.

### User Story 2 - Identical content writes nothing (Priority: P1)

Re-submitting a block's unchanged text is a no-op end to end: the mint
dedupes to the existing blob, the repoint would point where it already
points, and no transaction opens.

**Acceptance Scenarios**:

1. **Given** byte-identical content re-submitted, **Then** nothing is
   written — no blob row, no admit.
2. **Given** a batch where some ops are no-ops and some are real, **Then**
   only the real ops write.

### User Story 3 - The one-block degenerate case (Priority: P2)

A document whose blocks cannot be separated saves as one block through the
same path — no special verb, no error. (This is the successor of the old
coarse-save fallback.)

**Acceptance Scenarios**:

1. **Given** prose with no internal boundaries, **When** saved as a single
   add, **Then** the container holds exactly one member.

### Edge Cases

- A reorder mints no blob; a move-between-containers mints no blob.
- Two adds in one save must not collide on their batch-local slot labels.
- A refused admit surfaces the gate's violations — never swallowed.
- An update whose old blob id is stale (slot repointed concurrently) retracts
  a fact that is no longer there; the graph's netting makes the retract a
  no-op and the assert lands — last write wins, no error. [Default]

## Requirements *(mandatory)*

- **FR-001**: Writes MUST be blob-first: every needed blob is durable before
  any tree fact references it (blob → fact → ref, never reversed).
- **FR-002**: All tree ops of one save MUST ride one admit batch.
- **FR-003**: Content-identical updates and adds MUST net out before the
  batch; a save whose ops all net out MUST NOT open a transaction.
- **FR-004**: The write MUST express: add (new slot), update (repoint),
  remove (slot facts retracted), reorder (position fact rewritten) — and
  nothing else touches structure.
- **FR-005**: A refused batch MUST surface violations and change nothing.
- **FR-006**: The surface MUST be reachable as an MCP verb on the calliope
  server (the container surface F8 later ferries).

## Success Criteria *(mandatory)*

- **SC-001**: one-block edit of a 3-block container → exactly 1 mint, 1
  repoint pair, 2 untouched slots.
- **SC-002**: identical re-submit → zero writes, zero admits.
- **SC-003**: mixed batch → one admit carrying only the real ops.
- **SC-004**: refused admit → violations surfaced, tree unchanged, minted
  blobs orphaned (present in the store, referenced nowhere).
- **SC-005**: single-add save → container of one member.

## Assumptions

- **Stale-old-blob updates resolve by netting** (Default, edge case above).
- **The author rides the transaction via the admit door** (themis resolves
  the writing principal; calliope does not smuggle a row-level author —
  master-plan: provenance rides the transaction).
- **`kafka_offset` does not move to the new model** (Default, resolving the
  MP gap): it stamped every row of a batch identically and was never unique;
  the transaction id is the batch identity now. The column dies with
  `sections` at F12.
