# Feature Specification: One stream or two, decided rather than inherited

**Status**: Draft | **Input**: Stream of Consciousness — Prose Arrives With Its Metadata — Master-plan, F2 Head

## User Scenarios & Testing *(mandatory)*
### User Story 1 - The decision is made on evidence (Priority: P1)
Whether `calliope-notes` becomes a `consciousness` producer or stays its own stream is decided by measuring its consumers and its state, and the decision is executed.
**Acceptance Scenarios**:
1. **Given** the census, **When** the fold is chosen, **Then** Calliope publishes `ConsciousnessEvent`s on `consciousness` and the private contract is retired.
2. **Given** existing `calliope_notes` rows in the index, **Then** the new events carry the SAME row identity, so the upsert continues the row rather than duplicating it.
3. **Given** the consumer-side extractor, **Then** it is retired in eros after this producer is deployed.
### User Story 2 - Not publishing is visible (Priority: P1)
The heartbeat says whether a producer exists and counts publishes and failures; a refusal never fails a write.
## Requirements
- **FR-001**: `source_id == record_source_id(styx://<node>)` — eros's derivation, pinned by vectors.
- **FR-002**: key `calliope_notes:<source_id>`; value JSON with the id as an integer literal.
- **FR-003**: the emit is on when `KAFKA_BOOTSTRAP` is set; `CALLIOPE_CONSCIOUSNESS_EMIT=0` turns it off loudly.
- **FR-004**: `calliope-notes` emit code and its env gate are removed.
## Success Criteria
- **SC-001**: the census is recorded (below) and the fold executed.
- **SC-002**: the eros extractor retirement is sequenced after deploy (eros follow-up).
## The census (2026-09-05, live broker)
- `rpk topic list`: no `calliope-notes` topic; thalassa's `TOPIC_SPECS` never declared it; auto-creation is off.
- `rpk group list/describe`: `eros-index-consumer` holds `consciousness`, `history-ingest`, `session-turns` — not `calliope-notes`; no other group names it.
- Fleet code naming it: eros (consumer, hydrate) and thalassa's docstring only.
- calliope's deployment (`flux/apps/star-calliope.yaml`) never set `CALLIOPE_NOTES_EMIT`.
**Decision: fold.** Nothing to drain, nobody to break.
