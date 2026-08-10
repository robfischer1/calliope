# Data model — The supersessions join table

The shared-data-model slice this plan contributes (master-plan F1 Tail):
**block lineage** — the one piece of this plan's model other buckets read.

## New: `supersessions`

```sql
CREATE TABLE IF NOT EXISTS supersessions (
  successor_id   text NOT NULL,
  predecessor_id text NOT NULL,
  node_id        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, successor_id, predecessor_id)
);
CREATE INDEX IF NOT EXISTS supersessions_predecessor
  ON supersessions (node_id, predecessor_id);
```

- One row = one (successor, predecessor) edge within one owning node.
- A merge (F3) writes N rows sharing `successor_id`.
- A split (F3) writes N rows sharing `predecessor_id`.
- An ordinary edit/reorder/delete writes exactly one row.
- `created_at` = the successor section row's `created_at` (transaction-stable
  `now()`), so an edge and the row it describes share the event stamp.
- Scoped per `node_id` for the same reason `sections` is: twin owners share
  section objects; lineage under one owner must not leak to the other.

## Existing: `sections` (shape unchanged — semantics consumed)

| `supersedes` value | Meaning | Produces an edge? |
| :--- | :--- | :--- |
| `NULL` | generation marker (coarse save) | no |
| `''` | add marker (A11 batch add) | no |
| `<64-hex id>` | supersedes that id (edit / reorder / tombstone-delete) | **yes** |

The column is retained and still written this feature ("leave the column until
F3 cuts over" — master-plan, decided). From this feature on it is a
denormalization of `supersessions`; the join table is the authoritative edge
source and `readRevisionAt` consults it.

## Backfill

```sql
INSERT INTO supersessions (successor_id, predecessor_id, node_id, created_at)
SELECT id, supersedes, node_id, created_at
  FROM sections
 WHERE supersedes IS NOT NULL AND supersedes <> ''
ON CONFLICT (node_id, successor_id, predecessor_id) DO NOTHING;
```

Runs inside `ensureSchema` after the DDL — idempotent, so every boot converges.
Tombstone rows backfill like any other superseding row (decided, plan Decision
Log): their edge is what makes a delete visible to as-of reconstruction.
