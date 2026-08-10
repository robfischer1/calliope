# Feature Specification: Flip the default body backend to PgBodyClient

**Status**: Draft | **Input**: Master-plan F2 Head — "Blocks — Calliope's Block-Native Verb Surface"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. The WHAT lives here; the HOW lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The default store is the sovereign store (Priority: P1)

Calliope's prose lives in its own PostgreSQL (the sovereign store); the graph
carries metadata only. The service must treat that as the DEFAULT reality, not
an opt-in: a plainly-configured boot runs against the sovereign store, and the
graph-substrate backend survives only as an explicit, named choice.

**Why this priority**: every write that lands in the wrong store re-creates
the two-stores-drifting failure class this whole plan exists to kill.

**Independent Test**: backend selection with an empty environment resolves to
the sovereign store; the graph backend is selectable only by explicit request.

**Acceptance Scenarios**:

1. **Given** no backend-related environment, **When** the backend is selected,
   **Then** the sovereign store (`pg`) is chosen.
2. **Given** an explicit request for the graph backend (`urania`) or gateway
   backend (`hades`), **Then** that choice is honored unchanged.
3. **Given** the gateway auto-select flags (`CALLIOPE_WRITE_VIA_HADES` /
   `CHARON_URL`), **Then** `hades` is still auto-selected as today.

### User Story 2 - A missing database secret fails the boot loudly (Priority: P1)

The live service receives its database URL as an injected secret. If injection
fails, the service must refuse to boot — not silently fall back to writing
prose into the graph substrate (the pre-cutover store), and not silently
connect to a default local database.

**Why this priority**: a silent fallback after the cutover re-opens the graph
prose store that the migration explicitly emptied; the drift would be
invisible until read-time.

**Independent Test**: constructing the pg backend with no database URL throws
with a message naming the missing variable; nothing is written anywhere.

**Acceptance Scenarios**:

1. **Given** the pg backend selected and no `DATABASE_URL`, **When** the
   client is constructed, **Then** it throws immediately with a message naming
   `DATABASE_URL`, and no fallback backend is selected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Backend selection MUST default to `pg` when no explicit backend
  and no gateway auto-select flag is present.
- **FR-002**: `urania` MUST remain selectable, but only via the explicit
  `CALLIOPE_MCP_BACKEND=urania`.
- **FR-003**: The `pg` path MUST fail fast (throw at construction) when
  `DATABASE_URL` is absent or empty.
- **FR-004**: Existing explicit selections (`fixture`, `hades`, `urania`,
  `pg`) and the hades auto-select flags MUST behave exactly as today.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `backendKind({})` resolves to `pg`.
- **SC-002**: The pg construction path with empty env throws naming
  `DATABASE_URL`; the message points at the sovereign-store cutover.
- **SC-003**: The full existing selection matrix (explicit choices, hades
  auto-select, DATABASE_URL auto-select) passes unchanged.

## Assumptions

- The live migration state was MEASURED before this spec (2026-08-10, this
  session): production `bun server.js` carries an injected `DATABASE_URL`
  and runs the pg backend today; the sovereign store holds 11,709 section
  rows across 4,665 nodes; the oldest and heaviest migrated body owners
  carry zero `hasPart`/`text` triples in the `moirae` graph (metadata edges
  only). The C2 migration AND its retraction have both run live. This
  feature therefore ships the default flip + fail-fast only; the migration
  tool (`src/mcp/migrate.ts`, with parity gate and gated `--retract`)
  already exists and has done its work. [Measured, not inferred]
- The master-plan F2 Brief's "makeBodyClient defaults to UraniaBodyClient"
  describes the bare-env fallback only; the `DATABASE_URL` auto-select (C2)
  already prefers pg. Divergence surfaced per the reconcile rule, resolved
  by measurement above. [Documented divergence, not silently reconciled]
