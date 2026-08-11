---
title: "Server-side tag hygiene and a persisted cleanup pass"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Server-side tag hygiene and a persisted cleanup pass — Design Plan

> **Planning context consumed** (master-plan F11 Tail): a persisted-data
> cleanup, not a render filter [Claude, R065/R066]; self-contained;
> instantiates the plan-wide constraint "fix it at the data, not at the
> renderer".

## Reconcile evidence (measured)

- `extractInlineTags` ALREADY carries `isHexColor` (the Brief's "the
  server-side index never got the rule" predates it landing) — the LIVE
  gaps are: the explicit path validates nothing, `normalizeTag` keeps
  trailing slashes, and the persisted junk has never been swept.
- Live junk (aether, 2026-08-10): 35 distinct tags; 9 hex (`#a6d189`…,
  one carrier each) + `#brainsoup/` (one carrier).

## Summary

`tags.ts` gains `isJunkTag` (hex-shape post-normalize) and a slash-stripping
`normalizeTag`; `computeTagDelta` drops junk at the chokepoint;
`create_note` rejects junk explicit tags. A gated CLI
(`src/mcp/cleanup-tags.ts`, probe/apply) sweeps the persisted store: junk
rows deleted + carrier `hasTag` edges retracted; slash variants merged to
their normalized form (edge re-pointed, row rewritten). Live run post-merge.

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| Fix location | the data, not the render | Claude, R065/R066 |
| `#brainsoup/` (Tail gap) | slash-strip merge → `#brainsoup`; the dash-rename is tag-node territory, out of scope | Default (Claude), surfaced |
| Reversibility (Tail gap) | substrate-level: chaos is append-only, retractions are logged ops; no undo verb built | Default (Claude) |
| Explicit-path rejection | `bad_tags` (structured), plus chokepoint drop | Default (Claude) |

## Resource-Reach (verified)

`src/tags.ts` · `src/tag-store.ts` (read; no schema change) ·
`src/mcp/tools.ts:createNote` (bad_tags) · `src/mcp/cleanup-tags.ts` (new) ·
tests: `__tests__/tags.test.ts`, `__tests__/mcp-tools.test.ts`.

## Open & risk

- Risk: a legitimate 3/4/6/8-char all-hex tag (e.g. `#cafe`, `#face`) is
  unwritable post-guard — accepted (same trade scan.ts already made on the
  render side; the store had zero such legitimate tags when measured).

## Constitution Check

**I/II** gaps resolved as logged defaults. **III** isJunkTag/normalize/CLI
contracts stated. **IV** unit + wire + live SCs. **V** live run output
pasted; re-run zero.

---
DoR: [x] all
