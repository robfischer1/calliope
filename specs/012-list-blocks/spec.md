# Feature Specification: read_plan dissolves into list_blocks and read_block

**Status**: Draft | **Input**: Master-plan F5 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The container index is a general verb (Priority: P1)

Any consumer can ask for a container's block index — ids, titles, sizes,
order — without any body text crossing the wire. The special-case whole-plan
read dissolves into it: a plan is just a container whose index happens to be
feature-blocks.

**Independent Test**: call `list_blocks` against (a) a block container and
(b) a stored plan document; both return an index with zero body text.

**Acceptance Scenarios**:

1. **Given** a plan container, **When** `list_blocks` is called, **Then** it
   returns block ids, titles, sizes and order without body text.
2. **Given** a section-store container, **When** `list_blocks` is called,
   **Then** it returns each block's id, first-line title, character size and
   order key — no prose.

### User Story 2 - One feature crosses the wire, nothing else (Priority: P1)

Reading one feature of a plan moves only that feature's markdown. athena's
by-reference block path consumes the block verb, not the plan special-case.

**Independent Test**: read one feature block by handle + id; assert only that
block's text is served; athena's `resolve_plan` block path calls the block
verb.

**Acceptance Scenarios**:

1. **Given** one block id, **When** `read_block` is called with a document
   handle, **Then** only that block's markdown crosses; misses are structured
   (`document_not_found` / `block_not_found` / `bad_handle`).
2. **Given** athena's by-reference single-block resolution, **Then** it rides
   `read_block` (cross-star lockstep — the consumer swap).

### User Story 3 - read_plan demoted to a legacy alias (Priority: P2)

`read_plan` keeps working (fleet callers still dial it through the gateway)
but is documented as the legacy composition of `list_blocks` + `read_block`
(+ body). Removal is the strangler's later step, once the fleet sweep proves
no caller.

## Requirements *(mandatory)*

- **FR-001**: `list_blocks` MUST serve both handle families — a block
  container id, and a plan-document handle (`document` / `source_path`) —
  and never include body text.
- **FR-002**: `read_block` MUST additionally accept the plan-document handle
  family, serving one feature block's markdown.
- **FR-003**: misses MUST be structured, never thrown, on both families.
- **FR-004**: `read_plan` MUST remain behavior-identical, re-documented as
  LEGACY.
- **FR-005**: athena's single-block resolution MUST consume `read_block`;
  its whole-plan projection path is out of scope (it legitimately reads the
  whole body).

## Success Criteria *(mandatory)*

- **SC-001**: `list_blocks` round-trips over the same HTTP surface athena
  dials, for both families, with no `body_text`/`text` fields in the index.
- **SC-002**: `read_block` with a document handle serves exactly one block's
  markdown; all three miss shapes observable.
- **SC-003**: athena's `resolve_plan` block path calls `read_block` (its
  fake dial proves the verb name) and its tests stay green.
- **SC-004**: the calliope tool listing carries `list_blocks` (surface fence
  updated to 22).

## Assumptions

- The two handle families return honest per-family index shapes (plan
  blocks: `{id,title,size,order}`; section blocks: `{id,title,chars,
  order_key}`), discriminated by a `kind` field. [Default]
- Heading-derived feature ids (C7 grammar) survive as block addresses for
  document-backed plans; their fate once plans are real containers is B3's
  surfaced question, not resolved here. [Carried gap]
