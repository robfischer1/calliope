# Feature Specification: Stamp Block Writes with the Session Log Offset

**Feature Branch**: `025-kafka-offset-stamp`

**Created**: 2026-08-13

**Status**: Draft

**Input**: User description: "Stamp block writes with the session's Kafka log offset so a write records where in the session log it happened"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A session write records its exact position in the session log (Priority: P1)

When an agent session writes a block, the write records **where in the session's event log** it happened — not merely when. Session turns already carry a log position; storing that position with the write makes "the session's context at the moment of this write" an exact, replayable boundary with no clock skew and no ambiguity about a turn that landed 40 milliseconds earlier.

**Why this priority**: "Why did this change" should resolve to a precise cut of the session that made it. A timestamp is "roughly here"; a log offset is an exact replay boundary. Every future replay/audit feature consumes this stamp.

**Independent Test**: Write a block supplying a session author and a log offset; read the stored row back and confirm the exact offset is stored with it.

**Acceptance Scenarios**:

1. **Given** a session write carrying its current log offset, **When** the row lands, **Then** the row stores that offset verbatim alongside the session author.
2. **Given** a stored session write, **When** its provenance is read, **Then** author and offset together identify one exact position in one session's log.

---

### User Story 2 - A write with no session context stores nothing rather than a guess (Priority: P2)

Writes that do not come from a session — human edits, machine maintenance, legacy paths — store **no offset at all**. An absent stamp is honest; a fabricated or defaulted one poisons every replay that later trusts it.

**Why this priority**: the failure mode is silent wrong provenance. Null is recoverable; a guess is not.

**Independent Test**: Perform a write with no session context; confirm the stored row has no offset. Attempt to supply an offset without a session author; confirm the write is rejected.

**Acceptance Scenarios**:

1. **Given** a write with no session context, **When** the row lands, **Then** its offset is null.
2. **Given** an offset supplied without a session author, **When** the write is attempted, **Then** it is rejected with an error stating the offset requires a session author — nothing lands.
3. **Given** writes from before this feature, **When** read, **Then** they are unchanged and read as having no offset.

---

### Edge Cases

- A negative or non-integer offset is rejected at the write boundary — offsets are non-negative integers.
- An offset supplied with a legacy author value ("human"/"calliope") is a contract violation (scenario US2-2), not a silent null.
- Whether a stored offset resolves to a real turn is a read-side concern (the replay feature verifies at resolve time); the store records the caller's stamp verbatim.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A block write MUST be able to carry a session log offset alongside its session author.
- **FR-002**: A write that supplies no offset MUST store null — behavior otherwise identical to before this feature.
- **FR-003**: An offset without a session-principal author MUST be rejected at the write boundary; nothing is written.
- **FR-004**: A negative or non-integer offset MUST be rejected at the write boundary.
- **FR-005**: Rows stored before this feature MUST remain valid and read as offset-null, with no migration of existing data.

### Key Entities

- **Log offset**: a non-negative integer naming an exact position in the writing session's event log (the session-turns stream).
- **Write provenance**: the pair (session author, log offset) stored on a block revision — together they name "this session, at exactly this point."

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of session writes that supply an offset can be read back with that exact offset.
- **SC-002**: 100% of writes without session context store a null offset — zero fabricated stamps.
- **SC-003**: Zero changes to existing rows; pre-feature rows read as offset-null.
- **SC-004**: An invalid offset (wrong type, negative, or offset-without-session-author) never produces a stored row.

## Assumptions

- The writing session knows its own current log offset and supplies it (the same caller-supplied posture as the session author from the prior feature); a gateway-side stamp is a surfaced open alternative, not assumed.
- The session author capability (prior feature) is in place; the offset rides the same write path.
- Read-side exposure (replay, history surfaces) belongs to the replay feature, which reads the stored provenance directly.
