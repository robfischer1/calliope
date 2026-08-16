# Feature Specification: The Blob Store

**Status**: Draft | **Input**: Master-plan feature F1 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. A reasonable default is allowed but must be logged in
> Assumptions as a Default-provenance decision, not left implicit. The WHAT lives
> here; the HOW (architecture, contracts) lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A paragraph has one home (Priority: P1)

Rob (or any writer in the fleet) stores a piece of prose. The store gives back a
durable identity for it. If the same prose is ever stored again — by the same
writer, a different tenant, or a re-run of the same save — the store recognizes
it and returns the identity it already has, without creating anything new.
Editing a document becomes a matter of pointing somewhere else instead of
rewriting rows.

**Why this priority**: this is the plan's central object. Nothing else in the
master-plan (the tree, the write path, migration) is safe to build until prose
has one home and one identity that never moves.

**Independent Test**: mint a piece of prose twice and observe one stored row and
two identical identities; mint different prose and observe distinct identities.

**Acceptance Scenarios**:

1. **Given** prose not previously stored, **When** it is minted, **Then** a new
   row exists and its identity is returned.
2. **Given** byte-identical prose already stored, **When** it is minted again,
   **Then** no row is written and the existing identity is returned.
3. **Given** two pieces of prose that differ in any byte, **When** each is
   minted, **Then** their identities are distinct.
4. **Given** two writers minting the same prose concurrently, **When** both
   complete, **Then** exactly one row exists and both hold the same identity.

### User Story 2 - Prose is retrievable by identity or by content (Priority: P2)

A reader holding an identity fetches the exact prose it names. A writer holding
prose can ask whether the store already knows it, and get its identity back if so.

**Why this priority**: the tree (the follow-on feature) names these rows by
identity; readers resolve identities back to text. Without both directions the
store is write-only.

**Independent Test**: mint, fetch by identity, compare text byte-for-byte; probe
by content for stored and unstored prose.

**Acceptance Scenarios**:

1. **Given** a stored blob, **When** fetched by its identity, **Then** the exact
   stored text returns, byte-identical.
2. **Given** stored prose, **When** probed by content, **Then** its identity
   returns.
3. **Given** prose never stored, **When** probed by content, **Then** the store
   reports absence (no identity, no error).
4. **Given** an identity that names nothing, **When** fetched, **Then** the
   store reports absence rather than fabricating.

### User Story 3 - Full-text search over the store (Priority: P3)

Anyone can run a full-text query over everything stored and get matching blobs
back, ranked by relevance.

**Why this priority**: search is a required property of the store, but no
consumer in this feature depends on it — it becomes load-bearing when the
offline engine folds local search onto the store.

**Independent Test**: store several distinct paragraphs, query a term present in
some of them, observe ranked matches.

**Acceptance Scenarios**:

1. **Given** stored blobs some of which contain a term, **When** a full-text
   query for that term runs, **Then** the matching blobs return, ranked.
2. **Given** a query matching nothing, **When** it runs, **Then** an empty
   result returns (no error).

### Edge Cases

- Empty prose (`""`) is a valid blob: migration of the existing store must be
  able to carry any historical row, including empty ones (see Assumptions).
- Very large prose (beyond an index engine's per-row limits) must still dedupe
  correctly — content uniqueness may not silently stop applying above a size.
- Unicode: identity is **byte** identity. Two strings that render identically
  but differ in bytes (NFC vs NFD) are distinct blobs. The store never
  normalizes.
- Concurrent duplicate mints must converge on one row (US1-4).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The store MUST persist prose as immutable rows: once stored, a
  blob's text never changes and nothing in this feature deletes it.
- **FR-002**: Minting prose MUST be idempotent on byte-identical content: the
  first mint creates a row and returns its identity; every later mint of the
  same bytes writes nothing and returns the same identity.
- **FR-003**: Distinct content MUST yield distinct identities.
- **FR-004**: The store MUST resolve an identity to its exact stored text, and
  MUST report absence (not fabricate) for an identity that names nothing.
- **FR-005**: The store MUST answer a content probe: given prose, return its
  identity if stored, absence if not.
- **FR-006**: The store MUST answer full-text queries over all stored prose
  with ranked matches.
- **FR-007**: The store MUST carry no membership, ordering, currency, lineage,
  or authorship attribute. Its only facts are "this text exists" and "this is
  its identity". Structure lives elsewhere (the tree).
- **FR-008**: Concurrent mints of the same content MUST converge on one row
  with one identity (no duplicate, no error surfaced to either caller).

### Key Entities

- **Blob**: one piece of prose and its durable surrogate identity. Immutable.
  Content-unique. Knows nothing about who wrote it, where it belongs, or
  whether anything still points at it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: minting the same prose N times yields exactly 1 stored row and N
  identical identities, for any N ≥ 1.
- **SC-002**: minting K distinct pieces of prose yields exactly K rows and K
  distinct identities.
- **SC-003**: a full-text query over a populated store returns its matches
  ranked; a no-match query returns empty.
- **SC-004**: inspection of the store's schema shows exactly two user-facing
  attributes — identity and text — and no column expressing membership, order,
  currency, lineage, or authorship.
- **SC-005**: fetch-by-identity returns text byte-identical to what was minted,
  for every blob in a round-trip test corpus including empty, unicode-mixed,
  and multi-kilobyte samples.

## Assumptions

- **Identity is byte identity** (Default): dedup keys on exact bytes, no
  unicode normalization, no whitespace trimming. Rationale: the store must
  never alter prose, and byte equality is the only definition that guarantees
  a byte-identical read-back.
- **Empty text is a valid blob** (Default): the migration that follows this
  feature must carry every historical section row, and empty rows may exist.
  Refusing empties would strand them; storing them is harmless.
- **No delete surface in this feature** (Default): reaping unreferenced blobs
  is the garbage-collection feature's job (master-plan F7), designed around a
  census. A delete verb here would bypass that design.
- **Search ranking quality is not a success criterion** (Default): "ranked" is
  required; a particular ranking function's quality is not measured here.
