---
title: "The note arrives with enough to filter on"
spec: "./spec.md"
status: draft
---
# Design Plan
## Summary
`note-projection.ts` assembles the note as the index sees it — container blocks (body), `hasTag` edges (tags), the dissolve sink's provenance attributes (`title`, `source_path`, `mtime`, `ctime`, `schema_type`, `isArchived`), the tree history (revision, fallback timestamps) — and `consciousness-emit.ts` renders it as `ConsciousnessEvent.metadata` under the documented keys, absent-not-empty. Implemented together with F2 (the fold): the enrichment lands directly in the bus event rather than in a private payload that would be retired a feature later.
## Reconcile note
- Tail: "write the note publish path in calliope". The existing publish path (`notes-emit.ts`, decorating the section-based `BodyClient`) was never on the fleet's write path — notes are written through the container tree (F12), which did not pass through it. The producer therefore hangs off the container write verbs (`write_container`, `dissolve_note`) in `server.ts`. Recorded divergence.
- Gap: "eros's filters must actually read these keys" — confirmed on eros main: `source`, `since`/`until` (on `date_sent`), `focus_terms`, `include_meta`. `tags`/`container`/`lifecycle` are stored, not yet filterable — eros follow-up named in the docs.
## Architecture
```
apps/calliope/src/mcp/note-projection.ts     NEW — projectNote(facet, node, extras) → NoteProjection | undefined
apps/calliope/src/mcp/consciousness-emit.ts  NEW — noteEvent(): the vocabulary; METADATA_KEYS
apps/calliope/src/mcp/server.ts              publishNote after write_container / dissolve_note
docs/consciousness-producer.md               the vocabulary
```
## Exposes
| Surface | Shape | State |
| :--- | :--- | :--- |
| the note metadata vocabulary | `title, date_sent, source_path, tags, container, revision, author_kind, created_at, updated_at, lifecycle, schema_type` | decided |
## Decision Log
| Decision | Resolution | Rationale |
| :--- | :--- | :--- |
| where enrichment lives | the bus event's metadata | one payload, not a private one retired later |
| absent vs empty | absent | the initiative's discipline |
| author_kind on write_container | absent | the verb carries no provenance today |
