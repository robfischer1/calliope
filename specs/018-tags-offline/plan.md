---
title: "Tags offline"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Tags offline — Design Plan

> **Planning context consumed** (master-plan F12 Tail): tags are a computed
> index offline; edges materialise at Dissolve [Rob, Grace discovery brief];
> Touches (RR): `repo:calliope fs-client.ts (INDEX ONLY — grain unchanged)`,
> `tags.ts`; `repo:theia packages/aglaia/src/suggest/`. Grace's rail is in
> the seams narrative but NOT the RR write-set — B1's mount.

## Summary

Calliope: `src/fs-tags.ts` (walk + extract + aggregate, per request) and two
sidecar dispatch arms. Theia: `tagPickerSource` beside `notePickerSource`.
No cache ⇒ the invalidation gap dissolves. No graph dial exists on the
offline path ⇒ "no hasTag edge offline" holds by construction.

## Contracts

| Surface | Shape |
| :--- | :--- |
| `function:fs-tags:computeFsTagIndex` | `(root) -> {tags: TagCount[], byTag: Map<tag, nodeIds[]>}` — node id = root-relative posix path |
| `ferry:list_tags` | `{} -> {tags: [{tag, count}]}` |
| `ferry:list_by_tag` | `{tag} -> {tag, node_ids}` (normalized) |
| `ts:aglaia tagPickerSource` | `(listTags: () => readonly string[]) -> SuggestSource` — lookbehind-bounded `#` trigger, fuzzy filter, inserts `#tag ` |

## Decision Log

| Decision | Resolution | Provenance |
| :--- | :--- | :--- |
| Computed index, no edges offline | — | Rob (Tail, decided) |
| Cache / invalidation (Tail gap) | none — per-request scan; local dirs are small; cache is a measured-later optimization | Default (Claude) |
| F11 interaction (Tail gap) | free — the shared extractor carries isHexColor + isJunkTag | measured |
| Grace rail | out of the RR write-set; B1 mounts it | measured from Tail, surfaced |

## Open & risk

- Risk: huge served roots make per-request scans slow — accepted until
  measured; the seam allows a cached index behind the same verbs.
- `[OPEN — B1]` the tag atlas rail mount in Grace.

## Constitution Check

**I/II** gaps resolved as logged defaults; write-set measured from RR.
**III** shapes above. **IV** SC-001..003. **V** both repos' gates.

---
DoR: [x] all
