---
title: "Local version history — the .grace/ revlog"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# The .grace/ revlog — Design Plan

> **Planning context consumed** (master-plan F13 Tail + Rob's decision
> 2026-08-10): Calliope-side revlog under `.grace/` — the drawer works
> unmodified and non-vault directories are covered (the two grounds Fable's
> recommendation named, both verified still true); fs GRAIN unchanged
> (history only).

## Summary

`src/fs-revlog.ts`: per-node JSONL snapshots (`{revision, kind, text}`)
under `.grace/revlog/`, head-deduped, monotonic stamps, capped at 200.
`FsBodyClient` appends on save/edit, lazily captures external states on
history reads, and implements the two optional revision methods with the
exact `derive` reconstruction shape. Zero sidecar/server changes — the
existing dispatch guards light up.

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| Store | `.grace/` revlog, not git | **Rob, 2026-08-10** |
| Snapshot model | full text per entry (CoW at file grain — the fs store's one-block grain makes deltas pointless) | Default (Claude) |
| External edits | lazy capture at history-read time (no watcher) | Default (Claude) — observed states become recoverable; a watcher is B1-adjacent |
| Bound | per-node cap 200, oldest dropped | Default (Claude) |
| Prunable | cap + documented `.grace/` deletability (history-only loss) | Default (Claude) |
| Revlog survives a directory move? (Tail gap) | yes — it rides inside the root | measured by construction |

## Open & risk

- Risk: two writers on one file race the revlog file — writes serialize
  through the client's per-path lock; an external writer bypasses it and
  is captured lazily. Accepted (same trust model as the body itself).

## Constitution Check

**I/II** Rob's decision binding; defaults logged. **III** the entry shape +
file layout named. **IV** SC-001..003 executable. **V** gate + suite.

---
DoR: [x] all
