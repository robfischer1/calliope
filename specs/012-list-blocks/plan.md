---
title: "read_plan dissolves into list_blocks and read_block"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# read_plan dissolves into list_blocks and read_block — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F5 Tail): the special case
> dissolves into the general one [Claude, TURN 257]; cross-star lockstep —
> the athena diff is sequenced INSIDE this feature; consumes F3.

## Reconcile evidence (measured against both repos)

- The Tail's RR names `repo:athena src/athena/backlog_port.py`; the measured
  consumer is `src/athena/calliope.py` (`resolve_plan` — the A8 by-reference
  seam; `backlog_port.py` carries zero `read_plan` references). The athena
  diff lands where the consumer actually lives. Divergence surfaced.
- `read_plan(handle, omit_body: true)` already computes exactly the index
  `list_blocks` must serve for document-backed plans; `read_plan(handle,
  block)` already serves one feature. The calliope diff is a verb-surface
  re-grain over existing internals plus a node-container index — not a
  parser rebuild.
- athena's whole-plan projection path legitimately consumes the full body
  (it projects the plan); F5's "no consumer loads whole plan text to get one
  feature" targets the BLOCK path only. The whole-doc read stays on the
  legacy alias, unchanged.

## Summary

Calliope: new `list_blocks` verb (both handle families, index only, `kind`
discriminated); `read_block` grows the document-handle family; `read_plan`
re-documented LEGACY, behavior frozen. Athena: `resolve_plan`'s single-block
path swaps from `read_plan(handle, block)` to `read_block(handle, block_id)`
— the consumer swap that makes the lockstep real. Landing order: calliope
first (additive), athena second (swap) — zero downtime.

## Architecture

- `apps/calliope/src/mcp/tools.ts` — `listContainerBlocks(client, id)` (the
  node-family index: first-line title, char count, order key).
- `apps/calliope/src/mcp/server.ts` — register `list_blocks`; extend
  `read_block` (document family via `readPlan` internals); LEGACY-ize
  `read_plan`'s description; surface fence → 22.
- `athena/src/athena/calliope.py` — `CalliopeDial.read_block`; Live/Null
  impls; `resolve_plan` block path swap.
- Tests: `__tests__/mcp-plan-ingest.test.ts` (HTTP, both new verbs, misses),
  `__tests__/mcp-tools.test.ts` (node-family index), `__tests__/
  mcp-http.test.ts` (fence 22); athena `tests/` (fake dial gains
  `read_block`; block-path tests re-pinned to the new verb).

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:list_blocks` | `({container_id} \| {document\|source_path}) -> {kind: "node"\|"document", handle/container echo, block_count, blocks[]}` — node entries `{id,title,chars,order_key}`, document entries `{id,title,size,order}`; NEVER body text | decided |
| `mcp_tool:calliope:read_block` (extended) | `+ {document\|source_path, block_id}` family → `{handle, block: PlanBlock}` (title/size/order/text) | decided |
| `mcp_tool:calliope:read_plan` | frozen behavior, description → LEGACY | decided |
| `python:athena.calliope.CalliopeDial.read_block` | `read_block(handle: Mapping) -> dict` | decided |

### Consumes / Requires

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| `plan-ingest.ts readPlan` | index (`omit_body`) + block slice + structured misses | calliope main f90fbce |
| F3 `read_block` node family | `{block:{id,text,orderKey}}` unchanged | calliope main f90fbce |
| athena `JsonRpcTransport` | single-POST tools/call | athena main (measured) |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:calliope apps/calliope/src/mcp/server.ts` | write | registrations |
| `file:calliope apps/calliope/src/mcp/tools.ts` | write | node-family index |
| `file:athena src/athena/calliope.py` | write | dial + swap |
| athena tests (fake dial site) | write | consumer fence |

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| read_plan fate | ALIAS kept, LEGACY-documented | gateway callers live fleet-wide (orchestrate_plan engine dials it); removal is the strangler's later sweep | Claude ("removed or aliased" — Success licenses either) | remove now (rejected: breaks live callers) |
| Whole-doc athena path | unchanged on read_plan | the projection consumes the whole plan by design | Claude | move to read_documents (rejected: loses handle echo/title for nothing) |
| Index shapes | per-family, `kind`-discriminated | a char-count is not an S/M/L size; lying with one shape breaks one family's consumers silently | Default (Claude) | unified shape (rejected) |
| Feature-id fate (Tail gap) | carried to B3, not resolved | plans stop being heading-parsed when they become real containers — B3's model | surfaced | — |
| Landing order | calliope → athena | additive first, swap second; no window where the consumer dials a missing verb | Claude (A8 pattern: consumer diff authored first, landed second) | — |

## Dependencies

calliope verbs → athena swap. No cycles.

## Impact

| Slice | Impact |
| :--- | :--- |
| calliope registrations | 4 |
| athena swap | 4 |

## Open & risk

- Risk: another fleet consumer of `read_plan`'s block path exists beyond
  athena. Sweep at F7 (the strangler's removal step); the alias keeps them
  working meanwhile.
- `[OPEN — B3]` heading-derived ids vs real block ids once plans are
  containers.

## Constitution Check

- **I/II** decided-with-provenance throughout; two divergences surfaced with
  measurements. **III** both families' shapes written. **IV** SC-001..004
  are executable fences. **V** both repos' gates run and reported.

---
DoR: [x] decisions [x] contracts [x] RR verified [x] deps [x] constitution
