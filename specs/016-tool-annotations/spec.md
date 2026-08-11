# Feature Specification: ToolAnnotations on every Calliope verb

**Status**: Draft | **Input**: Master-plan F10 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The wire finally carries curation content (Priority: P1)

`ToolAnnotations` exists in the SDK, Nyx's prober reads it, Argus has types
and a fixture — and zero stars emit it. Calliope pilots the fill: every verb
carries a `title` and honest `readOnlyHint` / `destructiveHint` /
`idempotentHint` values, so Argus can stop rendering a break-glass verb
identically to a read, and Nyx's prober reads real content off `tools/list`.

**Independent Test**: `tools/list` returns annotations for EVERY tool;
`write_body` reads as destructive, `read_body` as read-only.

**Acceptance Scenarios**:

1. **Given** a `tools/list` dial of Calliope, **When** annotations are read,
   **Then** every verb carries a title and an honest read/destructive hint.
2. **Given** the destructive set, **Then** it is exactly: `write_body` (the
   coarse whole-body replace), `delete_block`, `apply_section_ops` (carries
   deletes), and `coalesce_block_writes` (physical history deletion).

## Requirements *(mandatory)*

- **FR-001**: every registered verb MUST carry `annotations` with
  `readOnlyHint`, `destructiveHint` and `idempotentHint` set honestly.
- **FR-002**: the full annotation map MUST be pinned by an executable test
  (the B7 fence) — a new verb without annotations fails the suite.
- **FR-003**: the surface is annotated AS IT EXISTS (25 verbs — the plan's
  "fifteen" predates F3/F5/F8/F9; measured divergence, strictly better for
  B7).

## Success Criteria *(mandatory)*

- **SC-001**: wire-level: all 25 tools carry annotations; the read set and
  destructive set match the pinned map exactly.
- **SC-002**: `write_body` destructive + non-idempotent; `read_body`
  read-only; `dissolve_note`/`write_document`/`update_block`/`edit_section`
  idempotent (their no-op convergence is tested elsewhere).

## Assumptions

- `write_body` is `destructiveHint: true` (the Tail's open lean): it
  replaces every block id in one stroke — id destruction IS the destruction
  that matters to anchors, even though prose history survives. [Default]
- Hints ride the protocol; RULES live in Ouranos (carried from the Argus
  amendment) — no policy ships here. [Carried]
