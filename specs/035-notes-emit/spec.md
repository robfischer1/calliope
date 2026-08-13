# Feature Specification: The notes emit path

**Status**: Draft | **Input**: Findability master-plan F8 (the calliope half;
eros half: eros `specs/002-calliope-notes-source/`).

## Requirement

- **FR-001**: Every note body write on a directly-persisting backend also
  emits `(node_id, body_text, ts, schema_version)` on the `calliope-notes`
  topic, keyed by node — the keep-fresh stream eros turns into
  `calliope_notes` chunks. Best-effort on the proven IndexPusher seam: a
  projection failure never fails the body write.
- **FR-002**: Explicit opt-in (`CALLIOPE_NOTES_EMIT=1`; brokers via the
  existing `KAFKA_BOOTSTRAP` resolution) — dev sidecars and fixture backends
  never dial a broker.
- **FR-003**: With both projections configured (urania similarity + eros
  notes), pushes fan out independently — one failing never stops the other.

## Success Criteria

- **SC-001**: Unit tests: wire shape + node keying, lazy single connect,
  fan-out independence, total-failure surfaced to the swallowing decorator,
  env gating.

## Notes

The bulk seed of pre-existing notes is the eros-backfill ops job at deploy
time (recorded in the run report's operational hand-offs).
