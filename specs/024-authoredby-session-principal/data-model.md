# Data model — Widen AuthoredBy to a Session Principal

Carried verbatim from the master-plan F1 Tail's Shared-data-model slice: **block provenance — read by F2, F4, F9 and any audit.**

## `sections.authored_by` (postgres, the sovereign store)

- DDL (existing, unchanged): `authored_by text NOT NULL DEFAULT 'human'` (`pg-client.ts:38`).
- Value domain (widened at the type/validation layer only):
  - `'human'` — legacy literal; Rob-attributed writes (gateway `SET ROLE human` seam).
  - `'calliope'` — legacy literal; machine-authored writes (e.g. `materialize`).
  - `spiffe://{td}/session/{uuid}` — a session principal; UUID-shaped tail, lowercase hex.
- **No migration.** Legacy rows are already members of the widened domain. Zero DDL, zero backfill.
- State transitions: none — `authored_by` is immutable per section row (copy-on-write versioning mints new rows; each row's author is stamped once at INSERT).

## `AuthoredBy` (TypeScript, `types.ts` — new home; re-exported from `urania-client.ts`)

```
SessionPrincipal = `spiffe://${string}/session/${string}`   (template-literal type)
AuthoredBy       = "human" | "calliope" | SessionPrincipal
SESSION_PRINCIPAL_RE = /^spiffe:\/\/[^/]+\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
isAuthoredBy(v: string): v is AuthoredBy   — legacy literal OR regex match
```

## `BlockOp.authored_by` (Kafka block-op wire, `types.ts:105`)

- Widens from the inline `"human" | "calliope"` union to `AuthoredBy`. The transaction log carries exactly what the row carries.

## Revision read model (`types.ts:272`)

- `authoredBy: string` — already wide; returns the stored value verbatim (`pg-client.ts:705,717`). Unchanged.

## Relationships

- Written by: every sections-INSERT site in `PgBodyClient` (7 sites, `pg-client.ts:146–459`) and `materialize` (`pg-client.ts:767–773`).
- Read by: `readRevisions` (`pg-client.ts:687–720`) → MCP `read_revisions` (`server.ts:797`); downstream F2 (offset joins the same rows), F4 (comment author), F9 (replay resolves the principal).
