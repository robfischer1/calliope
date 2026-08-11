---
title: "Coalesce block writes per writing arc"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Coalesce block writes per writing arc — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F8 Tail): coalesce per arc
> [Claude, R057]; the arc signal can be a verb argument, so no code
> dependency on Aglaia telemetry; consumes F3; alternatives named-and-not-
> chosen (live with it / let Lethe reap) stay rejected.

## Summary

One store op + one gated verb. `PgBodyClient.coalesceArc(nodeId, blockId,
sinceRevision)` walks the single-link supersession chain backward from the
active row `blockId` while rows are newer than `sinceRevision`, stops at
structural boundaries, deletes the intermediates (rows + join-table edges),
and rewires the final row's lineage (column + edge) to the pre-arc
predecessor. The verb `coalesce_block_writes` exposes it behind
`CALLIOPE_COALESCE_ARCS=1` — off by default until verified (master-plan
Success clause).

## Architecture

- `apps/calliope/src/pg-client.ts` — `coalesceArc` (one transaction).
- `apps/calliope/src/mcp/server.ts` — the gated verb registration; surface
  fence grows to 23.
- Tests: `__tests__/pg-client.test.ts` (chain walk, boundaries, deltas,
  reconstruction), `__tests__/mcp-http.test.ts` (fence + the disabled
  refusal at wire level).

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `function:pg-client:coalesceArc` | `(nodeId, blockId, sinceRevision) -> {removed: number, from: id, to: id}` — `to` = pre-arc predecessor (`""` when the chain begins at a generation row) | decided |
| `mcp_tool:calliope:coalesce_block_writes` | `(container_id, block_id, since_revision) -> {removed, from, to}` · disabled ⇒ structured `coalesce_disabled` refusal | decided |
| `env:CALLIOPE_COALESCE_ARCS` | `"1"` enables; anything else refuses | decided |

### Consumes / Requires

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| F1 `supersessions` | edges are the authoritative lineage; `readRevisionAt` consults them | main 42518d1 |
| F3 split/merge lineage shapes | multi-edge nodes ARE the structural boundary detector | main 42518d1 |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:src/pg-client.ts` | write | the op |
| `file:src/mcp/server.ts` | write | the gated verb |
| (Tail also allows both) | — | matches |

## Data model

No schema change. The op DELETES rows — the first deliberate deletion in an
append-only store, which is exactly why it is flag-gated and boundary-guarded.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Coalesce per arc | yes | R057 | Claude (master-plan) | live with growth / Lethe reap (named, rejected there) |
| Arc signal source (Tail gap) | verb argument (block id + since_revision) | the editor owns arc detection; the seam stays dependency-free | Claude (Tail states it) | server-side inference (rejected: guessing session boundaries server-side) |
| Collapse semantics | delete intermediates; rewire final→pre-arc in column AND join table | the growth bound must be physical; lineage must stay resolvable both directions | Default (Claude) | soft-hide rows (rejected: no bound) |
| Boundary rule | stop at ≠1-predecessor rows, >1-successor predecessors, tombstones; never touch active rows | split/merge lineage carries anchor identity | Default (Claude) | collapse through (rejected: orphans anchors) |
| Default state | OFF (`CALLIOPE_COALESCE_ARCS=1` to enable) | master-plan Success: "off by default until verified" | master-plan (decided) | — |
| B4 comment on a collapsed intermediate | surfaced, not resolved | B4 does not exist; endpoints survive for forward anchoring | carried gap | — |

## Dependencies

Store op → verb → tests. F3 merged (satisfied).

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| store op (deletion!) | 7 |
| gated verb | 2 |

## Open & risk

- Risk: deleting a row some OTHER lineage references. Guard: the walk only
  removes rows whose sole successor is the next chain link (verified
  in-transaction); anything with fan-in/fan-out is a boundary.
- Risk: `readRevisions` shows collapsed events... correctly — they no longer
  exist. Pinned by test so the surface is stable.
- `[OPEN — B4]` collapsed-intermediate anchor presentation.

## Constitution Check

- **I/II** decided-with-provenance; the one Tail gap carried explicitly.
- **III** op, verb, env contract named. **IV** SC-001..004 countable;
  deletion deltas asserted exactly. **V** real-postgres suite + gate.

---
DoR: [x] decisions [x] contracts [x] RR verified [x] deps [x] constitution
