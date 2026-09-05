# Feature Specification: The container does not care who is writing

**Status**: Draft | **Input**: Stream of Consciousness — Prose Arrives With Its Metadata — Master-plan, F3 Head

## User Scenario
A writer that is not the notes path — mnemosyne storing a memory body — mints a container by title alone, writes one block of memory-shaped prose, and reads it back unchanged. No frontmatter, no tags, no provenance attribute is required; Calliope treats the text as prose and interprets none of it.
**Acceptance Scenarios**:
1. **Given** `create_note(title)` alone, **When** `write_container` adds a block, **Then** `read_container` returns it byte-for-byte and `materialize_note` shows no tags and no provenance.
2. **Given** the same title again, **Then** the same container is answered (idempotent) and an update replaces the one block in place, keeping its slot.
## Success Criteria
- **SC-001**: the round-trip test passes with zero production changes (`__tests__/writer-agnostic-container.test.ts`).
## Finding
No note-specific assumption was found: the note verbs' frontmatter/tag machinery is optional; the container is prose + identity. Confirmed, not built.
