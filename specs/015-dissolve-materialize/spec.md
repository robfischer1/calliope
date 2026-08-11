# Feature Specification: Dissolve and Materialize as container verbs

**Status**: Draft | **Input**: Master-plan F9 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dissolve promotes one container, chosen by a person (Priority: P1)

Rob, looking at a note, promotes THAT note into the constellation: its
blocks, its provenance, its tags — one container, one gesture. This inverts
C6's direction: notes are promoted one at a time by the person who knows
which ones matter, instead of swept by a policy authored in advance.

**Independent Test**: dissolve a multi-block container; the note exists in
the graph tenant with `hasTag` edges materialised, provenance attributes
preserved, and the blocks readable through the block surface.

**Acceptance Scenarios**:

1. **Given** a local container, **When** Dissolve runs, **Then** it exists
   in the graph tenant with `hasTag` edges materialised and provenance
   preserved.
2. **Given** a container whose blocks already exist remotely, **When**
   Dissolve runs with changed content, **Then** the local content lands as
   a superseding generation (history keeps the old); **and** with identical
   content, **Then** it is a no-op.

### User Story 2 - Materialize is the inverse (Priority: P1)

A remote container lands locally as blocks: one read serving the title,
blocks (ids, text, order), tags and provenance — everything the local
window needs to write the file.

**Acceptance Scenarios**:

1. **Given** a remote container, **When** Materialize runs, **Then** it
   returns the blocks in order plus tags and provenance attributes; a miss
   is a structured `container_not_found`.

### User Story 3 - C6's bulk sweep is retired (Priority: P2)

C6 ("The vault carve: Calliope eats all the markdown") and its unresolved
scope policy are retired by deletion: the graph node closes as retired, its
two open Rob-decisions close with it, and no sweep code ships (none was
ever built — verified by repo search).

## Requirements *(mandatory)*

- **FR-001**: `dissolve_note(source_path, blocks[], title?, provenance…)`
  MUST mint/reuse the note (identity = `source_path`, the F6 key), land the
  blocks as ONE generation, reconcile provenance attributes (the F6
  contract) and materialise inline tags as `hasTag` edges.
- **FR-002**: Dissolve MUST be idempotent: identical content no-ops at
  every layer; changed content is one superseding generation.
- **FR-003**: `materialize_note({container_id | source_path})` MUST serve
  blocks + tags + provenance in one read; misses structured.
- **FR-004**: both verbs register only when the graph facet is wired.
- **FR-005**: C6's node closes as retired with its open decisions.

## Success Criteria *(mandatory)*

- **SC-001**: wire-level dissolve → read via block surface → no-op retry →
  superseding re-dissolve, with tags and provenance asserted.
- **SC-002**: wire-level materialize round-trips what dissolve wrote;
  `container_not_found` observable.
- **SC-003**: surface fence carries both verbs (25).
- **SC-004**: C6 node closed as retired on the graph (recorded in the
  feature disposition).

## Assumptions

- Conflict semantics (the Tail gap): last-write-wins as a CoW generation —
  overwrite is non-destructive because history is append-only; finer merge
  UX is the editor's someday-problem, not the verb's. [Default — binding]
- `raw_hash` for a multi-block dissolve defaults to sha256 of the blocks
  joined with a blank line (the markdown projection separator F14 will
  formalize); Grace may pass the file's own hash explicitly. [Default]
