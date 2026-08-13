# Feature Specification: Compound Copy-Reference

**Status**: Draft | **Input**: Master-plan feature node F1 — "Look At This — The Attention Pointer"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. A reasonable default is allowed but must be logged in
> Assumptions as a Default-provenance decision, not left implicit. The WHAT lives
> here; the HOW (architecture, contracts) lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Copy a reference another party can resolve (Priority: P1)

Rob has a note open (or selected in a list) and wants to name it to an AI session.
Today he cannot: nothing in the system hands him an address. One action copies a
**compound reference** — a human-readable wikilink plus the resolvable identifier,
e.g. `[[F9 Archaeology Queue — Classification & Review]] (019f8186cb)`. He pastes
it into a conversation; the human half tells him and any reader *which* note it is,
and the identifier half lets a session resolve it to the exact note without
guessing by title.

**Why this priority**: This is the address the whole pointer plan builds on, and it
must exist before the folder-path workaround is removed (the title fix makes
path-baked titles go away — see Sequencing).

**Independent Test**: Invoke copy-reference on a known note; paste the clipboard
contents; hand the identifier half to the resolve path and confirm it returns that
exact note.

**Acceptance Scenarios**:
1. **Given** a note on the Calliope backend, **When** copy-reference runs, **Then** the clipboard carries a wikilink plus a node id.
2. **Given** the filesystem backend is mounted, **When** copy-reference runs, **Then** the clipboard carries a wikilink plus a path form.
3. **Given** a pasted compound reference, **When** a session reads it, **Then** it resolves the identifier half to the note it names.
4. **Given** a note whose stored title is its real title (no folder path), **When** copy-reference runs, **Then** the human-readable half is that real title, not a path.

### Edge Cases
- A note whose title contains characters that are meaningful in wikilink syntax (`[[`, `]]`, `|`) — the human half must not produce a broken link form.
- A compound reference pasted after the note was renamed — the identifier half must still resolve; the human half is honestly stale.
- An identifier that resolves to nothing (deleted note, wrong backend) — resolution reports failure rather than guessing by title.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: The system MUST provide a single action that places a compound reference — human-readable wikilink + resolvable identifier — on the clipboard.
- **FR-002**: The identifier half MUST be resolvable back to the exact note it was copied from.
- **FR-003**: The address form MUST be determined by the mounted backend: a node id where the backend has node identity, a path where the backend is path-addressed.
- **FR-004**: The human-readable half MUST be the note's real title, never a storage path.
- **FR-005**: A session (an external reader of the pasted text) MUST be able to resolve the identifier half through the system's existing read surface.

### Key Entities
- **Compound reference**: the pair (human-readable wikilink, resolvable identifier). The wikilink is for human recognition; the identifier is the address of record.
- **Address form**: backend-determined — node identity on Calliope, path on the filesystem backend. The pair's second half varies; its meaning ("resolves to this note") does not.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: One action copies the compound form — no manual title transcription, no second step.
- **SC-002**: A session resolves the identifier half to the source note with zero title-based guessing.
- **SC-003**: The backend determines the address form; the same gesture works on both backends.
- **SC-004**: The human half is the note's real title in 100% of copies.

## Sequencing constraint *(binding)*
This feature MUST land **before or with** the folders→lenses title fix (master-plan
F9). That fix removes the accidental uniqueness of path-baked titles — Rob's only
current workaround for naming a note. Landing this after it would leave a window
with no working address at all.

## Assumptions
- The action surfaces wherever the note is already in hand (editor, list row); the exact affordance placement (context menu, palette, or both) is a plan-time decision — logged in the master-plan as a surfaced gap, carried to plan.md.
- Whether the identifier is the full id or a short unique prefix is a plan-time decision — carried to plan.md as an open item from the master-plan.
