# Research — The Blob Store

Both unknowns surfaced by the planning context ("Gaps surfaced") are resolved;
nothing else in the Technical Context was unknown (the planning context decides
the rest — not re-researched, per the reconcile-first override).

## 1. Does `text UNIQUE` need a hash-index expression for large values?

- **Decision:** yes — a declared-IMMUTABLE wrapper
  `blob_content_hash(t text) RETURNS bytea` = `sha256(convert_to(t,'UTF8'))`,
  `CREATE UNIQUE INDEX blobs_content_key ON blobs (blob_content_hash(text))`,
  and `mint` targets it with `ON CONFLICT (blob_content_hash(text)) DO NOTHING`.
  (Found in implementation: `convert_to` is only STABLE — server-encoding
  dependent — so the raw expression is rejected in an index. The wrapper's
  immutability claim is honest on any UTF-8 server; this deployment is UTF-8,
  and a non-UTF-8 server fails loudly at conversion, never mis-dedupes.)
- **Rationale:** a plain btree UNIQUE on `text` fails with "index row size
  exceeds maximum" at ~2704 bytes (a third of an 8 KB page) — real paragraphs
  exceed that routinely, and dedup silently not applying above a size is the
  spec's named edge case. `sha256(bytea)` is a Postgres builtin since v11
  (deployed: 17), so no extension. An expression index adds no column, honoring
  Rob's "no separate content-hash column" — the hash exists only inside the
  index, invisible in the row.
- **Alternatives considered:** raw `text UNIQUE` (breaks on large prose);
  `pgcrypto.digest` (extension for what a builtin does); `md5(text)` (builtin
  and indexable, but a weaker hash with no advantage over sha256);
  hash-partitioned side table (structure for no gain).
- **Collision stance:** sha256 collision probability over any realistic corpus
  is negligible; if one ever occurred, the mint's verify-select
  (`… AND text = $1`) returns no row and the mint errors loudly rather than
  silently unifying two distinct texts.

## 2. Does `authored_by` ride the blob or the transaction?

- **Decision:** the transaction (master-plan F4's write-path object). The blob
  carries nothing but identity and text.
- **Rationale:** the planning context recommends it and FR-007 forbids
  authorship on the store; a deduped blob shared by five tenants has no single
  author — authorship belongs to each act of writing, which is exactly what
  Chaos `transactions` records.
- **Alternatives considered:** `authored_by` column on blobs — violates FR-007
  and breaks dedup (same prose, different author ⇒ forced duplicate).

## 3. (Incidental, resolved in passing) bigint ids across node-pg

- node-pg returns `bigint` columns as decimal strings. The module's surface
  types ids as `string` and never routes them through `number`. No parseInt
  anywhere in the store.
