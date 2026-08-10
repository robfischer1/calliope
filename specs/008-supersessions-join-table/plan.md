---
title: "The supersessions join table"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# The supersessions join table — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)

> **Planning context consumed** (master-plan F1 Tail — authoritative substrate,
> reconciled verbatim): Scope, seams, shared-data-model slice, Touches (RR),
> decisions-slice, gaps. Everything below that carries a provenance tag of
> Rob or a master-plan citation is decided there, not here.

## Summary

Add a `supersessions` join table to Calliope's sovereign store so one successor
block can record N predecessor blocks (merge is A+B→C), backfill it from the
existing single-parent `sections.supersedes` column, dual-write it on every
superseding write, and cut `readRevisionAt`'s supersession lookup over to it.
The column stays and continues to be written until F3 cuts over (master-plan:
decided). Two small client methods (`recordSupersession`, `lineageOf`) make the
N-predecessor capability recordable and queryable ahead of F3's merge verb.

## Architecture

All changes land in `apps/calliope/src/pg-client.ts` (the `PgBodyClient`):

- `SCHEMA_SQL` — the `supersessions` DDL + the idempotent backfill statement.
- Write paths `editSection`, `applySectionOps` (update / reorder / delete arms)
  — dual-write one edge row per superseding write, same transaction.
- Read path `readRevisionAt` — the supersession `NOT EXISTS` moves from
  `sections.supersedes` to the join table.
- Read path `readRevisions` — **verified unchanged**: its `is_save` / `is_ops`
  markers read `supersedes IS NULL` / `= ''` (generation and add markers, not
  edges); no edge consultation exists to move. SC-002 is proven by test, not
  by rewrite.
- New methods `recordSupersession` / `lineageOf` — the F3-facing seam.

