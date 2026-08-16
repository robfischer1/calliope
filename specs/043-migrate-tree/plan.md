---
title: "Migrate Sections to Blobs and Tree"
spec: "./spec.md"
constitution: "(main checkout) .specify/memory/constitution.md"
status: ready
---

# Migrate Sections to Blobs and Tree — Design Plan

> **Binding contract.** decided or [OPEN]. Reconciles master-plan F6 ([MP]).

## Summary

A new migration entry (`src/mcp/migrate-tree.ts`, the `migrate-notes.ts`
probe-then-run precedent [MP]) replays every old-store container into the
new model: per container, oldest revision first, one graph transaction per
non-empty revision — diffed old→new via section ids and the supersessions
edges, so slot identity is CONTINUOUS across the old model's re-minted ids.
Blob-first inside each revision. Parity is per-row and two-sided (HEAD +
every revision as-of its tx); markers make it idempotent and resumable;
drift after migration refuses. `comments_on` becomes slot-to-slot facts.

## Architecture

- `apps/calliope/src/chaos-client.ts` — `AdmitResult.tx?: number` (themis
  already answers it; the fixture stamps its log's tx). The parity gate's
  revision→tx record depends on it.
- `apps/calliope/src/mcp/migrate-tree.ts` — **new**: the engine
  (`migrateTree(deps, opts)`) + the bun entry (`--probe`, `--limit`,
  `--node`). Deps: the old store (PgBodyClient + raw pool for
  enumerations) and the new stores (ProseStore + ChaosDial).
- `apps/calliope/__tests__/migrate-tree.test.ts` — the honest harness: OLD
  store = real postgres (the same testcontainer pattern), exercised through
  PgBodyClient's own write API so the lineage is true old-model lineage;
  NEW stores = fixture dial + fixture blobs. SC-001..004.

## The replay (decided, the executor follows exactly)

1. Containers = `SELECT DISTINCT node_id FROM sections`. Tenant:
   `#comments` suffix → `comments`, else `notes` [spec Default].
   Container node: a valid 64-hex id IS the node; otherwise mint kind
   `node`, label = the old id (idempotent via findByName), and assert
   `(container, migrated_container_id, <old id>)`.
2. Marker check: `(container, sections_migrated, "<n>@<latest-iso>")` in
   the tenant graph. Present & matching → skip. Present & old store now
   has MORE/newer revisions → REFUSE the container (drift). Absent →
   migrate.
3. Revisions ascending (`readRevisions`, big limit, reversed). For each:
   `readRevisionAt` → target state. Diff prev→target keyed on section id
   with the node's `supersessions` edges (successor consumes its FIRST
   predecessor's slot; other predecessors' slots remove):
   - new id, no predecessor slot → slot birth (label `m:<sectionId>`) +
     `(slot, migrated_from_section, <sectionId>)` in the same batch;
   - id continues / supersedes → repoint (text changed) and/or reposition
     (order key changed);
   - id gone, unconsumed → slot facts removed.
   Blob-first: mint all needed texts, then ONE admit. Empty diff → no
   admit; the revision maps to the previous tx.
4. Record `(revision iso, authored_by, tx)` per revision in the report.
5. Parity: HEAD (`readBody` vs assembled container read) and per-revision
   (`readRevisionAt` vs as-of read at the recorded tx) — texts AND order.
   Any mismatch → report row + nonzero exit.
6. Mark: assert the `sections_migrated` marker (its own admit).
7. `comments_on`: for each row, resolve both slots via
   `findByValue(<tenant scope>, migrated_from_section, <section id>)`;
   assert `(commentSlot, comments_on, targetSlot)` in the comments graph;
   pre-check edges for idempotency.

## Contracts & Seams

