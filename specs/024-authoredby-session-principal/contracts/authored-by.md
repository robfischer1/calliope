# Contract — the AuthoredBy surface (F1)

Inter-feature seam shapes carried verbatim from the master-plan (Exposes: "block write provenance — `(principal, session_uuid, kafka_offset)` on the row — open — F1, F2"; F1 owns the principal half).

## Type contract (library consumers: pg-client, hades-capture, tools, tests)

```ts
// types.ts (defined) · urania-client.ts (re-exported — import paths unchanged)
export type SessionPrincipal = `spiffe://${string}/session/${string}`;
export type AuthoredBy = "human" | "calliope" | SessionPrincipal;
export const SESSION_PRINCIPAL_RE: RegExp; // UUID-tailed, lowercase hex
export function isAuthoredBy(v: string): v is AuthoredBy;
```

## MCP verb contract (every sections-writing verb)

Verbs: `write_body`, `edit_section`, `append_section`, `apply_section_ops`, `create_block`, `update_block`, `delete_block`, `split_block`, `merge_block`.

> **Correction (surfaced at implement, 2026-08-13):** `coalesce_block_writes` was listed here at plan time but is excluded — it is the F8 arc-collapse, which physically *removes* rows and rewires lineage; it has no `INSERT INTO sections` site and stamps no provenance, so an `authored_by` input would be a dead parameter. Nine verbs carry the field.

- New optional input on each: `authored_by?: string`.
  - Valid: `"human"` · `"calliope"` · a string matching `SESSION_PRINCIPAL_RE`.
  - Absent → the write behaves exactly as before this feature (instance default).
  - Invalid → the verb rejects with a validation error **naming the accepted forms** (spec FR-005); no row is written.
- Result shapes: unchanged on every verb.

## Client contract (BodyClient implementations)

```ts
// optional trailing param on the write methods; absent → instance default
saveBody(nodeId, sections, authoredBy?: AuthoredBy): Promise<void>
editSection?(nodeId, sectionId, text, authoredBy?: AuthoredBy): Promise<Section>
applySectionOps?(nodeId, ops, authoredBy?: AuthoredBy): Promise<ApplySectionOpsResult>
splitSection?(nodeId, sectionId, texts, authoredBy?: AuthoredBy): Promise<…>
mergeSections?(nodeId, sectionIds, authoredBy?: AuthoredBy): Promise<…>
```

`PgBodyClient` stamps `authoredBy ?? this.#authoredBy` at every sections INSERT. `materialize(nodeId, sections, authoredBy = "calliope")` is unchanged.

## Read contract (already satisfied — regression-pinned only)

- `read_revisions` returns each revision's `authoredBy` verbatim (string), principal or legacy.
