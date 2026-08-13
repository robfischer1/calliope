# Data Model: The search verb in Calliope

The hit + envelope carry over from F1 verbatim (`specs/032-search-arch-ruling/`).
New here: the index's own schema (plan.md Decisions 1–3).

## The index — `<root>/.grace/search.sqlite`

```sql
CREATE TABLE IF NOT EXISTS files (
  path  TEXT PRIMARY KEY,   -- root-relative posix path (the fs node identity)
  mtime INTEGER NOT NULL,   -- ms; catch-up diff key
  size  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id    INTEGER PRIMARY KEY,          -- rowid; FTS external-content key
  path  TEXT NOT NULL,
  ord   INTEGER NOT NULL,             -- paragraph order within the file
  hash  TEXT NOT NULL,                -- sha256 of normalized paragraph text
  text  TEXT NOT NULL,
  UNIQUE (path, ord)
);
CREATE INDEX IF NOT EXISTS blocks_by_hash ON blocks(hash);

CREATE TABLE IF NOT EXISTS vectors (
  hash   TEXT PRIMARY KEY,            -- content-addressed: dedupe + one-pass edits
  vector BLOB NOT NULL,               -- int8[384], L2-normalized ×127
  model  TEXT NOT NULL                -- nominal model id; mismatch ⇒ re-embed
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  text, content='blocks', content_rowid='id'
);
```

- **Grain**: paragraph (blank-line split of the normalized body). The body facet's
  one-section-per-file derivation is untouched — index only.
- **One-pass incrementality**: re-derive a changed file's paragraphs → new rows in
  `blocks`; only hashes absent from `vectors` are embedded. One changed paragraph
  = one new hash = one forward pass (SC-003's structural guarantee).
- **Orphan sweep**: vectors whose hash no longer appears in `blocks` are deleted
  opportunistically after a file re-index (cheap join; keeps the 36 MB bound).
- `.grace/` is dot-skipped by every existing walk and by the chunker's own walk —
  the index never indexes itself (FR-007).

## Availability states (per query)

| State | armsQueried | armsDark |
| :--- | :--- | :--- |
| both local arms up | `["fts","semantic"]` | `[]` |
| encoder not ready / assets absent | `["fts"]` | `["semantic"]` |
| index missing entirely (no root scan yet) | `[]` | `["fts","semantic"]` |

(The `eros` arm joins the vocabulary in F4 — the type already carries it.)
