---
title: "Finish the phdb strangler — retire the documents table"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Retire the documents table — Design Plan

> **Planning context consumed** (master-plan F7 Tail): the strangled thing
> goes away [Claude, TURN 220]; consumes F6 (+ the prelude executing Rob's
> identity decision). Fleet sweep DONE and recorded below.

## Fleet sweep (measured)

| Caller | Consumption | Cutover impact |
| :--- | :--- | :--- |
| vault-mcp dissolve (`/write/document` route) | passthrough; `table`/`deduped` via tolerant `.get()` (lifecycle_verbs.py:105) | none — shape survives, `table` becomes `"notes"` |
| vault-mcp `read_document(doc_id)` (the un-dissolve leg) | `{documents: [...]}` by id | served via `document_id` attrs |
| athena `resolve_plan` | `read_plan`/`read_block` via the store seam | unchanged — the seam re-backs |
| calliope tests | wire suites | move with the store |

## Summary

`NotesDocumentStore` re-backs the `DocumentStore` seam onto the merged note
store; both backends wire it (one model — the fixture cannot drift from
prod); `write_document` becomes the sink alone; a gated `drop-documents`
CLI performs the drop after convergence verification; the archive verbs'
registrations say FROZEN ARCHIVE. The live drop is additionally gated on
the deployed image serving notes-backed reads.

## Architecture

- `src/notes-document-store.ts` (new) — the store; row reconstruction from
  attributes + container body; `write` = `sinkNoteVersion`, result extended
  with the sink's `note`.
- `src/mcp/backend.ts` — pg + fixture arms wire `NotesDocumentStore`;
  `PgDocumentStore` leaves the backend (its `ensureSchema` no longer runs,
  so a post-drop boot cannot resurrect the table).
- `src/mcp/server.ts` — `write_document` drops its separate bridge call
  (the store IS the sink); archive-verb descriptions re-scoped.
- `src/mcp/drop-documents.ts` (new) — probe / `--execute`, convergence-
  verified.
- Tests: new store suite; plan-ingest seeds move to `source_path` handles
  (fresh writes have no table id — documented legacy).

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| The strangled thing goes away | yes | Claude, TURN 220 (master-plan) |
| Fresh dissolves get no document id | correct — the sequence dies with the table; ids are migration-legacy handles | Default (Claude), surfaced in docs |
| bySourcePath = newest state | versions ride the container's revisions (F6 model) | Default (Claude) |
| Drop mechanism | explicit gated CLI, never boot-time DDL | Default (Claude) — a rollback-deployed old image must not meet a boot-time DROP |
| Live-drop gate | deployed image must serve notes-backed reads first | Default (Claude) — the old image reads the table |
| file_revisions' home (Tail gap) | stays in calliope, FROZEN ARCHIVE scoping in its registration | Default (Claude) |

## Open & risk

- Risk: an out-of-fleet consumer reads the TABLE directly (SQL, not verbs)
  — the Tail's surfaced gap; the drop CLI's probe + Rob's awareness are the
  gate; the table is recoverable from aether backups regardless.
- Risk: unfiltered `list` ordering relies on `dissolved_at` attrs — absent
  on none of the migrated corpus (verified: every sink writes it when
  known; fresh dissolves order by absence last). Accepted.

## Constitution Check

**I/II** decided-with-provenance; sweep measured. **III** the store seam
re-backed with named shapes. **IV** SC-001..002. **V** suite + live
verification with the drop's gate condition recorded.

---
DoR: [x] all
