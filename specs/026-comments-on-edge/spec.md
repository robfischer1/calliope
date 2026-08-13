# Feature Specification: A Comment Is a Block with a commentsOn Edge

**Feature Branch**: `026-comments-on-edge`

**Created**: 2026-08-13

**Status**: Draft

**Input**: User description: "Model a comment as an ordinary block carrying a commentsOn edge at another block, authored by a session principal"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A session comments on a block (Priority: P1)

A session reading a shared document notices something about one specific block — drift, an error, a question — and attaches a comment **to that block**: an ordinary block of prose carrying an edge that points at the target, attributed to the commenting session. No new storage system, no new content type, no separate comment machinery — the cheapness is the point: block grain already paid for this.

**Why this priority**: this is the write half of attributed review — the thing the whole programme exists to enable. Today the observation goes into a checkpoint nobody reads; after this, it lands on the artifact it is about.

**Independent Test**: Create a comment against a block with a session author; read it back and confirm the block exists, carries the author, and its edge resolves to the target.

**Acceptance Scenarios**:

1. **Given** a target block, **When** a comment is created with a session author, **Then** a block exists whose edge points at the target and whose author is the session principal.
2. **Given** a comment, **When** its edge is resolved, **Then** the target block returns; **Given** the target, **When** its comments are resolved, **Then** the comment returns — the edge answers both directions.
3. **Given** a comment creation without a session author, **When** attempted, **Then** it is rejected — a comment is attributed by definition.

---

### User Story 2 - A comment is a first-class block (Priority: P2)

A comment can be edited (copy-on-write, lineage preserved), has revisions, carries write provenance (author + log offset), and can itself be commented on (a reply is a comment whose target is a comment). Everything blocks already do, comments do, because they are blocks.

**Independent Test**: Edit a comment and confirm its revision history shows both versions with authors; comment on the comment and confirm the reply's edge resolves to the parent comment.

**Acceptance Scenarios**:

1. **Given** a comment, **When** edited, **Then** it copy-on-writes exactly as any block does and its history shows each revision's author.
2. **Given** a comment, **When** a reply is created against it, **Then** the reply's edge resolves to the comment, and the thread reads back as a chain.
3. **Given** a comment created with a session log offset, **Then** its provenance carries the offset like any block write.

---

### User Story 3 - Threads survive what happens to their targets (Priority: P2)

Blocks get edited, split, merged, and deleted. A comment anchored to a block that was later superseded still resolves — through the target's lineage — to whatever stands in its place now; a comment on a deleted block reports the deletion rather than vanishing or erroring.

**Why this priority**: "deleting the target does not silently orphan the thread" is a stated success condition; a review trail that evaporates when the text changes is not a review trail.

**Acceptance Scenarios**:

1. **Given** a comment on a block, **When** the target is edited (superseded), **Then** resolving the current block's comments includes the comment, via the lineage record.
2. **Given** a comment on a block, **When** the target is merged or split, **Then** the comment resolves through the lineage to the surviving block(s).
3. **Given** a comment on a deleted block, **When** the thread is read, **Then** the comment returns with the target reported as deleted — never silently dropped.

---

### Edge Cases

- The comment's own prose lives outside the target document's body: reading the document returns exactly the blocks it had before anyone commented.
- A comment with no valid target block rejects (`stale`-style error); nothing lands.
- Comment creation is atomic: the block and its edge land together or not at all.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A comment MUST be creatable against any block, as a block plus an edge, in one atomic operation.
- **FR-002**: A comment MUST carry a session-principal author; creation without one is rejected.
- **FR-003**: The edge MUST resolve both ways: block → its comments, comment → its target.
- **FR-004**: A comment MUST support everything a block supports: copy-on-write edit, revision history, write provenance, and being itself a comment target (replies).
- **FR-005**: A superseded target (edit/split/merge) MUST still resolve its inherited comments through the lineage record; a deleted target MUST be reported as deleted, never silently orphaning the thread.
- **FR-006**: The target document's body reads MUST be unchanged by the existence of comments.

## Success Criteria *(mandatory)*

- **SC-001**: 100% of created comments read back with target, author, and prose intact — both resolution directions.
- **SC-002**: Zero changes to document body reads (existing suites untouched and green).
- **SC-003**: After any supersession of a commented block, thread resolution for the current block includes 100% of the comments made on its lineage predecessors.
- **SC-004**: No partial state is observable: a failed comment creation leaves neither a block nor an edge.

## Assumptions

- The block substrate (create, edit, lineage, provenance) is the landed 024/025 machinery; comments reuse it wholesale.
- Rendering (rails, threading UI, decay) is out of scope — separate features consume this model.
- Anchoring a comment to a specific *revision* of its target is a separate feature (F8); this feature stores the block-grain edge and the timestamps F8 will resolve with.
