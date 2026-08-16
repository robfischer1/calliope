---
title: "The Blob Store"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md (main checkout: .specify/memory/constitution.md)"
status: ready
---

# The Blob Store — Design Plan

> **Binding contract.** Every item is `decided` (executor MUST follow — no discretion)
> or `[OPEN]` (spec is silent and it matters — executor SURFACES it back, never invents).
> No advisory tier, no "use judgment." Open is the only license for discretion. (Constitution I/II)
>
> **Planning-context provenance.** This plan reconciles the authoritative planning
> context of master-plan feature **F1** ("Git for Ideas — The Blob Store and the
> Tree"). Every table/field/decision below marked [MP] is carried verbatim from
> that context, not derived from the spec.

## Summary

Add a `blobs` table to Calliope's Postgres schema — content-deduped immutable
prose, surrogate `bigint` identity, unique on content, full-text indexed — and a
`BlobStore` module exposing mint / fetch-by-id / fetch-by-content / search. No
existing table, verb, or client changes behavior. This is the plan's central
object; the tree (F3) will name these rows.

## Architecture

- `apps/calliope/src/pg-client.ts` — `SCHEMA_SQL` gains the `blobs` DDL
  (table + unique content index + FTS index). `ensureSchema()` already executes
  `SCHEMA_SQL` wholesale; no bootstrap change. Existing tables stay untouched
  (their drop is master-plan F12, gated on F6 parity).
- `apps/calliope/src/blob-store.ts` — **new module.** `class BlobStore`
  constructed over the existing `pg.Pool` (same pattern as `PgBodyClient`).
  No MCP surface in this feature: the store is consumed in-process by later
  features (F4 write path, F5 read path); MCP verbs arrive there.
- `apps/calliope/__tests__/blob-store.test.ts` — **new suite,** real-postgres
  testcontainer pattern copied from `pg-client.test.ts` (docker run
  `postgres:17-alpine`, `describe.skipIf(!HAVE_DOCKER)`).

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `db_table:blobs` | `id bigint identity PK · text text NOT NULL` — content-deduped, immutable, no structural columns [MP] | decided |
| `module:blob-store:mint` | `mint(text: string) -> Promise<string>` — id as decimal string; returns the existing id on a duplicate [MP] | decided |
| `module:blob-store:getText` | `getText(id: string) -> Promise<string \| null>` — null for an id that names nothing | decided |
| `module:blob-store:findByContent` | `findByContent(text: string) -> Promise<string \| null>` | decided |
| `module:blob-store:search` | `search(query: string, limit?: number) -> Promise<Array<{id: string, rank: number}>>` — ranked FTS | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on (signature consumed) | Pin |
| :--- | :--- | :--- |
| `pg.Pool` | `pool.query(text, values)` — the pool `PgBodyClient` already holds | pg@^8.22 |
| Postgres | `sha256(bytea)` builtin (PG ≥ 11) · `to_tsvector`/`ts_rank`/`websearch_to_tsquery` builtins · expression unique index + `ON CONFLICT` on it | postgres:17 (deployed) |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `file:apps/calliope/src/pg-client.ts` (`SCHEMA_SQL`, :38) | write (append DDL) | the `blobs` DDL joins the bootstrap [MP: "write pg-client.ts (replace SCHEMA_SQL)" — the *replace* completes at F12 when the old tables drop; F1 appends] | T001 |
| `file:apps/calliope/src/blob-store.ts` | create | the store module | T002 |
| `file:apps/calliope/__tests__/blob-store.test.ts` | create | the conformance suite | T003 |

## Data model

Deferred to [data-model.md](./data-model.md) — the seam shapes above stay authoritative.

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Blob table shape | `id bigint PK`, `text UNIQUE` — Postgres owns the addressing | A surrogate key plus a unique index *is* content-addressing, without a hand-rolled hash | **Rob** [MP] | content-hash PK (rejected in MP) |
| Separate content-hash column | **Cut** | `mintSectionId`'s hash bought neither dedup nor stability — it hashed content *and* a nonce | **Rob** [MP] | hash column + index |
| Text lives next to its address | Yes — `text` is in the row, readable | The Q8 precedent: a pointer you cannot read is not the signal | **Rob** [MP] | external/object storage |
| Content uniqueness mechanism | `UNIQUE INDEX ON blobs (sha256(convert_to(text,'UTF8')))` — an *expression* index, not a column | btree on raw `text` hits the ~2.7 KB index-row ceiling and would make dedup stop applying above a size (spec edge case); `sha256` is builtin in PG ≥ 11; an expression index honors "no separate hash column" | Default (resolves MP gap "whether text UNIQUE needs a hash-index expression") | raw `text UNIQUE` (breaks on large prose) · pgcrypto digest (needless extension) · md5 (weaker, no upside) |
| `authored_by` placement | **Not on the blob** — provenance rides the write transaction (F4's object) | A blob shared by five tenants has no single author; authorship is a property of the act of writing | Default, per MP recommendation ("recommend: the transaction") | column on blobs (violates FR-007) |
| Mint concurrency pattern | `INSERT … ON CONFLICT (sha256(convert_to(text,'UTF8'))) DO NOTHING RETURNING id`, then select-by-hash when conflicted | The standard race-free idempotent-insert pattern; DO UPDATE would write a row on duplicate mint, violating FR-002's "no row is written" | Claude | advisory lock (heavier) · DO UPDATE RETURNING (writes) |
| id surface type in TS | decimal `string` (opaque) | node-pg returns bigint as string; > 2^53 must not round-trip through `number` | Claude | number (unsafe) · BigInt (churn at every serialization boundary) |
| FTS shape | GIN on `to_tsvector('english', text)`; query via `websearch_to_tsquery`, ranked by `ts_rank` | Builtin, index-backed, matches SC-003; ranking *quality* is out of scope (spec Assumption) | Default | tsvector column + trigger (structure on the blob — forbidden) |
| Empty text | valid blob | Migration (F6) must carry every historical row | Default (spec Assumption) | refuse (strands rows) |
| No delete surface | none in F1 | GC is F7's census design | Default (spec Assumption) [MP] | delete verb (bypasses census) |

## Dependencies

- T002 (module) depends on T001 (DDL — the table the module queries).
- T003 (tests) depends on T001 + T002.
- No feature-external dependency: F1 is a DAG root [MP: Prerequisites — none].

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| `blobs` DDL | 9 (the plan's central object) |
| BlobStore module | 7 |
| Conformance suite | 6 |

## Open & risk

- **[OPEN → F3, carried]** Whether Poseidon visibility binds per-graph — out of
  F1's frame (blobs are tenant-shared by design [MP]); noted so the tree
  features do not inherit it silently.
- **Risk:** `convert_to(text,'UTF8')` requires a DB whose server encoding can
  represent the text; the deployed DB is UTF-8. If a non-UTF-8 deployment ever
  appears, the expression index degrades loudly (error), not silently.
- **Note:** master-plan RR says *replace* `SCHEMA_SQL`; F1 *appends* to it.
  The replace completes at F12 (drop of `sections`/`supersessions`/
  `comments_on` after parity). Divergence surfaced here, per the override
  contract.

---
Definition of Ready (the gate — must pass, not vacuously):
- [x] every decision resolved + provenance-tagged (incl. defaults)
- [x] Contracts & Seams complete — every exposed surface has a shape; every consumed dep pinned with its signature
- [x] Resource-Reach field-level AND verified against the real repo (no invented paths)
- [x] dependencies stated, no cycles
- [x] constitution check is real: I — every point above is decided/[OPEN], no judgment tier; II — both MP gaps (hash-index, authored_by) terminate here as binding Defaults; III — both sides of every seam shaped; IV — tasks.md carries falsifiable Acceptance per chunk; V — the suite runs against real postgres before done is claimed
