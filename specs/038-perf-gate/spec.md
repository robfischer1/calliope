# Feature Specification: The search performance gate

**Status**: Draft | **Input**: Findability master-plan F14 (calliope half —
the engine budget; grace half: the switcher-open budget in the shared
perf-fixtures harness).

## Requirement

- **FR-001**: Fable's stated gate — search p95 under 100 ms on a 10k-file
  fixture — asserts in the ordinary suite (the gate BLOCKS; the harness's
  generous-first posture is applied as margin, catching the 10x class).
  The fixture is deterministic (the perf-fixtures LCG + word shapes,
  mirrored pending a published fixtures package — the recorded sharing
  follow-up).
- **FR-002**: The semantic arm is absent by design in CI (no assets); the
  verb's honest FTS degradation is exactly the measured path.

## Success Criteria

- **SC-001**: The gate runs green with the measured numbers recorded in the
  CI log (first observation: p95 11.8 ms, median 9.4 ms over 10,000 files —
  ~8x inside the budget).
