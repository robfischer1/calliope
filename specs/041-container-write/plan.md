---
title: "The Container Write"
spec: "./spec.md"
constitution: "(main checkout) .specify/memory/constitution.md"
status: ready
---

# The Container Write — Design Plan

> **Binding contract.** decided or [OPEN]. Reconciles master-plan F4 ([MP]).

## Summary

One module (`container-write.ts`) executes a save as blob-first two-phase:
mint every needed blob through the prose store (dedup nets no-ops out), then
compose the surviving ops into ONE admit batch of tree facts (F3 builders).
A new `containers` backend facet (prose store + chaos dial + tenant scope)
wires it; a new `write_container` MCP verb serves it. No existing verb
changes; the old write surfaces stay until F12.

## Architecture

- `apps/calliope/src/blob-store.ts` — gains `ProseStore` (the four-method
  interface `BlobStore` already implements) and `FixtureBlobStore` (in-memory
  dedup, decimal ids) so the fixture backend and the tool tests run without
  postgres — the same one-model rule the fixture body client follows.
- `apps/calliope/src/container-write.ts` — **new**: `ContainerOp` grammar
  (add/update/remove/reorder), `writeContainer(facet, container, ops)`
  implementing net-out → mint → one admit; `ContainerFacet` type.
- `apps/calliope/src/mcp/backend.ts` — `Backend.containers?: ContainerFacet`;
  pg backend: `BlobStore(pool)` + the existing `LiveChaosDial`; fixture:
  `FixtureBlobStore` + the existing `FixtureChaosDial`.
- `apps/calliope/src/mcp/server.ts` — registers `write_container` when the
  facet is present (the `create_note`/chaos-facet presence pattern).
- `apps/calliope/__tests__/container-write.test.ts` — SC-001..005.

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:write_container` | `{container: hex64, ops: ContainerOp[], tenant?: Tenant="notes"} -> {noop, applied, minted: {opIndex: slot}, blobIds: {opIndex: id}}` | decided |
| `module:writeContainer` | net-out → mint (ProseStore) → one `dial.admit(treeOps, tenantScope)`; refusal surfaces violations | decided |
| `type:ContainerOp` | `{op:"add", text, position}` · `{op:"update", slot, oldBlobId, text}` · `{op:"reorder", slot, oldPosition, position}` · `{op:"remove", slot, position, blobId}` | decided |
| `type:ContainerFacet` | `{blobs: ProseStore, dial: ChaosDial, scope(tenant): string}` | decided |

### Consumes / Requires

| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| F1 `BlobStore.mint` | idempotent, returns existing id on dup — the net-out primitive | landed d36c1af |
| F3 builders + vocabulary | slotBirthOps/repointOps/repositionOps/slotRemoveOps — ONLY these compose structure | landed 76f43a0 |
| themis admit | one batch = one chaos tx; author resolved door-side (N5) | v0.20.0 |
| chaos netting (C4a) | stale-retract nets to no-op; last write wins (the Default edge case) | live |

### Resource-Reach (VERIFIED)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/mcp/server.ts` [MP] | write | verb registration | T003 |
| `file:apps/calliope/src/mcp/backend.ts` | write | the facet | T002 |
| `file:apps/calliope/src/blob-store.ts` | write | ProseStore + fixture | T001 |
| `file:apps/calliope/src/container-write.ts` | create | the write | T002 |
| `file:apps/calliope/src/chaos-client.ts` [MP] | read | dial + builders (unchanged — F3 finished them) | — |

[MP names `mcp/tools.ts`; the handler logic lands in `container-write.ts`
instead (tools.ts is the legacy verb family's home and is on the F12 cut
path — new-model code does not move in with it). Divergence noted.]

## Data model

`blobs` (write, via mint) · tree facts in the tenant graph (write, via
admit) · one chaos transaction per non-noop save. No new tables, no new
columns. `kafka_offset` deliberately does NOT migrate (spec Assumption,
resolves the MP gap: one offset stamped every row of a batch — the tx id is
the batch identity).

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Write-ordering replaces 2PC | blob-first, then one admit; failure after mint = orphan blobs, zero tree change | [MP: Claude] discrete logical DBs; git's identical trade | Claude [MP] | 2PC (impossible), tree-first (corruption on crash) |
| Provenance rides the transaction | the admit door resolves the author (N5); no row-level author | [MP: Claude]; themis owns principal verification | Claude [MP] | wire author param (a spoofable second channel) |
| One-block degenerate case | a single `add` through the same path — no special verb | [MP: Claude] the coarse-save successor | Claude [MP] | dedicated fallback verb (two models again) |
| No-op netting before the batch | update whose mint returns `oldBlobId` drops; empty surviving set → no admit | FR-003; "re-submitting identical content writes nothing" is [MP] Success | Claude | let chaos net it (opens a tx for nothing) |
| Stale `oldBlobId` on update | retract nets out door-side; assert lands; last write wins | chaos C4a netting is exactly this contract; erroring would resurrect the stale_section retry loop F9 deletes | Default | refuse (rebuilds the churn-id pathology) |
| `kafka_offset` [MP gap] | dropped, not moved | never unique; the tx IS the batch identity | Default | column on transactions (a second copy of what tx already is) |
| Partial-failure reporting [MP gap] | admit refusal → `ChaosClientError` with the gate's violations verbatim; minted blobs reported as orphaned in the error path | the gate's violations are the truth; re-wrapping loses them | Claude | swallow + generic error (forbidden) |
| Slot labels in a batch | `b:<position>` — positions are unique within one save's adds | themis first-create-wins makes collisions silent; positions are the natural unique key | Claude | uuid labels (opaque in the admit log) |

## Dependencies

T001 (ProseStore + fixture) → T002 (write module + facet) → T003 (verb) → T004 (suite).
External: F1, F2, F3, themis v0.20.0 — all landed.

## Impact

| Slice | Impact |
| :--- | :--- |
| write module | 9 (every future prose writer [MP]) |
| facet + verb | 7 |
| suite | 6 |

## Open & risk

- **Risk (carried to F5/F6):** the write path is fixture-proven here;
  end-to-end against live chaos/themis lands with F5's measurement gate
  before F6 migrates [MP: measure in F5].
- **[OPEN — carried]** Poseidon per-graph visibility, before F6 [MP].

---
DoR: decisions provenance-tagged ✓ · seams shaped ✓ · RR verified (one
divergence noted: tools.ts → container-write.ts) ✓ · deps acyclic ✓ ·
constitution I–V checked (III both sides pinned; IV SC-001..5 falsifiable;
V suite + gate before done)
