---
title: "update_block as the plan-edit path"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# update_block as the plan-edit path — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F4 Tail): whole blocks, touched
> only [Claude, R056]; consumes F3; B3 depends on this behavior existing. The
> Tail's one gap — "idempotency key for a re-submitted identical edit" — is
> resolved below.

## Summary

F3 shipped the `update_block` verb; F4 makes it the plan-edit path by closing
the idempotency gap and pinning the cost model. The store's single-block edit
(`editSection`, which `update_block` routes through) gains an in-transaction
identical-text no-op: same id back, zero new rows/edges/events. Tests pin
exactly-one-row, sibling reuse, and provenance.

## Architecture

- `apps/calliope/src/pg-client.ts` — `editSection`: after `FOR UPDATE`
  resolve, `target.text === text` → COMMIT and return the CURRENT section.
- `apps/calliope/src/fixture-client.ts` — `editSection`: same visible
  semantics (no event recorded, id kept).
- `apps/calliope/src/types.ts` — `editSection` contract doc gains the no-op
  clause.
- Tests: `__tests__/pg-client.test.ts` (row/edge/revision deltas over real
  postgres), `__tests__/mcp-tools.test.ts` (handler-level id stability).

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `function:BodyClient.editSection` | identical text → no-op returning the current `Section` (same id); different text → CoW as today | decided |
| `mcp_tool:calliope:update_block` | unchanged wire shape; inherits the no-op | decided |

### Consumes / Requires

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| F3 `update_block` → `editSection` routing | the verb's engine | calliope main b43f6d8 |
| F1 lineage dual-write | must NOT fire on the no-op path | calliope main a8c3ebe |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `function:src/pg-client.ts:editSection` | write | the in-tx no-op | US2 |
| `function:src/fixture-client.ts:editSection` | write | fixture twin | US2 |
| `file:src/types.ts:BodyClient.editSection` | write | contract doc | US2 |
| `file:__tests__/pg-client.test.ts` | write | delta assertions | US1 US2 |
| `file:__tests__/mcp-tools.test.ts` | write | id stability | US2 |

(The Tail names `src/mcp/server.ts`/`tools.ts` as touchable; measured against
the repo post-F3, the verb and handler already exist — the remaining diff is
store-level. Divergence noted, not silently absorbed.)

## Data model

None — behavior only.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Idempotency key (Tail gap) | byte-identical current text, compared IN the write transaction | the row already holds the answer; a client-supplied key adds wire surface for nothing | Default (Claude) | caller-supplied idempotency token (rejected: new contract, same guarantee) |
| No-op return | the CURRENT section, same id | the caller asked for this state; minting a new id for identical content is the anchor-churn this plan exists to stop | Default (Claude) | error on no-change (rejected: retries must be safe) |
| Batch path | unchanged | Tail Scope names the single-block path; the editor sends diffs | Default (Claude) | extend to apply_section_ops (deferred — no consumer) |
| Provenance | pin existing `authored_by` persistence by test | already persisted per row; F4's Success names it, so it gets a fence | Claude | — |

## Dependencies

Store no-op → tests. No cycles. F3 merged (satisfied).

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| store no-op | 3 |
| test fences | 2 |

## Open & risk

- Risk: a consumer relying on "every update mints a row" (e.g. as a touch
  heartbeat). Sweep: no caller does; the revision surface never promised
  no-op events. Accepted.

## Constitution Check

- **I/II**: the Tail gap is resolved with a logged Default; no discretion
  passes down. **III**: the changed `editSection` contract is written.
- **IV**: SC-001..003 are delta assertions — countable, not vibes.
- **V**: done = suite green with the delta tests, full gate, audit.

---
Definition of Ready:
[x] decisions resolved + provenance-tagged
[x] contracts complete  [x] RR verified  [x] deps stated  [x] constitution real
