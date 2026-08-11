---
title: "Archive identity amendment (F7 prelude)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Archive identity amendment — Design Plan

> Rob's decision (2026-08-10) IS the planning context: composite identity
> for non-vault rows + `isArchived` predicate. This amendment unblocks F7
> proper (read cutover + table drop), which follows as its own feature.

## Summary

`migrate-notes.ts` learns the archive identity model: rows are grouped by an
identity function (vault rows: source_path; phdb-migration rows:
`source_path :: file_path|title|hash`), each group sinks as one note with
`isArchived` + additive `document_id` attribute edges, and an unwind pass
removes the stale container-path mega-notes (sections + lineage deleted,
edges retracted). The sink gains an identity override + extra-attrs seam —
one sink core still, no fork.

## Architecture

- `src/notes-sink.ts` — `sinkNoteVersion` gains optional `identity` (graph
  name override; provenance attrs stay truthful) and optional `extraAttrs`
  (single-valued, reconciled) + `additiveAttrs` (never retracted — the
  document_id edges).
- `src/mcp/migrate-notes.ts` — identity fn + per-identity grouping (the
  convergence check moves to identity grain), `--unwind` handling folded
  into the default run (stale names computed, cleaned idempotently).
- Tests: `__tests__/notes-sink.test.ts`, `__tests__/migrate-notes.test.ts`.

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| Identity for non-vault rows | composite, with isArchived exclusion attr | **Rob, 2026-08-10** |
| Discriminator | `source_kind === "phdb-migration"` | Default (Claude) — the measured 2,484; other kinds are vault-shaped |
| Composite form | `src :: file_path \| title \| raw_hash[0..12]` | Default (Claude) |
| document_id edges | additive, one per row id, written by the migration | Default (Claude) — the F7 id-handle bridge |
| Unwind semantics | delete sections+lineage rows, retract edges; dictionary rows remain (chaos append-only) | Default (Claude) |

## Open & risk

- Risk: identity-grain convergence check must not mistake the OLD mega-note
  for the new groups — stale names are computed from the delta between old
  and new identity sets, never guessed.
- `[OPEN — F7 proper]` read cutover + table drop + alias sweep.

## Constitution Check

**I/II** Rob's decision binding; defaults logged. **III** sink seam + CLI
contract stated. **IV** SC-001..002 executable + live evidence. **V** gate
+ live re-run zero.

---
DoR: [x] all
