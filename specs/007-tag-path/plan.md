---
title: "The Tag Path — hasTag write + read (C9)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C9 — Design Plan

> **Binding contract.** Reconciled against the master-plan C9 tail (authoritative) + live wire (2026-07-24): the tag grammar is MIRRORED from theia `packages/aglaia/src/decorations/scan.ts:62` (`/(^|[^\w#[])#([A-Za-z][\w/-]*)/g` — the aglaia package is a THEIA workspace package now, folded in at window 3); chaos `find_by_value(graph: hex, predicate, value)` takes the graph's HEX id (name_hash("notes") = `ab5aa970…`); the tail's `list_tags` enumeration gap resolves to a **pg mirror table** (Calliope is the sole tag-writer per the C2 sole-writer law, so its own store can carry the distinct set + per-tag provenance the graph doesn't hold).

## Summary

A `tags` module (extract + reconcile), a `TagStore` (pg mirror: `note_tags(node_id, tag, source)` — provenance `inline|explicit`, the enumeration + explicit-survival substrate), the reconcile hooked into `create_note` (explicit) and the Note-kind body-write path (inline; `write_body` / `apply_section_ops` / `append_section` / `edit_section`), and two verbs: `list_by_tag` (chaos `find_by_value` — the graph is the truth) and `list_tags` (the pg mirror's distinct set). Graph edges write first (truth), the mirror follows; a mirror drift heals on the next reconcile of that note.

## Data model (the Tail's shared-data-model slice)

- **write `graph:notes` `hasTag` edges** — literal, lowercase-normalized `#tag` values, add/remove via themis admits on scope `notes`.
- **read via `find_by_value`** — `(graph=name_hash("notes"), predicate="hasTag", value="#tag")` → node ids.
- **calliope-db `note_tags`** (new, mirror): `(node_id text, tag text, source text CHECK (source IN ('inline','explicit')), PRIMARY KEY (node_id, tag))` — provenance for explicit-survival + the `list_tags` distinct set.

## Decision Log

| Decision | Resolution | Rationale | Provenance |
| :--- | :--- | :--- | :--- |
| Grammar | scan.ts TAG_RE mirrored verbatim | one grammar across render + extract (the tail's own lean) | decided (tail) |
| Case | lowercase-normalized at write | `find_by_value` is exact-match; the palette and the A21 `tag:` lens need one canonical form | Claude (Default) |
| Enumeration | pg mirror table | no chaos verb enumerates distinct literal values; the sole-writer law makes Calliope's own store a valid index; rebuildable from the graph | Claude (tail gap resolved) |
| Explicit-survival | provenance rides the mirror (`source`) | the graph edge doesn't say WHO wrote it; the reconcile must never strip folder tags | Claude (Default) |
| Kind gate | `dial.edges(node)` → `hasType == "Note"` before any extraction | FR-006; work-node prose never enters the tag path; one cheap read per body write | Claude (Default) |
| Edge removal | `removeEdge` rides the batch scope (`notes`) | every notes-tenant fact lands in the notes scope — the 07-05 scattered-graph hazard doesn't apply here | Claude (Default) |

## Open & risk

- A body write's +1 `edges()` read applies to every node (Note or not) when the chaos facet is live — ~ms on the east-west wire; skipped entirely when the facet is absent (fixture-off deployments).
- Mirror drift (graph write lands, pg write dies): the mirror heals on the note's next reconcile; `list_tags` may transiently under/over-count. Logged loudly, accepted for v1.
- Concurrent writes to one note can interleave reconciles; last-writer-wins at both layers, converging on the final body. Accepted (single-author system).
