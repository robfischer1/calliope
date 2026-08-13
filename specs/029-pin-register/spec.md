# Feature Specification: The Pin Store (calliope half)

**Status**: Draft | **Input**: Master-plan feature node F6 — "Look At This — The Attention Pointer"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Three pins, all resolve (Priority: P1)

Rob pins three passages (theia 060 emits `pointer-pin` events on the existing
pipe) and says "compare these." The session calls the pointer verb and gets
live focus AND every pin, each with its own drift verdict. Pins persist past
moving on (live focus changes; pins do not), stack in arrival order, and are
individually clearable — "clear the second pin" is a session-side verb call,
because a pin is auditable intent a session may retire conversationally.

**Acceptance Scenarios**:
1. **Given** three pointer-pin events arrived, **When** look is called, **Then** all three resolve (pointer + per-pin drift), in arrival order.
2. **Given** live focus changed after pinning, **Then** the pins are unchanged.
3. **Given** unpin(pinId), **Then** that pin alone is removed; unknown pinId answers a structured miss; re-unpin is a no-op success.
4. **Given** a duplicate pointer-pin event (at-least-once wire), **Then** the pin exists once (dedupe on pinId).
5. **Given** reads of any number, **Then** the pin store is unchanged.

## Requirements *(mandatory)*
- **FR-001**: The register MUST grow a pin store: append on `pointer-pin` (dedupe by pinId), remove on `unpin`, ordered by arrival.
- **FR-002**: The consumer MUST fold `pointer-pin` events exactly as it folds selection events (guard-checked, tolerant).
- **FR-003**: `look` MUST return `pins: [{pin_id, pointer, received_at, drift, current_text?}]` beside `focus` — same drift semantics per pin.
- **FR-004**: An `unpin(pin_id)` verb MUST remove one pin; unknown id → structured `{error: "unknown_pin"}`; removal is idempotent from the caller's view (a second call on a gone id is the miss, not a crash).
- **FR-005**: Reading MUST NOT mutate either store.

## Success Criteria *(mandatory)*
- **SC-001**: Pin three → look answers three, each honestly drifted-or-not.
- **SC-002**: Live focus and pins are independent grains of one register.

## Assumptions
- Pin lifetime = register lifetime (process memory, like live focus) — durable persistence is a surfaced open, not smuggled in; the pin's reference FORM (node+section) is durable data by construction (Default, binding).
- No cap on the pin count — Rob's pin rate is human-scale (Default, binding).
