---
title: "The Container Read and History"
spec: "./spec.md"
constitution: "(main checkout) .specify/memory/constitution.md"
status: ready
---

# The Container Read and History — Design Plan

> **Binding contract.** decided or [OPEN]. Reconciles master-plan F5 ([MP]).

## Summary

`container-read.ts` assembles the two-store read: tree resolution (current
via `materialize_edges`; as-of via `quads_from(as_of_tx)` + `resolve_scalars`
for positions) plus ONE batched blob fetch (`getTexts`, `WHERE id = ANY` —
the [MP] recommendation, decided). History is the chaos `history` verb
(landed 887de87). Two new MCP verbs: `read_container`, `container_history`.
The fixture dial grows a transaction log so the offline model answers the
same questions as the door. The [MP]-required latency measurement records
into the spec dir.

## Architecture

- `apps/calliope/src/blob-store.ts` — `ProseStore.getTexts(ids) →
  Map<id, text>` (batched; pg: one `ANY($1)` query; fixture: map walk).
- `apps/calliope/src/chaos-client.ts` — dial gains `quadsFrom(subjects,
  asOfTx, predicateNames, graph?)` (names hashed door-side convention:
  sha256(name), the existing scopeHash), `resolveScalars(hashes)`,
  `history(subjects, follow, graph?)`. Fixture: per-admit tx counter + edge
  log; `edges()` unchanged (current); quadsFrom replays the log ≤ asOf;
  history computes the closure from the log (authors: the fixture's fixed
  author label — the door's authors are themis-resolved and tested in the
  chaos conformance suite, not here).
- `apps/calliope/src/container-read.ts` — **new**: `readContainer(facet,
  container, {asOfTx?})` → `{blocks: [{slot, position, blobId, text,
  dangling}], asOfTx?}`; `containerHistory(facet, container)` →
  `{transactions}`. Facet: the F4 `ContainerFacet` (blobs + dial).
- `apps/calliope/src/mcp/server.ts` — registers both verbs beside
  `write_container` (same facet presence rule).
- `apps/calliope/__tests__/container-read.test.ts` — SC-001..003.
- `apps/calliope/__tests__/blob-store.test.ts` — the SC-004 measurement
  (50-block batched fetch timing, real postgres), recorded to
  `specs/042-container-read/measurement.md`.

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:read_container` | `{container: hex64, as_of_tx?: int, tenant?} -> {blocks: [{slot, position, blobId, text: string\|null, dangling: bool}], as_of_tx?}` | decided |
| `mcp_tool:calliope:container_history` | `{container: hex64, tenant?} -> {transactions: [{tx, at, author, note}], count}` | decided |
| `module:container-read` | `readContainer` / `containerHistory` over ContainerFacet | decided |
| `ProseStore.getTexts` | `(ids: string[]) -> Map<string, string>` — absent ids simply missing from the map | decided |

### Consumes / Requires

| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| chaos `history` | `{subjects, follow, graph?} -> {transactions:[{tx,at,author,note}]}` | chaos@887de87 |
| chaos `quads_from` | `{subjects, as_of_tx, predicates(name-hashes), graph?} -> [[s,p,o,g] hex; blob o = "blob:<id>"; scalar o = content-hash]` | live |
| chaos `resolve_scalars` | `{hashes} -> {hash: value}` | live |
| F3 vocabulary + F4 facet | tree predicates; ContainerFacet | landed |

### Resource-Reach (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:apps/calliope/src/mcp/server.ts` [MP] | write | verb registration |
| `file:apps/calliope/src/{blob-store,chaos-client}.ts` | write | getTexts · dial reads · fixture log |
| `file:apps/calliope/src/container-read.ts` | create | the read assembly |
| `repo:chaos gostore` [RR addition, surfaced like themis's] | landed 887de87 | the history verb |

[MP names `mcp/tools.ts`; same divergence as F4 — new-model code stays out
of the legacy family's home.]

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| History is a graph read at as_of_tx | listing = `history` verb; reconstruction = `quads_from(as_of_tx)`; NO revision verbs consulted | [MP: Claude, Rob "that's the plan"] | **Rob** [MP] | revision tables (the model this plan ends) |
| Blob fetch batches [MP gap] | yes — one `WHERE id = ANY($1)` per read | [MP recommendation]; N+1 against a 50-block container is 50 round trips for no reason | Default [MP] | per-block fetch |
| Current-read path | `materialize_edges` (2 hops), not quads+resolve | cheapest correct read at HEAD; the as-of path pays the 3-hop cost only when asked for the past | Claude | one path for both (every HEAD read pays the as-of tax) |
| As-of positions | `resolve_scalars` on the quad hashes | quads render scalars as content-hashes; values are required output | Claude | carry values in quads (changes a tape-pinned wire) |
| Ever-member closure | door-side (`history`'s follow) | the log lives there; shipping it to the client re-implements the store | Claude [chaos F5 slice] | client-side closure (N reads) |
| Fixture tx log | per-admit tx counter + edge log; replay for asOf | SC-002 must be testable offline; one model | Default (spec assumption) | live-only tests (unrunnable in CI) |
| Measurement home | test-emitted, recorded in `measurement.md` [MP: "measured and recorded"] | the number must survive the run | Claude | log-only (evaporates) |

## Dependencies

T001 (getTexts) → T002 (dial reads + fixture log) → T003 (read module) →
T004 (verbs) → T005 (suite + measurement). External: chaos@887de87 landed.

## Impact

| Slice | Impact |
| :--- | :--- |
| read module + verbs | 9 (five features + one master-plan wait on F5 [MP]) |
| fixture log | 6 |
| measurement | 6 (gates F6) |

## Open & risk

- **[OPEN — carried]** Poseidon per-graph visibility, before F6 [MP].
- **Risk:** the graph half of the read latency is chaos-side and measured
  there; SC-004 measures the blob half plus assembly. The full end-to-end
  number against live chaos lands with F6's pre-migration check. Surfaced,
  not silently narrowed.

---
DoR: decisions provenance-tagged ✓ · seams shaped ✓ · RR verified (chaos
addition surfaced; tools.ts divergence noted) ✓ · deps acyclic ✓ ·
constitution I–V checked