| Surface | Shape | State |
| :--- | :--- | :--- |
| `cli:migrate-tree` | `bun run src/mcp/migrate-tree.ts [--probe] [--limit N] [--node <id>]`; exit 0 = converged+parity, ≠0 names rows | decided |
| `pred:migrated_from_section` | slot → old section id (scalar) — comment resolution + audit | decided |
| `pred:migrated_container_id` | minted container → old non-token id | decided |
| `pred:sections_migrated` | container → `"<n>@<latest-iso>"` marker | decided |
| `pred:comments_on` | comment slot → target slot (node) in the comments graph | decided |
| `AdmitResult.tx` | number when the gate answered one | decided |

Consumes: F1 ProseStore · F3 builders/vocabulary · F4 blob-first discipline ·
F5 as-of read (parity) · themis admit (tx answered) · old store surfaces
`readRevisions`/`readRevisionAt`/`readBody` + raw `sections`/`supersessions`/
`comments_on` enumeration [MP shared-data-model slice, verbatim].

### Resource-Reach (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:apps/calliope/src/mcp/migrate-tree.ts` [MP: "a new migration entry, following the migrate-notes.ts / drop-documents.ts precedent"] | create | the tool |
| `file:apps/calliope/src/pg-client.ts` [MP] | read | revision readers, no diff |
| `file:apps/calliope/src/chaos-client.ts` | write | AdmitResult.tx |
| `db:sections, supersessions, comments_on` [MP] | read only — untouched (FR-007) | the source |

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Tombstoned/superseded generations [MP gap] | **Replayed, not collapsed** — versions become ordered transactions; parity checks every revision | [MP brief: "its history becomes a chain of transactions"]; collapsing forfeits the as-of criterion | Default per MP brief | collapse to HEAD (loses the success criterion) |
| Tenant graph per container [MP gap] | `#comments` → comments; else notes | documents ARE notes post-F7; the suffix is the only structural comment marker | Default | three-way split (no derivable signal for documents) |
| Parity canonical field list [MP gap] | `(text, order)` per block, per container, per revision — ids are NOT compared (the old id was the churning thing this plan removes) | ids differ by design; prose + order is what "nothing lost" means | Claude | include ids (fails by design) |
| Slot continuity across re-minted ids | supersessions edges drive it; first predecessor's slot survives a merge | the edges are the old model's own lineage record | Claude | fresh slot per generation (destroys identity-over-time) |
| Provenance facts | `migrated_from_section` on every slot; `migrated_container_id` on minted containers | comments resolution + audit after F12 drops the tables | Claude | in-memory only (breaks resumable comments) |
| Original authors/timestamps | **RESOLVED (Rob, 2026-08-16): provenance facts in the graph** — one `migration_provenance` scalar fact per replayed revision (`tx=N at=<iso> by=<author>`), riding the per-container bookkeeping admit | queryable after F12 drops the old tables, no identity-assertion door on the gate | **Rob** | report-only (leaves the graph); themis override (a spoofing door) |
| Live run | NOT executed this session — ships verified; ops act for Rob after the Poseidon check [MP: "checked before F6"] | irreversible-ish production data act; the plan itself gates it | Default (spec assumption) | run now (violates the Poseidon gate) |

## Impact

| Slice | Impact |
| :--- | :--- |
| replay engine + parity | 9 (the F12 gate [MP]) |
| comments migration | 6 |
| AdmitResult.tx | 4 |

## Open & risk

- **[OPEN → Rob]** Poseidon per-graph visibility — required before the live
  run [MP]. Listed in the completion report.
- **[OPEN → Rob]** original authorship on migrated transactions (see
  Decision Log).
- **Risk:** the old store must be frozen during the live run; the drift
  refusal catches post-marker writes but not writes DURING a container's
  replay. The live run should stop calliope's writers first (ops note in
  the report).

---
DoR: decisions provenance-tagged ✓ · seams shaped ✓ · RR verified ✓ ·
deps acyclic ✓ · constitution I–V checked (IV: SC-001..4 falsifiable; V:
real-pg old store in the suite)
