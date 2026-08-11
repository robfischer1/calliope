# Feature Specification: Coalesce block writes per writing arc

**Status**: Draft | **Input**: Master-plan F8 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Row growth is bounded by sessions, not pauses (Priority: P1)

Autosave is idle-debounced, so a long session grinding on one paragraph
writes one superseding row per pause. When the writing arc closes, the
intra-arc supersession chain collapses to its endpoints: the pre-arc state
and the final state, with the intermediate pause-rows physically removed and
lineage rewired across the gap.

**Why this priority**: without a bound, a revision list grows forty
near-identical entries per work session and the store's growth curve follows
pauses, not work.

**Independent Test**: write N pause-edits to one block, close the arc,
coalesce; the store holds the pre-arc row plus ONE superseding row; lineage
resolves final → pre-arc in both directions; reconstruction at the pre-arc
and post-arc moments is byte-identical to before the collapse.

**Acceptance Scenarios**:

1. **Given** an editing arc with N pause-writes on one block, **When** the
   arc closes and coalescing runs, **Then** the chain collapses to its
   endpoints and reconstruction of the endpoint states is unchanged.
2. **Given** the collapsed chain, **Then** the intermediate rows and their
   lineage edges are GONE (the growth bound is real, not cosmetic), and the
   final row's lineage records the pre-arc row as predecessor.

### User Story 2 - Structure boundaries are never collapsed across (Priority: P1)

A split or merge inside the window is a structural event whose lineage
carries anchor identity; the collapse walk stops at any row with more or
fewer than one predecessor, or whose predecessor has more than one
successor. Tombstones and active rows are never removed.

**Acceptance Scenarios**:

1. **Given** a split or merge inside the arc window, **When** coalescing
   runs, **Then** the collapse stops at the structural boundary and the
   split/merge lineage survives intact.

### User Story 3 - Off by default until verified (Priority: P1)

The verb is registered but refuses unless explicitly enabled by the
operator, so nothing in production collapses history until the behavior has
been observed in anger.

**Acceptance Scenarios**:

1. **Given** the default environment, **When** the verb is called, **Then**
   it refuses with a clear "disabled" message and changes nothing.

## Requirements *(mandatory)*

- **FR-001**: a `coalesce_block_writes` verb MUST accept the container, the
  block (the arc's final row), and the arc-start moment — the arc signal is
  a VERB ARGUMENT (the client owns arc detection; no telemetry dependency).
- **FR-002**: the collapse MUST physically remove intermediate rows and
  their lineage edges, and rewire the final row's lineage (column AND join
  table) to the pre-arc predecessor.
- **FR-003**: the walk MUST stop at structural boundaries (≠1 predecessor,
  predecessor with >1 successor, tombstones) and MUST never touch active
  rows other than the final one's lineage pointer.
- **FR-004**: reconstruction at every surviving moment MUST be
  byte-identical before and after the collapse.
- **FR-005**: coalescing MUST be disabled by default; an env flag enables
  it.

## Success Criteria *(mandatory)*

- **SC-001**: N pause-edits collapse to pre-arc + final; row and edge
  deltas equal the removed intermediates exactly.
- **SC-002**: endpoint reconstructions byte-identical pre/post collapse.
- **SC-003**: split/merge lineage inside the window survives untouched.
- **SC-004**: default env → structured refusal, zero writes.

## Assumptions

- The arc's final row is named by block id; the arc start is named by a
  revision timestamp (from `read_body_revisions`) — both things the editor
  already holds. [Default]
- What a B4 comment anchored to a collapsed intermediate revision renders
  as is B4's question, surfaced not resolved here (comments do not exist
  yet; the lineage the collapse PRESERVES — endpoints — is what B4 will
  anchor forward through). [Carried gap]
