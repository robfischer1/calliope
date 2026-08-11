# Feature Specification: Server-side tag hygiene and a persisted cleanup pass

**Status**: Draft | **Input**: Master-plan F11 Head

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Junk cannot enter through any write path (Priority: P1)

Hex-shaped tokens are rejected wherever a tag is written — the inline
extractor (already guarded), the explicit tag path (`create_note` tags[]),
and the reconcile chokepoint — and trailing-slash malformations normalize
clean. Filtering the view leaves garbage for the next consumer; this fixes
it at the data.

**Acceptance Scenarios**:

1. **Given** a hex-shaped token, **When** a tag is written explicitly,
   **Then** it is rejected (`bad_tags`); **and** the reconcile chokepoint
   drops it defensively on every path.
2. **Given** `#brainsoup/`, **When** normalized, **Then** it becomes
   `#brainsoup` (trailing-slash strip — a grammar fix; no dash-insertion
   guessing).

### User Story 2 - The persisted junk is gone from the store (Priority: P1)

The ETL-era junk (measured live 2026-08-10: 9 Catppuccin hex tags + 1
trailing-slash variant among 35 distinct, one carrier each) is removed from
the persisted store — mirror rows deleted AND carrier `hasTag` edges
retracted from the graph — not just hidden from the render.

**Acceptance Scenarios**:

1. **Given** the existing index, **When** the cleanup runs, **Then** junk
   tags are removed and their carrier edges retracted; trailing-slash
   variants merge into their normalized form.
2. **Given** a converged store, **When** the cleanup re-runs, **Then** zero
   changes (idempotent).

## Requirements *(mandatory)*

- **FR-001**: `normalizeTag` MUST strip trailing slashes; a shared
  `isJunkTag` MUST identify hex-color-shaped tags post-normalize.
- **FR-002**: `computeTagDelta` MUST drop junk adds (the chokepoint both
  write paths flow through); `create_note` MUST reject junk explicit tags
  as `bad_tags`.
- **FR-003**: the cleanup MUST be a gated CLI (probe / apply, the repo's
  migration-tool pattern), retracting graph edges and deleting mirror rows,
  idempotently.
- **FR-004**: the retraction is reversible at the substrate level (chaos is
  append-only; retractions are logged ops) — recorded, not built.

## Success Criteria *(mandatory)*

- **SC-001**: unit: normalize/junk/delta behaviors pinned.
- **SC-002**: wire: `create_note` with a hex tag → `bad_tags`.
- **SC-003**: live run post-merge: the 10 junk entries gone from
  `list_tags`' source and their edges retracted; re-run reports zero.

## Assumptions

- `#brainsoup/` merges to `#brainsoup` (slash strip only); whether
  `#brainsoup` should further merge into `#brain-soup` is a SEMANTIC
  rename — tag-node territory, explicitly out of this pass. [Default,
  surfaced]
