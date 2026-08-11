---
title: "ToolAnnotations on every Calliope verb"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# ToolAnnotations on every Calliope verb — Design Plan

> **Binding contract.** (Constitution I/II)

> **Planning context consumed** (master-plan F10 Tail): Calliope as the
> annotation pilot [Claude, R062]; hints ride the protocol, rules live in
> Ouranos [Argus amendment]; feeds B7's control-panel render (cross-bucket).

## Summary

Add `annotations` to all 25 `registerTool` configs in
`apps/calliope/src/mcp/server.ts` from one pinned map, and pin that map with
a wire-level fence test. Reconcile note: the Tail says "fifteen
registrations"; the surface is 25 post-F3/F5/F8/F9 — annotate reality.

## The annotation map (decided, binding)

| Verbs | readOnly | destructive | idempotent |
| :--- | :--- | :--- | :--- |
| read_body · read_block · list_blocks · read_body_revisions · read_body_at · read_documents · read_plan · file_revisions · revision_deltas · list_by_tag · list_tags · materialize_note | true | false | true |
| create_block · append_section · split_block · merge_block | false | false | false |
| update_block · edit_section (F4 no-op) · create_note · write_document · dissolve_note | false | false | true |
| apply_section_ops (carries deletes) · delete_block · write_body (id massacre) | false | true | false |
| coalesce_block_writes (physical history deletion; re-run removes 0) | false | true | true |

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| write_body destructive? (Tail gap) | true — replaces every block id in one stroke; anchor destruction is the destruction that matters | Default (Claude) |
| Annotate 25, not 15 | the surface as measured post-fan-out | Claude, divergence surfaced |
| Rollout pattern (Tail gap) | this map + fence IS the pilot pattern; fleet fan-out is other stars' work | carried |

## Open & risk

- Risk: a future verb ships without annotations — the fence test asserts
  EVERY listed tool carries them, so it cannot.

## Constitution Check

**I/II** map decided-with-provenance. **III** the map is the contract.
**IV** the fence is executable. **V** gate + wire evidence.

---
DoR: [x] all
