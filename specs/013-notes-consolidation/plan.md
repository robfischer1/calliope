---
title: "Consolidate the documents and notes stores"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Consolidate the documents and notes stores — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F6 Tail): consolidate [Rob asked,
> Claude found no blocker, TURN 220]; provenance as attributes, not a second
> table [Claude, R061]; consumes F3; gates F7; feeds B6's notes-indexing
> (provenance-as-attributes is the contract B6 reads).

## Reconcile evidence — the F6 pre-gate (measured live, 2026-08-10)

| Claim | Measurement |
| :--- | :--- |
| Corpus size | `documents`: **2,486 rows / 444 distinct source_paths / 61 MB** |
| Live traffic | newest row **2026-07-19** — the table is a frozen corpus |
| Provenance mix | 2,484 `phdb-migration` · 1 `master-plan` · 1 `carve-synthesis` |
| The "~36k" figure | Eros ingest CHUNKS, not documents rows — plan divergence, surfaced |
| Graph-volume gate | ~444 mints + ~3k edges against a 1.27M-row chaos store: **passes** |

## Summary

Three deliverables: (1) `notes-sink.ts` — the note-native write: mint/reuse a
note keyed by source_path, land the body as a one-block CoW container,
reconcile provenance attributes + inline tags; (2) `migrate-notes.ts` — the
gated, idempotent migration over the frozen corpus (probe / migrate + parity,
the migrate.ts pattern); (3) the `write_document` strangler bridge:
dual-write table + note until F7 cuts reads over and drops the table. Reads
are deliberately untouched — one read-truth (the table) until F7, so the
bridge window cannot serve torn data.

## Architecture

- `apps/calliope/src/notes-sink.ts` (new) — `sinkNoteVersion(client, dial,
  scope, tagStore, input)`: createNote(title=source_path) reuse-first → body
  no-op-or-save → attr reconcile (diff current edges, opRemove/opAdd) → tag
  reconcile (`maybeReconcileInlineTags`).
- `apps/calliope/src/mcp/migrate-notes.ts` (new) — CLI: `--probe` (counts) /
  default (migrate versions ASC per path + byte parity + idempotence);
  DATABASE_URL + CHAOS_URL, the migrate.ts env contract.
- `apps/calliope/src/document-store.ts` — `listSourcePaths()` on the store
  seam (pg + fixture) for the enumeration.
- `apps/calliope/src/mcp/server.ts` — `write_document` bridge: after
  `documents.write`, when the chaos facet + tag store are wired, run the
  sink; a sink failure FAILS the verb (both halves idempotent → retry
  converges).
- Tests: `__tests__/notes-sink.test.ts` (new, fixture dials),
  `__tests__/migrate-notes.test.ts` (new, fixture corpus),
  `__tests__/mcp-documents.test.ts` (bridge behavior at the wire).

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `function:notes-sink:sinkNoteVersion` | `(client, dial, scope, tagStore?, input: WriteDocumentInput) -> {node_id, created, generation: "minted"\|"superseded"\|"nooped"}` | decided |
| provenance attributes (the B6 contract) | note edges: `source_path`, `raw_hash`, `source_kind`, `mtime`, `ctime`, `title`, `schema_type`, `file_path`, `dissolved_at` — literals, absent when NULL | decided |
| `function:document-store:listSourcePaths` | `() -> Promise<string[]>` distinct, ordered | decided |
| `cli:migrate-notes` | `--probe` JSON counts · default migrate + parity, exit nonzero on mismatch | decided |
| `mcp_tool:calliope:write_document` | wire shape unchanged; bridge dual-write when graph facet present | decided |

### Consumes / Requires

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| `createNote` (C8) | reuse-first mint keyed (Note, name); heal-on-reuse | tools.ts live |
| F3/F4 body store | saveBody generations; identical-text no-op (F4) at edit grain — container grain no-op decided here | main 5af1b4a |
| `maybeReconcileInlineTags` (C9) | kind-gated inline extraction | tools.ts live |
| chaos dial | `edges`, `admit(opAdd/opRemove)`, `findByName` | chaos-client.ts live |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:src/notes-sink.ts` | create | the sink |
| `file:src/mcp/migrate-notes.ts` | create | the migration |
| `file:src/document-store.ts` | write | `listSourcePaths` |
| `file:src/mcp/server.ts:write_document` | write | the bridge |
| `file:src/mcp/tools.ts` | read | createNote / tag reconcile reuse |

## Data model

The note: graph identity (name = source_path) + provenance attribute edges
(the B6 read contract, above) + a one-block sovereign-store container whose
generations are the version history. No new tables — that is the point.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Consolidate | yes | — | Rob asked · Claude found no blocker, TURN 220 | — |
| Provenance placement | attributes on the note | never a second table | Claude, R061 (constraint) | sidecar table (forbidden) |
| Note identity key | `source_path` as the graph name | unique by constraint; titles collide; the vault identity IS the path | Default (Claude, binding) | title (rejected: collisions), content hash (rejected: identity must survive edits) |
| Insert-only → CoW (Tail gap) | versions become saveBody generations in stored order | as-of reads then serve each version; one lineage model | Default (Claude) | keep versions as attrs (rejected: two models again) |
| Container-grain dedup | body identical to active → skip the save | F4's no-op is edit-grain; the sink needs container-grain | Default (Claude) | always save (rejected: history inflation on re-dissolve) |
| Bridge direction | dual-WRITE, single READ-truth (table) until F7 | a torn read surface is the "stored twice, drifting" defect; writes converge idempotently, reads stay consistent | Claude (Substrate V2 lesson) | cut reads now (rejected: that is F7, gated on this) |
| Sink failure semantics | fails the verb (after table write) | both halves idempotent; a retry converges; silent sink loss = silent drift | Default (Claude) | non-fatal log (rejected) |
| Original version stamps | not reproduced; newest `created_at` → `dissolved_at` attr | section stamps are transaction-`now()`; the table serves originals until F7 | Default (Claude); loss recorded for F7 | SQL stamp override (rejected: forges event time in the live store) |
| Live-run transport | tool runs from checkout: DATABASE_URL=aether (published), CHAOS_URL via ssh tunnel to the pantheon-net chaos | chaos:8206 is not host-published | Default (Claude) | publish the port (rejected: infra change for a one-off) |

## Dependencies

sink → migration → bridge → tests at each layer; live run post-merge. F3
(merged) satisfied. Gates F7.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| sink | 6 |
| migration | 5 |
| bridge | 4 |

## Open & risk

- Risk: attr reconcile races a concurrent write — bounded: the corpus is
  frozen and the bridge serializes per-call; accepted.
- Risk: 444 mints through the gated two-admit path take wall-clock — bounded
  and resumable (idempotent).
- `[OPEN — F7]` the fleet-wide caller sweep + table drop + read cutover;
  `read_plan`'s document-id handles keep working until then.
- `[OPEN — B6]` indexing the merged store (explicitly B6's feature).

## Constitution Check

- **I/II** all decisions provenance-tagged; both Tail gaps (versioning
  reconciliation, graph volume) resolved by measurement + logged defaults.
- **III** the sink signature, attr contract, CLI modes and bridge semantics
  are named. **IV** SC-001..004 are countable; idempotence is a
  zero-delta assertion. **V** gate + live parity output pasted.

---
DoR: [x] decisions [x] contracts [x] RR verified [x] deps [x] constitution
