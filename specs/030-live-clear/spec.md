# Feature Specification: The Live-Clear Fold (calliope half)

**Status**: Draft | **Input**: Master-plan feature node F7 — "Look At This — The Attention Pointer"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Opting out retires the slot (Priority: P1)

Rob turns `live_focus` off (theia 061). The editor stops emitting selection
events — but the register may still HOLD the last focus from before the
opt-out, silently readable by every session. Theia emits one
`pointer-live-clear` on off-mounts; this feature folds it: the register's
ambient slot empties. Pins — deliberate intent — are untouched.

**Acceptance Scenarios**:
1. **Given** a live focus in the register, **When** `pointer-live-clear` arrives, **Then** `look` answers `{focus: null}` — and every pin still resolves.
2. **Given** an empty register, **When** the clear arrives, **Then** nothing changes (idempotent).
3. **Given** the toggle turned back on and a new selection arrives, **Then** live focus resumes normally.

## Requirements *(mandatory)*
- **FR-001**: `FocusRegister` MUST grow `clearFocus()` — empties the ambient slot only.
- **FR-002**: The consumer fold MUST handle `pointer-live-clear` (tolerantly, like every event).
- **FR-003**: Pins MUST be unaffected.

## Success Criteria *(mandatory)*
- **SC-001**: After the clear, no session can read the pre-opt-out focus; pins persist.

## Assumptions
- No verb surface changes — the clear rides the pipe like everything else (Default, binding).
