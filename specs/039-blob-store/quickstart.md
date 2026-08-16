# Quickstart — validating The Blob Store

## Prerequisites

- Docker (the suite spins an ephemeral `postgres:17-alpine`; without docker the
  real-postgres suite skips with a visible reason — that is not a pass).
- `bun install` done at the repo root.

## Run the conformance suite

```bash
cd apps/calliope
bun run test -- __tests__/blob-store.test.ts
```

Expected: every G1–G7 guarantee in
[contracts/blob-store.md](./contracts/blob-store.md) green, including the
schema-inspection test (G6: `blobs` columns are exactly `id, text`) and the
concurrency test (G7: 32 parallel mints of one text → one row).

## Full gate

```bash
bun run gate   # format:check + lint + typecheck + test + build, repo-wide
```

## Manual poke (optional, against the suite's container while it runs, or any dev PG)

```sql
-- mint twice, observe one row:
--   (the module does this via INSERT … ON CONFLICT DO NOTHING; SQL shown for inspection)
SELECT count(*) FROM blobs;
SELECT id, left(text, 40) FROM blobs ORDER BY id DESC LIMIT 5;
-- FTS:
SELECT id, ts_rank(to_tsvector('english', text),
                   websearch_to_tsquery('english', 'fox')) AS rank
  FROM blobs
 WHERE to_tsvector('english', text) @@ websearch_to_tsquery('english', 'fox')
 ORDER BY rank DESC;
```
