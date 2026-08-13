# Feature Specification: Widen AuthoredBy to a Session Principal

**Feature Branch**: `024-authoredby-session-principal`

**Created**: 2026-08-13

**Status**: Draft

**Input**: User description: "Widen AuthoredBy so a block write can carry a SPIFFE session principal alongside the legacy human and calliope values"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A session's block write is attributed to that session (Priority: P1)

An agent session writes a block to a shared document. The write records the session's own identity — its session principal — as the author, so any later reader can ask "which session wrote this?" and get a specific, resolvable answer instead of an anonymous default.

**Why this priority**: This is the single broken link in an attribution chain whose other two hops already work. The fleet's work-graph already attributes assertions to session principals, and the session-history service already resolves a principal to a full transcript — but block provenance cannot hold a principal, so every block write is anonymous. Every downstream attribution feature waits on this.

**Independent Test**: Write a block supplying a session principal as the author; read the block's provenance back and confirm the exact principal is returned.

**Acceptance Scenarios**:

1. **Given** a session principal, **When** a block is written with it, **Then** the stored provenance carries that principal verbatim.
2. **Given** a block written by a session principal, **When** its provenance is read back, **Then** the principal is returned exactly as written.

---

### User Story 2 - Legacy authorship keeps working (Priority: P2)

Writes that today carry the legacy author values ("human" and "calliope") continue to validate, store, and read back unchanged. Rows already stored are untouched.

**Why this priority**: The existing write paths are live in production; a widening that breaks either legacy value or requires a data migration is a regression, not a widening.

**Independent Test**: Perform a write with each legacy value and read each back; confirm behavior is byte-identical to today. Confirm existing stored rows read back unchanged.

**Acceptance Scenarios**:

1. **Given** a legacy author value, **When** a block is written with it, **Then** the write validates and stores exactly as before.
2. **Given** rows stored before this change, **When** they are read, **Then** their author values are returned unchanged with no migration.
3. **Given** a write that supplies no author, **When** it lands, **Then** the default behavior is identical to today's.

---

### User Story 3 - Revision history answers "who wrote this revision" (Priority: P3)

An auditor reading a block's revision history sees the author of each revision, including session principals, so a drift observation can be traced to the session that made the change.

**Why this priority**: Attribution at write time is only useful if the read surface exposes it; revision history is the read surface an audit uses.

**Independent Test**: Write revisions of one block under a session principal and a legacy value; read the revision history and confirm each revision reports its own author.

**Acceptance Scenarios**:

1. **Given** a block with revisions by different authors, **When** revision history is read, **Then** each revision carries the author that wrote it.

---

### Edge Cases

- What happens when an author value is neither a legacy literal nor a well-formed session principal? The write is rejected with a clear validation error naming the accepted forms (see FR-005).
- What happens when a session principal is well-formed but refers to a session that no longer exists? The write stores it; provenance is a citation, and resolution is a read-time concern outside this feature.
- Existing rows whose author is a legacy literal are readable alongside new principal-authored rows in the same history without special-casing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A block write MUST accept a session principal as its author value.
- **FR-002**: The legacy author values "human" and "calliope" MUST continue to validate on write, exactly as today.
- **FR-003**: A write that supplies no author MUST behave identically to today's default.
- **FR-004**: Provenance reads — including per-revision history — MUST return the stored author value verbatim, whether legacy or principal.
- **FR-005**: An author value that is neither a legacy literal nor a well-formed session principal MUST be rejected at the write boundary with an error naming the accepted forms.
- **FR-006**: Rows stored before this change MUST remain valid and readable with no migration.

### Key Entities

- **Author value**: the provenance identity stored with each block revision — either a legacy literal ("human", "calliope") or a session principal.
- **Session principal**: the fleet-standard session identity string (`spiffe://{trust-domain}/session/{uuid}`), minted per session, resolvable to that session's history by services that already exist.
- **Block revision**: an immutable stored version of a block; each revision carries exactly one author value.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of block writes that supply a session principal can be attributed to that exact session on read-back.
- **SC-002**: Zero regressions on legacy-value writes: both literals validate and read back exactly as before the change.
- **SC-003**: Zero data migration: every row stored before the change reads back unchanged.
- **SC-004**: Revision history reports a per-revision author for every revision written after the change.

## Assumptions

- The principal is supplied by the write path's caller; this feature validates its **form**, not its **authenticity**. Cryptographic verification of the principal (fleet session-token verification) is an explicitly surfaced open item for planning, not silently assumed either way.
- The storage column is already wide enough for principal strings; this is a validation-layer widening, not a storage change.
- Whether the legacy "calliope" literal should eventually become a workload principal is out of scope; both legacy literals remain first-class.
- Downstream features (offset stamping, comments, replay) consume this widening but are separate features.