Tests land in `apps/calliope/__tests__/pg-client.test.ts` (the existing
real-postgres contract suite).

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `db_table:supersessions` | `(successor_id text, predecessor_id text, node_id text, created_at timestamptz) PRIMARY KEY (node_id, successor_id, predecessor_id)` | decided |
| `function:pg-client:recordSupersession` | `recordSupersession(nodeId: string, successorId: string, predecessorIds: readonly string[]) -> Promise<void>` — one edge per predecessor, one transaction, idempotent re-apply | decided |
| `function:pg-client:lineageOf` | `lineageOf(nodeId: string, blockId: string) -> Promise<{predecessors: string[], successors: string[]}>` — both directions, point query | decided |
| `index:supersessions_predecessor` | `(node_id, predecessor_id)` — the reverse-direction lookup | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| `db_table:sections` | `supersedes text` semantics: `NULL` = generation marker (save) · `''` = add marker · `<id>` = supersedes that id; `tombstone boolean` delete markers | pg-client.ts SCHEMA_SQL (live) |
| `pg:Pool` | transactional `connect()/query()` | pg@8 |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/pg-client.ts:SCHEMA_SQL` | write | DDL + backfill | schema |
| `function:pg-client:editSection` | write | dual-write the edge | write-path |
| `function:pg-client:applySectionOps` | write | dual-write edges (update/reorder/delete arms; add writes none) | write-path |
| `function:pg-client:readRevisionAt` | write | edge lookup → join table | read-path |
| `function:pg-client:readRevisions` | read (verify only) | byte-identical check | read-path |
| `file:apps/calliope/__tests__/pg-client.test.ts` | write | contract tests | all |

## Data model

See `data-model.md`. The shared-data-model slice (master-plan): **block
lineage** — the one piece of this plan's model other buckets read.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Join table over `supersedes[]` array | join table | split's lineage queryable both ways too | Claude, master-plan Decisions-slice 2026-08-10 | `supersedes text[]` (rejected: reverse lookup needs a GIN index and unnest) |
| Table shape | `(successor_id, predecessor_id, node_id, created_at)` | carried verbatim | master-plan Brief (Rob-approved plan) | — |
| Column fate this feature | kept AND still written | "leave the column until F3 cuts over" | master-plan Brief | drop now (rejected: F3 owns the cutover) |
| Tombstone rows backfill | YES — a tombstone's `supersedes` edge backfills like any other | the tombstone edge is what makes a delete visible to as-of reconstruction; omitting it resurrects deleted sections once the read path consults the join table | Default (Claude) — resolves spec `[OPEN]` | skip tombstones (rejected: breaks SC-003) |
| Add markers (`supersedes = ''`) | produce NO edge | an add supersedes nothing; `''` is a marker, not a reference | Default (Claude) | — |
| Backfill mechanism | `INSERT … SELECT … WHERE supersedes IS NOT NULL AND supersedes <> '' ON CONFLICT DO NOTHING`, inside `ensureSchema`, same statement batch as DDL | idempotent; deploy = migrated; edge stamp = successor row's `created_at` so dual-written and backfilled edges are indistinguishable | Default (Claude) | separate migration verb (rejected: one more thing to run; store size makes a boot-time idempotent pass cheap) |
| `readRevisionAt` edge lookup | moves to the join table | Success demands byte-identical *after backfill* — a criterion that never consults the new table is vacuous; F3's merge needs reconstruction to honor N-predecessor edges without another read-path change | Claude (size basis: "two read paths") | keep reading the column (rejected: vacuous guard; F3 would re-touch) |
| `readRevisions` | untouched, verified | its markers (`IS NULL`/`= ''`) are not edges; nothing to move | Claude | rewrite against join table (rejected: is_save/is_ops underivable from edges alone) |
| New client methods | `recordSupersession` + `lineageOf` | smallest surface making SC-001 testable through the client; F3's merge consumes them | Default (Claude) | test via raw SQL (rejected: proves the table, not the capability) |
| No FK constraints | none | matches the schema's existing minimalism (sections has none); writes share the transaction that inserts the successor row | Default (Claude) | FK to sections (rejected: composite-key FK cost, no precedent in this schema) |

## Dependencies

- Write-path dual-writes depend on the DDL (schema slice).
- Read-path cutover depends on backfill (else pre-backfill history is invisible to it).
- Tests depend on all three.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| schema (DDL + backfill) | 3 |
| write-path dual-writes | 4 |
| read-path cutover (`readRevisionAt`) | 6 |
| F3-facing methods | 2 |

## Open & risk

- `[OPEN — F3's decision, surfaced not resolved]` whether `sections.supersedes`
  is dropped or kept as a denormalised fast path after F3 cuts over
  (master-plan gap, explicitly deferred there).
- Risk: a live store's `supersedes` values could reference ids absent from
  `sections` (never observed; no FK today either). Backfill copies values
  as-is — it cannot invent or lose an edge.
- Risk: `readRevisionAt` cutover changes a query consulted by the HistoryDrawer
  path; SC-003's byte-identical matrix (saves, edits, ops, deletes) is the
  guard, and it must FAIL when the backfill is removed (non-vacuity check).

## Constitution Check

- **I Spec-Is-Law**: every point above is decided-with-provenance or `[OPEN]`;
  the one spec `[OPEN]` (tombstones) is resolved here as a logged Default with
  a correctness rationale, not silently.
- **II Deferral-Terminates**: no discretion passes to the executor; defaults
  are binding.
- **III Contracts-Named**: exposed table/index/method shapes and the consumed
  `supersedes` marker semantics are written as signatures, both sides.
- **IV Conformance-Checkable**: quickstart.md names the falsifiable matrix;
  the vacuity check (backfill removed ⇒ test red) is required evidence.
- **V Verify-Before-Done**: done = the real-postgres suite green AND the
  red-without-backfill run observed and pasted into the feature report.

---
Definition of Ready (the gate — must pass, not vacuously):
[x] every decision resolved + provenance-tagged (incl. defaults)
[x] Contracts & Seams complete — every exposed surface has a shape; every consumed dep pinned with its signature
[x] Resource-Reach field-level AND verified against the real repo (no invented paths)
[x] dependencies stated, no cycles
[x] constitution check is real (authored + each principle checked) — not passed-by-vacuity
