---
title: "CRUD_block, split and merge"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# CRUD_block, split and merge — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F3 Tail — authoritative): block is
> the primary grain [Rob, TURN 257]; merge/split are identity-preservers, not
> extra CRUD [Claude]; one block is the degenerate case [Rob]; stale ids reject
> whole with `stale_section`; the shared-data-model slice is **the block — id,
> text, order key, container, lineage** — this plan's central contract.

## Summary

Six public verbs over the existing transactional core. `create_block` /
`read_block` / `update_block` / `delete_block` are thin, position-aware
promotions of `apply_section_ops` / `edit_section` semantics; `split_block`
and `merge_block` are genuinely new store ops (`splitSection` /
`mergeSections` on the `BodyClient` seam) whose lineage rides F1's
`supersessions` join table — a split writes two edges sharing a predecessor, a
merge two edges sharing a successor. `write_body` stays functional, re-titled
LEGACY.

## Architecture

- `apps/calliope/src/types.ts` — optional `splitSection?` / `mergeSections?`
  on `BodyClient` (the existing optional-method idiom: fs never grows them).
- `apps/calliope/src/pg-client.ts` — the two new transactional ops.
- `apps/calliope/src/fixture-client.ts` — in-memory twins (dev/test parity).
- `apps/calliope/src/mcp/tools.ts` — six handlers (`createBlock`, `readBlock`,
  `updateBlock`, `deleteBlock`, `splitBlock`, `mergeBlock`).
- `apps/calliope/src/mcp/server.ts` — six registrations + `write_body`
  demotion + header doc.
