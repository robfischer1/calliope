---
title: "The export hatch"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# The export hatch — Design Plan

> **Planning context consumed** (master-plan F14 Tail): markdown is an
> export, never the interchange format or source of truth [Rob, carried];
> consumes F3's container model; Grace mounts the menu item (B1).

## Reconcile evidence

Grace's desktop has NO note-action surface (measured: `src/body/` carries no
menu/toolbar; no Dissolve mount exists — F9's menu is equally pending B1).
The Tail's `repo:grace` pointer lands when B1 builds the actions
architecture; forcing it here would invent B1's UI cold. The A5 fork's
SUBSTANCE — the projection — ships now.

## Summary

One read-only verb: `export_note({container_id | source_path}) →
{container_id, markdown, block_count}` — blocks joined with the shared
`\n\n` seam, prose byte-verbatim. Fence → 26; annotation read-only.

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| Markdown demotes to export | one-way projection | Rob (carried) |
| Join seam | the shared `\n\n` (fs-client SECTION_SEP / aglaia BLOCK_SEP) | measured seam, Default |
| Fidelity (Tail gap) | prose passes verbatim; the dialect's own round-trip properties apply unchanged; multi-paragraph blocks are the boundary, surfaced | carried |
| Per-container vs per-lens (Tail gap) | per-container; lens export later | carried |
| Grace print path | B1's mount, with the menu system F9 also awaits | measured, surfaced |

## Open & risk

- `[OPEN — B1]` the Grace menu + print-to-PDF webview hook.
- Risk: separator-containing blocks make split-re-import undercount —
  surfaced fidelity boundary, pinned by test comment, not hidden.

## Constitution Check

**I/II** carried gaps surfaced; defaults logged. **III** the verb shape.
**IV** SC-001..002 executable. **V** gate + wire evidence.

---
DoR: [x] all
