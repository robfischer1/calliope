---
title: "Blob Garbage Collection"
spec: "./spec.md"
status: ready
---

# Blob Garbage Collection — Design Plan

> Binding. Reconciles master-plan F7 ([MP]).

## Summary
The graph's census protocol with the roles swapped [MP]: chaos gains
`held_blobs(graph?)` (landed f29dc47 — reports the LOG per graph, empty =
a report); calliope gains `GcStore` (marks table + reap, pg + fixture),
`runBlobCensus` (snapshot → roster reports → mark-and-sweep), and the
`blob_census` verb (execute explicit, destructiveHint).

## Decisions (provenance-tagged)
| Decision | Resolution | Prov |
| :--- | :--- | :--- |
| Roster [MP gap: "a roster of one weakens the quorum"] | the TENANT GRAPHS, each reporting separately; any miss aborts | Default |
| Retention [MP gap: immediate vs grace] | mark-and-sweep across two complete censuses — structural grace window, no timestamps on blobs (F1 forbids) | Default |
| Held = log, not current | as-of reads (F5) resolve historical blobs forever | Claude |
| Reap surface | `GcStore`, NOT ProseStore — the F1 surface pin holds | Claude |
| Dangling | reported, never fixed [MP] | [MP] |
| Chaos verb | `held_blobs` — RR addition surfaced (same shape as history/themis) | Claude |

## RR (VERIFIED)
`src/blob-census.ts` (new) · `src/blob-store.ts` (GcStore/PgBlobGc/
FixtureBlobGc + fixture helpers) · `src/pg-client.ts` (blob_gc_marks DDL)
· `src/chaos-client.ts` (dial heldBlobs + failure knob) ·
`src/container-write.ts` (facet gains gc) · `src/mcp/{backend,server}.ts`
(wiring + verb) · `repo:chaos` (held_blobs @ f29dc47, read of the census
pattern :503-553 [MP]).

## Open & risk
- Full-enumeration held lists: ~fine to ~10^6 ids; beyond that the verb
  grows a candidate-set parameter (noted, not built).
- The live reap is ops-gated like F6's run: execute=true is explicit and
  destructive-hinted; nothing runs it automatically.
