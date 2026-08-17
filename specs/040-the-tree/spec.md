# Feature Specification: The Tree

**Status**: Draft | **Input**: Master-plan feature F3 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** Every unresolved point is `[OPEN: …]` or a
> logged Default. WHAT here; HOW in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A document is a document, not a bag of rows (Priority: P1)

A container (a note, a plan, a document) holds blocks in an order. That
structure lives in the graph as facts: the container is a node, each position
is a slot, each slot holds one piece of immutable prose by reference. Reading
the container resolves its blocks in order. This is the object Calliope never
had.

**Acceptance Scenarios**:

1. **Given** a container with N members, **When** read, **Then** the members
   return in position order.
2. **Given** a container with zero members, **When** read, **Then** it exists
   and reads empty (empty ≠ absent).
3. **Given** an edit that moves a member between positions, **When** read,
   **Then** order changes and no prose row changes.

### User Story 2 - A block belongs to many containers without duplication (Priority: P1)

The same prose can sit in two containers — governance fan-out is the designed
win — and both containers resolve it without copying it.

**Acceptance Scenarios**:

1. **Given** one blob referenced by two containers, **When** either is read,
   **Then** both resolve and the prose exists once.
2. **Given** a member moved from container A to container B, **When** both are
   read, **Then** the blob identity is unchanged.

### User Story 3 - Five tenants, five graphs (Priority: P2)

Notes, documents, comments, governance (and later memories) share the prose
store while each owns its structure in its own graph. One tenant's structure
is invisible from another tenant's graph.

**Acceptance Scenarios**:

1. **Given** structure written in the notes graph, **When** the documents
   graph is read, **Then** none of it appears.
2. **Given** a tenant name, **When** its scope is resolved, **Then** writes
   land in that tenant's graph and nowhere else.

### Edge Cases

- A slot with no content fact is a broken slot — readable as dangling, never
  silently skipped.
- Two slots of one container may hold the same blob (repeated boilerplate
  inside one document is legal).
- Ordering keys are opaque strings ordered bytewise; the reader sorts, the
  writer mints (the editor already mints fractional keys client-side).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Container membership, ordering, and content-reference MUST be
  expressed as graph facts in a per-tenant graph — never as columns on prose.
- **FR-002**: Each member MUST be a slot entity carrying exactly: membership
  (container→slot), position (slot→order key), content (slot→blob reference).
- **FR-003**: A container read MUST resolve to its blocks in position order.
- **FR-004**: A blob MUST be shareable across containers and across slots
  without duplication.
- **FR-005**: Moving or reordering MUST change only tree facts, never blobs.
- **FR-006**: Each tenant MUST have its own graph; structure in one graph
  MUST NOT be visible through another.
- **FR-007**: The write surface MUST be able to mint a slot and attach all
  three of its facts in ONE transaction (a save is atomic — the follow-on
  write path depends on it).
- **FR-008**: An empty container MUST be representable and distinguishable
  from a nonexistent one.

### Key Entities

- **Container**: an existing graph node (a note, a plan) that owns ordered
  members. Not new — notes are already nodes.
- **Slot (Block)**: the durable identity of one position's content. Editing
  repoints a slot; the slot outlives every edit.
- **Blob reference**: the slot's content fact, pointing into the prose store.

## Success Criteria *(mandatory)*

- **SC-001**: ordered resolution — N members read back in minted order, for
  containers of 0, 1, and many members.
- **SC-002**: sharing — one blob in two containers and in two slots of one
  container, resolved from both, stored once.
- **SC-003**: a move between containers preserves the blob id; a reorder
  mints no blob.
- **SC-004**: tenant isolation — a structure query scoped to tenant A returns
  nothing of tenant B.
- **SC-005**: one-transaction slot birth — mint + membership + position +
  content admitted as a single batch.

## Assumptions

- **Order keys are fractional strings** (Default, per the master-plan
  recommendation): the editor already mints `between()` fractional keys
  client-side; the tree stores them as opaque scalars ordered bytewise.
- **The slot's node kind is `Block`** (declared in the graph's closed kind
  set by the chaos-side slice of this feature).
- **Tenant graphs are `notes` (live), `documents`, `comments`, `governance`**
  (Default): the mnemosyne tenant is already graph-native and joins only if
  it adopts the shared store (master-plan: no change required).
