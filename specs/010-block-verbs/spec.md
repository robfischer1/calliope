# Feature Specification: CRUD_block, split and merge

**Status**: Draft | **Input**: Master-plan F3 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. The WHAT lives here; the HOW lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Block-grain CRUD as the primary verbs (Priority: P1)

A caller can create, read, update and delete a single block of a container by
its stable id, without ever loading or rewriting the whole body. A container
of blocks is a note; one block is the degenerate case called a document.

**Why this priority**: this is Rob's stated primary grain ("C/R/U/D `_block`
should be Calliope's primary verbs" — TURN 257); every downstream bucket (B3
plan projection, B4 comments, B5 pointer, B6 search, B7 render) anchors to it.

**Independent Test**: create a block into a container, read it back by id,
update it (one superseding row; siblings untouched), delete it — all through
the public verb surface.

**Acceptance Scenarios**:

1. **Given** a container, **When** `create_block` is called with prose and a
   position, **Then** a new block exists at that position with a stable id
   and the siblings' ids and keys are untouched.
2. **Given** a block id, **When** `read_block` is called, **Then** only that
   block's content crosses; a miss is a structured `block_not_found`.
3. **Given** a block, **When** `update_block` runs, **Then** exactly one
   superseding row is written and lineage records the predecessor.
4. **Given** a block, **When** `delete_block` runs, **Then** the block leaves
   the body and reconstruction still shows it before the delete.
5. **Given** a stale block id in any write, **Then** the write rejects with
   `stale_section` and nothing is applied.

### User Story 2 - Split and merge preserve identity (Priority: P1)

The edits people actually make — Enter mid-paragraph, Backspace at a block
start — become identity-preserving structural ops instead of
delete-plus-create. A split's two children both trace to the original; a
merge's one survivor traces to both parents.

**Why this priority**: without it, every comment, pin and plan-feature
anchored to a block is orphaned by the most common editing gestures.

**Independent Test**: split a block at a caret offset and resolve both
children's lineage to the original; merge two adjacent blocks and resolve the
survivor's lineage to both.

**Acceptance Scenarios**:

1. **Given** a block and a caret offset, **When** `split_block` runs, **Then**
   two blocks exist with fractional order keys between the neighbours and
   both record the original as predecessor.
2. **Given** two adjacent blocks, **When** `merge_block` runs, **Then** one
   block exists and the lineage record carries both predecessors.
3. **Given** two NON-adjacent blocks, **When** `merge_block` runs, **Then**
   the op rejects (nothing merged) with a structured reason.
4. **Given** any prior revision, **When** the body is reconstructed after
   splits and merges, **Then** it reads exactly as it stood then.

### User Story 3 - write_body demoted from the front door (Priority: P2)

The whole-body replace survives as a documented legacy verb — the coarse
hatch, not the primary surface.

**Acceptance Scenarios**:

1. **Given** the verb listing, **Then** `write_body` is documented as the
   LEGACY coarse save pointing callers at the block verbs; its behavior is
   unchanged.

### Edge Cases

- Split at offset 0 or at the end of the text produces an empty-prose block —
  allowed (an empty block is storable); the caller owns caret semantics.
- Merging with a separator: the merged prose is first + separator + second;
  the separator defaults to none.
- `create_block` into an empty container appends as the first block.
- The fs backend does NOT grow these ops — file is truth, one block, no
  inference (master-plan constraint; grain untouched).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `create_block`, `read_block`, `update_block`, `delete_block`,
  `split_block`, `merge_block` MUST be public verbs on Calliope's MCP surface
  (and therefore reachable through the Hades gateway, which mirrors it).
- **FR-002**: `split_block` MUST produce two blocks whose lineage both
  resolve to the original, with order keys between the original's neighbours.
- **FR-003**: `merge_block` MUST require adjacency, produce one block, and
  record BOTH predecessors in the lineage (the F1 join table).
- **FR-004**: any stale block id MUST reject the whole op with
  `stale_section`; nothing partial is ever applied.
- **FR-005**: `write_body` MUST remain functional but documented as legacy.
- **FR-006**: as-of reconstruction MUST remain byte-exact across split and
  merge events.

## Success Criteria *(mandatory)*

- **SC-001**: all six verbs are served by the MCP server (tool listing) and
  round-trip through the tool layer.
- **SC-002**: split lineage: both children → original (both directions).
- **SC-003**: merge lineage: survivor → both parents (both directions).
- **SC-004**: stale-id writes reject whole; non-adjacent merges reject.
- **SC-005**: reconstruction at every prior revision is byte-identical after
  a split + merge sequence.

## Assumptions

- Caret offsets are UTF-16 code-unit offsets into the block's text (the
  editor's native offset space). [Default]
- A merge event records as a single-row write-event; a split as a two-row
  batch event. [Default — no history-surface schema change]
