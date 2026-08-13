# Feature Specification: The calliope_look Pointer Verb

**Status**: Draft | **Input**: Master-plan feature node F5 — "Look At This — The Attention Pointer"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - "Look at this part" resolves (Priority: P1)

Rob highlights a passage and says "look at this part" to whichever session he
is talking to. That session calls the pointer verb and receives the current
focus — the capture-time-resolved pointer (stable block id + offsets + the
excerpt) plus an honest drift verdict against the block's live text. N
concurrent sessions were the reason `claude://` died; here N sessions is not a
routing problem — there is one Rob and one focus, so N sessions are N readers
of one value. **A broadcast register, not a message queue.**

The register is written by the events the editor already emits (F2/F4) through
the transport that already exists (Charon → Pontus): calliope consumes the
telemetry topic and keeps the latest pointer. No new pipe.

**Acceptance Scenarios**:
1. **Given** a selection event with a resolved pointer has arrived, **When** the verb is called, **Then** it returns the pointer with its excerpt and a drift verdict.
2. **Given** no focus has ever arrived, **When** the verb is called, **Then** an empty result — not an error.
3. **Given** two pointers arrived in order, **Then** the register holds the LAST (last-write-wins).
4. **Given** the pointed-at block's text changed since capture, **Then** the verdict says drifted and carries the block's current text; **Given** the block is gone, **Then** the verdict says gone.
5. **Given** any number of reads, **Then** the register is unchanged (reading never mutates).
6. **Given** the broker is unavailable, **Then** the star serves on and the verb answers from the last known register state (degrade like the heartbeat).

## Requirements *(mandatory)*
- **FR-001**: Calliope MUST consume the existing telemetry topic and fold `selection-change` events carrying a `pointer` into a last-write-wins focus register.
- **FR-002**: A `look` verb MUST return `{focus: null}` on an empty register, else the pointer + received-at + drift verdict.
- **FR-003**: Drift MUST be computed against the live block at read time: `none` (excerpt matches at offsets), `drifted` (block resolves, the excerpt no longer appears in it — current text included; offsets are a hint, the excerpt is the witness), `gone` (block unresolvable).
- **FR-004**: Reading MUST NOT mutate the register.
- **FR-005**: Broker unavailability MUST NOT affect serving (consumer degrades gracefully, logged).
- **FR-006**: The payload type (`BodyPointer` + tolerant guard) mirrors theia's F3 type, pinned by tests on both sides.

## Success Criteria *(mandatory)*
- **SC-001**: A session resolves "look at this part" to block-grain coordinates + text with one verb call.
- **SC-002**: A stale pointer is REPORTED stale — never silently wrong text.
- **SC-003**: No new transport, endpoint, or routing machinery exists.

## Assumptions
- Register scope is process-global (one live-focus slot) — the per-window vs global question is a master-plan open; one slot is the LWW-consistent default until Rob decides (Default, binding for this feature; F6's pins carry multi-focus).
- The consumer starts at the topic's LATEST offset (a register wants now, not history) (Default, binding).
- Drift is a tri-state verdict + current text, not a diff — the "boolean or diff" master-plan gap resolved minimally; a diff can layer on the returned texts (Default, binding).
