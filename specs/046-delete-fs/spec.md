# Feature Specification: Delete the Parallel Implementation

**Status**: Implemented | **Input**: Master-plan feature F14 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One model, finally (Priority: P1)

Remove the offline backend and everything built to compensate for it: the
file-derived body client, the computed tag module, the local revision
log, the sqlite search index, and the interface that let two stores
pretend to be one. The desktop's ONE backend is the local engine (F13);
the markdown directory is its WORKING TREE.

**Acceptance Scenarios**:

1. **Given** the desktop after deletion, **When** exercised offline,
   **Then** read, write, history, tags and search all behave as before —
   and the markdown files still land on disk, readable without the app.
2. **Given** the codebase, **Then** no module derives sections from files
   and no call site tests for an fs-vs-store capability.
3. **Given** an external edit (another app wrote the file), **When** the
   note is read, **Then** the edit has been INGESTED into the engine as a
   transaction — `git add`, run lazily — and lands as ONE block (the
   grain is user-stated; a foreign editor states no boundaries).
4. **Given** a deleted working-tree file, **Then** the body reads empty
   and every prior state is an as-of read away (deletion is a
   working-tree edit, recoverable like any git deletion).

### User Story 2 - The upgrades deletion pays for (Priority: P2)

The engine's identities are DURABLE, so verbs the fs grain could never
serve go live: `apply_section_ops` (block-grain applies on the desktop),
stable section ids across edits, and real transactional history instead
of a revlog.

**Acceptance Scenarios**:

1. **Given** a saved note, **When** apply_section_ops
   updates/deletes/adds/reorders, **Then** the ops land as tree facts and
   the projection reflects them.
2. **Given** two notes with identical prose, **Then** ONE blob holds it.

## Success Criteria *(mandatory)*

- **SC-001**: `fs-client.ts`, `fs-tags.ts`, `fs-revlog.ts`, `fs-search/`
  and their suites are DELETED; `eros-provider` (the fleet's search
  routing, which merely lived in that directory) survives the move.
- **SC-002**: The BodyClient capability methods every surviving client
  implements lose their `?` and the tool layer's undefined-guards die
  (editSection, applySectionOps, readRevisions, readRevisionAt, hasBody).
  The still-optional five (splitSection, mergeSections, coalesceArc,
  createComment, listComments) are F12-bound: their verbs retire with the
  old families, guards and all.
- **SC-003**: Local search runs on the engine's own postgres (tsvector;
  the semantic arm follows pgvector into the payload and is NAMED dark).
- **SC-004**: The full real-engine suites (F13's) pass UNCHANGED against
  the engine-only sidecar.
