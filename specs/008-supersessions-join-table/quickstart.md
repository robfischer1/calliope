# Quickstart — The supersessions join table

## Prerequisites

- Docker running (the pg contract suite spins up `postgres:17-alpine` itself;
  without docker the suite self-skips with a visible reason).
- `bun install` done at the repo root.

## Run the proof

```sh
cd apps/calliope
bun run test          # vitest run — includes __tests__/pg-client.test.ts
```

Full local gate (what CI runs):

```sh
bun run gate          # format:check + lint + typecheck + test + build
```

## What proves the feature (maps to spec Success Criteria)

| Criterion | Test evidence |
| :--- | :--- |
| SC-001 N-predecessor recording, both directions | `recordSupersession` with 2 predecessors; `lineageOf` from the successor lists both; `lineageOf` from each predecessor names the successor |
| SC-002 single-parent lineage reads identically | existing revision-kind tests stay green untouched; a dual-written edit's edge equals its `supersedes` value |
| SC-003 byte-identical reconstruction after backfill | build a mixed lineage (save / edit / ops incl. delete), snapshot every `readRevisionAt`, simulate a pre-F1 store (rows without join-table edges), re-run `ensureSchema` (backfill), compare snapshots exactly |
| Non-vacuity (plan Open & risk) | with the backfill statement absent, the SC-003 test MUST go red (deleted section resurrected / stale edit visible) — observed red output is required evidence in the feature report |
