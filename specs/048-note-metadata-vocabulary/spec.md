# Feature Specification: The note arrives with enough to filter on

**Status**: Draft | **Input**: Stream of Consciousness — Prose Arrives With Its Metadata — Master-plan, F1 Head

## User Scenarios & Testing *(mandatory)*
### User Story 1 - A published note carries what a searcher filters by (Priority: P1)
A note is written. The event the index receives carries the note's tags, its container identity, its revision, who wrote it, when it was created and last changed, and whether it is live or archived — not only a body and a title.
**Acceptance Scenarios**:
1. **Given** a note write, **When** published, **Then** the event's metadata carries tags, container, revision, author kind, timestamps and lifecycle state.
2. **Given** a note with no tags, **Then** the `tags` key is absent, not empty.
3. **Given** a re-publish of an unchanged note (a write that nets out), **Then** nothing publishes.
### User Story 2 - The keys are a contract, written down (Priority: P1)
Every key the producer emits is documented, because a consumer filtering on one makes it a contract.
## Requirements
- **FR-001**: metadata keys exactly the documented vocabulary; absent-not-empty.
- **FR-002**: `date_sent` always present (the index's date arm); `container` always present.
- **FR-003**: the vocabulary is documented in `docs/consciousness-producer.md`.
## Success Criteria
- **SC-001**: a published note carries tags, container, revision, author kind, timestamps (tests `note-publish.test.ts`, `consciousness-emit.test.ts`).
- **SC-002**: eros narrowed by `since`/`until` (date_sent) or `source` returns a strict subset — the read side eros has today; tags/container/lifecycle filters are eros follow-ups, recorded.
## Assumptions
- **Default (binding):** the read side eros implements today is `source`, `since`/`until` and `focus_terms`; the other keys ride in `metadata_json` until eros filters on them.