- `apps/calliope/src/order-key.ts` — READ-ONLY consumer (`between`); no change.
- Tests: `__tests__/pg-client.test.ts` (store contract over real postgres),
  `__tests__/mcp-tools.test.ts` (handler layer over the fixture).

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:create_block` | `(container_id, text, after_block_id?) -> {block:{id,text,orderKey}}` — omitted position appends; key minted server-side `between(after, next)` | decided |
| `mcp_tool:calliope:read_block` | `(container_id, block_id) -> {block}` · miss = structured `block_not_found` | decided |
| `mcp_tool:calliope:update_block` | `(container_id, block_id, text) -> {block}` — one superseding row, key kept | decided |
| `mcp_tool:calliope:delete_block` | `(container_id, block_id) -> {ok, deleted:{id,orderKey}}` | decided |
| `mcp_tool:calliope:split_block` | `(container_id, block_id, offset) -> {blocks:[first,second]}` — UTF-16 offset, 0..len inclusive | decided |
| `mcp_tool:calliope:merge_block` | `(container_id, first_block_id, second_block_id, separator?) -> {block}` — adjacency required; text = first+sep+second | decided |
| `function:BodyClient.splitSection?` | `(nodeId, sectionId, offset) -> Promise<[Section, Section]>` | decided |
| `function:BodyClient.mergeSections?` | `(nodeId, firstId, secondId, separator?) -> Promise<Section>` | decided |
| `mcp_tool:calliope:write_body` | unchanged behavior; title/description → "LEGACY coarse save — prefer the block verbs" | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| F1 `supersessions` + `#writeEdge` + `recordSupersession` semantics | N-predecessor lineage; `readRevisionAt` consults the join table | calliope main a8c3ebe |
| `order-key.ts between(a, b)` | strictly-between fractional keys, byte-ordered | live |
| `apply_section_ops` transactional core | add/update/delete with stale-id whole-batch rejection | live |
| Hades gateway tool mirror | new MCP tools surface automatically (`calliope_*`) | live behavior (no diff here) |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:src/types.ts:BodyClient` | write | the two optional methods | US2 |
| `file:src/pg-client.ts` | write | `splitSection` / `mergeSections` transactions | US2 |
| `file:src/fixture-client.ts` | write | in-memory twins | US1 US2 |
| `file:src/mcp/tools.ts` | write | six handlers | US1 US2 |
| `file:src/mcp/server.ts` | write | six registrations + write_body demotion | US1 US3 |
| `file:src/order-key.ts` | read | `between` | US1 US2 |

## Data model — the block (the plan's central contract)

Block = `{ id: 64-hex placement id, text: string, orderKey: fractional key,
container: node_id, lineage: supersessions edges }`. No schema change — F1's
table carries the lineage. Event kinds on the history surface: split = one
"ops"-kind event (two rows, one tx); merge = one "edit"-kind event (one row).

**Split** (tx): lock actives; resolve target + its next active neighbour;
first child keeps the target's `order_key`, second child takes
`between(target.key, next?.key ?? null)`; deactivate target; insert both
children (`supersedes = target.id` on both rows) + two join-table edges
sharing the predecessor. Both children mint fresh ids.

**Merge** (tx): lock actives; resolve first + second; require
`first.key < second.key` AND no active row strictly between (else
`not_adjacent`); deactivate both; insert survivor (text =
`first + separator + second`, `order_key = first.key`, column `supersedes =
first.id` — the single-valued denormalization names ONE parent; the join
table names BOTH, which is exactly why F1 exists) + two edges sharing the
successor.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Primary grain | six block verbs, public | Rob's compression | Rob, TURN 257 | — |
| split/merge placement | new optional `BodyClient` methods | transactional + lineage semantics live in the store, not composable from existing ops without a race | Claude | compose in tool layer (rejected: two txs, torn lineage) |
| Both split children remint ids | yes, both supersede the original | identity flows through lineage, not through key retention; anchors resolve forward | Claude (Tail: "both record the original as predecessor") | first child keeps id (rejected: asymmetric, contradicts Tail) |
| Merge adjacency | required, checked in-tx | Tail Scope says "two adjacent blocks"; merging across a gap silently reorders prose | Claude (Tail) | allow any pair (rejected) |
| Merge text join | `first + separator + second`, separator default `""` | Backspace-at-block-start is plain concatenation; separator avoids a follow-up write when the editor wants `"\n\n"` | Default (Claude) | always bare concat (rejected: forces second write) |
| Split offset domain | UTF-16 units, `0 ≤ offset ≤ len`, boundary splits allowed | editor-native offsets; empty blocks are storable | Default (Claude) | reject boundary (rejected: caller owns caret semantics) |
| `write_body` fate | kept, re-documented LEGACY | Success clause says demoted + documented, not removed; F6/F7 own further strangling | master-plan (decided) | remove (rejected: premature — callers live) |
| create_block positioning | `after_block_id?`, omitted = append | the two real gestures (insert-after, append); server mints the key so callers never learn key grammar | Default (Claude) | caller-minted keys (rejected: that's apply_section_ops' contract, kept for the editor) |
| Order-key exhaustion (Tail gap) | non-issue by design: `between` extends key LENGTH, never exhausts; repeated same-position splits grow keys linearly | measured `order-key.ts` behavior | Claude | rebalancing pass (deferred — F8-adjacent housekeeping if ever needed) |
| ProseMirror↔block mapping (Tail gap) | frozen contract: offsets are UTF-16 into `text` | Aglaia-side concern; the wire contract is pinned here | Claude | `[OPEN]` for Aglaia only in how IT maps positions — not this repo's scope |

## Dependencies

- Store ops (pg + fixture) → handlers → registrations → tests at each layer.
  No cycles. F1 (merged) and F2 (merged) are satisfied prerequisites.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| store ops (split/merge tx) | 7 |
| handlers | 4 |
| registrations + demotion | 3 |

## Open & risk

- Risk: `readRevisions` kind labeling (split="ops", merge="edit") is an
  interpretation, not a schema change — pinned by test so B-bucket consumers
  read a stable surface.
- Risk: two same-tx events share `created_at`; split children and their
  edges must carry the same stamp so reconstruction windows stay exact —
  covered by the SC-005 matrix test.
- `[OPEN — B4's scope]` what a comment anchored to a merged-away block
  renders as; lineage resolution exists (F1), presentation is B4's.

## Constitution Check

- **I/II**: every point decided-with-provenance; the two Tail gaps are
  resolved with rationale (exhaustion: measured non-issue; mapping: contract
  frozen) rather than passed down.
- **III**: all six wire shapes + the two store-method shapes named above.
- **IV**: SC-001..005 each map to a named test; stale/adjacency rejections
  are negative-path tests, not prose.
- **V**: done = pg contract suite + fixture handler suite + full gate green,
  with the reconstruction matrix run against real postgres.

---
Definition of Ready:
[x] every decision resolved + provenance-tagged
[x] Contracts & Seams complete
[x] Resource-Reach field-level, verified
[x] dependencies stated, no cycles
[x] constitution check authored
