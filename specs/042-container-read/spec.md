# Feature Specification: The Container Read and History

**Status**: Draft | **Input**: Master-plan feature F5 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a container (Priority: P1)

A reader asks for a container and gets its blocks in order, with their
prose — the tree resolved, the blobs fetched, assembled.

**Acceptance Scenarios**:

1. **Given** a container, **When** read, **Then** blocks return in position
   order with their text.
2. **Given** a tree fact naming an absent blob, **Then** the read reports a
   dangling reference (text absent, marked) and does not fabricate.
3. **Given** an empty container, **Then** the read answers empty, not an
   error.

### User Story 2 - Read it as it stood at any past moment (Priority: P1)

History stops being a feature with its own tables and verbs: the graph
recorded every save as a transaction, so the same read at an earlier
transaction answers that moment's blocks, byte-identically.

**Acceptance Scenarios**:

1. **Given** a container and a past transaction id, **When** read as-of,
   **Then** the result matches what a read at that moment would have
   returned — including members since removed.
2. **Given** a container edited N times, **When** its history is listed,
   **Then** N transactions are reported with their authors and timestamps.
3. **Given** the history listing, **Then** no revision table is consulted —
   the graph is the only source.

### Edge Cases

- A member removed at tx k still appears in reads as-of < k.
- History reaches removed members' edits (the log remembers them).
- The as-of read's positions resolve to their values (not internal hashes).

## Requirements *(mandatory)*

- **FR-001**: The container read MUST resolve tree → blobs → assembled
  blocks, ordered by position, batched blob fetch (never per-block).
- **FR-002**: A blob reference that resolves to no stored text MUST surface
  as dangling — never skipped, never fabricated.
- **FR-003**: The as-of read MUST reconstruct the container at any past
  transaction from the graph alone.
- **FR-004**: The history listing MUST enumerate the transactions touching
  the container and its members — ever-members included — with author and
  timestamp, from the graph alone.
- **FR-005**: Both MUST be reachable as MCP verbs on the calliope server.
- **FR-006**: Read latency of the two-store read (tree + blob fetch) MUST be
  measured against a representative container and recorded — before the
  migration (F6) commits 36k documents to this path.

## Success Criteria *(mandatory)*

- **SC-001**: ordered read with text, empty container, and dangling-blob
  cases all covered by tests.
- **SC-002**: as-of read at tx k returns tx-k's blocks including
  later-removed members; a post-removal read excludes them.
- **SC-003**: history of an N-times-edited container lists N transactions
  with authors.
- **SC-004**: a recorded measurement: batched text fetch for a 50-block
  container against real postgres, number written into the spec dir.

## Assumptions

- **History listing and as-of reconstruction ride the chaos door's
  `history` and `quads_from(as_of_tx)` verbs** (landed chaos@887de87 — the
  F5 chaos slice; an RR addition surfaced like themis's).
- **The fixture dial grows a transaction log** (Default): the offline model
  must answer the same questions as the door or the suite proves nothing.
