# Feature Specification: Anchor a Comment to a Revision

**Feature Branch**: `027-comment-anchors`

**Created**: 2026-08-13

**Status**: Draft

**Input**: User description: "Anchor a comment to the revision of its target that existed when the comment was made, with drift visible"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An old comment shows the prose it was about (Priority: P1)

A reader opens a two-week-old comment thread. The commented block has been rewritten since. The thread can render the target **as it stood when the comment was made** — the exact prose the commenting session was reading — alongside the current text.

**Why this priority**: a comment rendered against today's rewrite is a comment about something that no longer exists. The block store's as-of reconstruction already exists; this exposes it at the thread read. (A well-known code-review tool cannot do this — it marks the comment "outdated" and collapses it, because a diff has no addressable history.)

**Acceptance Scenarios**:

1. **Given** a comment made when its target read "v1", **When** the target now reads "v2" and the thread is read with anchors, **Then** the comment carries the anchor text "v1", the current text "v2", and a drift flag set.
2. **Given** a comment on the target's current text, **Then** the anchor equals the current text and the drift flag is clear.

---

### User Story 2 - Anchors survive history compaction (Priority: P2)

Stored history gets physically compacted (the writing-arc collapse removes pause-write intermediates). A commented moment is never compacted away: compaction treats a reviewed revision as a boundary, so the anchor always resolves exactly.

**Acceptance Scenarios**:

1. **Given** a comment on a writing-arc intermediate, **When** the arc is compacted, **Then** the commented revision survives (compaction skips it) and the anchor still resolves to its exact prose.

---

### Edge Cases

- Anchor resolution is opt-in per read (it costs a reconstruction per comment); the default read is unchanged.
- A target absent from the anchor-time reconstruction (e.g. the block did not exist yet in that container) yields a null anchor text, never an error.
- Reply comments anchor within the comment container by the same rule.

## Requirements *(mandatory)*

- **FR-001**: The thread read MUST optionally resolve, per comment, the target's text as of the comment's creation moment.
- **FR-002**: The resolved record MUST carry the current text alongside and a drift flag (anchor ≠ current).
- **FR-003**: History compaction MUST treat a commented revision as a boundary (never removed), so anchors stay exact; anchored reads never error.
- **FR-004**: The default (anchor-less) read MUST be byte-identical to today's.

## Success Criteria *(mandatory)*

- **SC-001**: For any write history, anchored reads return the reconstruction the store's as-of read gives for the comment's moment — the two never disagree.
- **SC-002**: Drift is flagged if and only if anchor and current text differ.
- **SC-003**: Zero change to anchor-less reads (existing suites untouched).

## Assumptions

- The comment model (026) and the store's as-of reconstruction are landed; this feature joins them at the read.
- Rendering the drift is the surface's feature (theia); this is the data half.
- Re-anchoring a comment to head is out of scope (surfaced by the master plan as an open question; nothing here precludes it).
