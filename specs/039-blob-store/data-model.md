# Data model — The Blob Store

Carried verbatim from the master-plan F1 planning context (Shared-data-model
slice: **write `blobs` — the plan's central object**).

## `blobs` — the only entity

```sql
CREATE TABLE IF NOT EXISTS blobs (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text text   NOT NULL
);
-- Content addressing: uniqueness on the bytes, enforced via an expression
-- index (no hash COLUMN — Rob's decision; the hash lives only in the index).
-- Raw btree UNIQUE on text would cap out at ~2.7 KB per row. convert_to is
-- STABLE, not IMMUTABLE, so the expression is a declared-IMMUTABLE wrapper:
CREATE OR REPLACE FUNCTION blob_content_hash(t text) RETURNS bytea
  LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
  RETURN sha256(convert_to(t, 'UTF8'));
CREATE UNIQUE INDEX IF NOT EXISTS blobs_content_key
  ON blobs (blob_content_hash(text));
-- Full-text search over everything stored.
CREATE INDEX IF NOT EXISTS blobs_text_fts
  ON blobs USING gin (to_tsvector('english', text));
```

| Field | Type | Constraints | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | `bigint` identity | PK | the durable surrogate identity the tree (F3) will name |
| `text` | `text` | NOT NULL · content-unique via `blobs_content_key` | the prose, byte-exact, immutable |

**Deliberately absent** (FR-007 / master-plan "What NOT to do"): `node_id`,
`order_key`, `active`, `supersedes`, `tombstone`, `authored_by`, `created_at`,
`kafka_offset` — every structural/authorship column is a graph concern. If a
column feels structural, it is a fact.

## State transitions

None. A blob has one state: existing. It is never updated (immutability,
FR-001) and never deleted here (GC is F7's census). Orphan blobs — minted but
never referenced, e.g. by a crashed save — are legal garbage awaiting F7.

## Relationships

None inside Calliope. Chaos facts will reference `blobs.id` as an opaque
integer **without a foreign key** (discrete logical databases — the master-plan
constraint); that seam begins at F2 and is out of F1's frame.
