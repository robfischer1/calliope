---
title: "Dissolve and Materialize as container verbs"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Dissolve and Materialize as container verbs — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F9 Tail): Dissolve as a menu
> item retiring C6's sweep [Rob, Grace discovery brief]; tags materialise at
> Dissolve [Claude]; consumes F3 and F6's provenance-attribute contract;
> Grace mounts the menu item (B1 — not this repo).

## Reconcile evidence

- No C6 sweep code exists to delete (repo search: no bulk-dissolve
  implementation; the greps hit unrelated files). Retirement is graph-level:
  node `019f72e9…b153` ("C6 — The vault carve") closes as retired.
- F6's `notes-sink` already implements 90% of Dissolve at one-block grain;
  Dissolve generalizes the SAME machinery to a blocks[] body. One sink,
  two callers — no second path to drift.

## Summary

`dissolveContainer` joins the notes-sink module: mint/reuse by
`source_path` (the F6 identity key), land `blocks[]` as one generation
(container-grain no-op on identical), reconcile the F6 provenance
attributes, materialise inline tags. Two new gated verbs: `dissolve_note`
(the promotion) and `materialize_note` (the inverse read: blocks + tags +
provenance in one round trip). C6 closes as retired.

## Architecture

- `apps/calliope/src/notes-sink.ts` — `dissolveContainer` (generalizes
  `sinkNoteVersion`'s body step to blocks[]; shares mint/attrs/tags code).
- `apps/calliope/src/mcp/server.ts` — the two registrations (chaos-gated);
  fence → 25.
- Tests: `__tests__/notes-sink.test.ts` (container grain),
  `__tests__/mcp-documents.test.ts` or a new wire test for the round trip.

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `mcp_tool:calliope:dissolve_note` | `(source_path, blocks: [{text}], title?, source_kind?, mtime?, ctime?, raw_hash?) -> {node_id, created, generation}` | decided |
| `mcp_tool:calliope:materialize_note` | `({container_id \| source_path}) -> {container_id, blocks:[{id,text,orderKey}], tags: string[], provenance: Record}` · miss = `container_not_found` | decided |
| `function:notes-sink:dissolveContainer` | `(client, dial, scope, tagStore?, input{source_path, blocks[], …}) -> SinkResult` | decided |

### Consumes / Requires

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| F6 sink internals (mint, attrs, tags) | identity=source_path; attr contract | main 39c6cbd |
| F3 block surface | dissolved blocks readable as blocks | main 39c6cbd |
| chaos dial `edges`/`findByValue` | materialize's tag+attr read; source_path lookup | live |

### Resource-Reach — touched, field-level (VERIFIED)

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:src/notes-sink.ts` | write | dissolveContainer |
| `file:src/mcp/server.ts` | write | registrations |
| `file:src/chaos-client.ts` | read | dial surface (Tail allowed write; none needed — divergence noted) |

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Direction inversion | per-note promotion, human-chosen | — | Rob, Grace discovery brief | C6 bulk sweep (retired) |
| Identity key | `source_path` (F6's key) | one identity model across dissolve paths | Claude (F6 carried) | title (rejected in F6) |
| Conflict semantics (Tail gap) | last-write-wins CoW generation; identical no-op | overwrite is non-destructive under append-only history | Default (Claude, binding) | merge UX (editor's later problem) |
| Tags at Dissolve | inline-extracted → hasTag edges | tags materialise at Dissolve | Claude (Tail) | — |
| raw_hash default | sha256(blocks joined "\n\n") | the projection separator F14 formalizes; Grace may override | Default (Claude) | require explicit (rejected: friction) |
| C6 retirement | graph close, mode retired | no code ever shipped | measured | — |

## Dependencies

sink → verbs → tests. F3/F6 merged (satisfied).

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| dissolveContainer | 4 |
| verbs | 3 |

## Open & risk

- `[OPEN — B1]` the Grace menu mount and local file write-back UX.
- Risk: materialize on a mega-note from the F6 residue returns 1 block of
  archive junk — harmless read; the residue decision (F7) is unaffected.

## Constitution Check

**I/II** decided-with-provenance; the conflict gap resolved as a logged
binding default. **III** both wire shapes + the sink signature named.
**IV** SC-001..004 executable. **V** gate + wire round-trip evidence.

---
DoR: [x] decisions [x] contracts [x] RR verified [x] deps [x] constitution
