---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: The Blob Store

**Input:** plan.md · spec.md · contracts/blob-store.md.
**Binding contract:** every task is binding spec. The executor follows it and does NOT
use judgment outside items marked `[OPEN]`. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T002 → T003 (strictly sequential; T002 queries the
  table T001 creates, T003 exercises both). No [P] lanes — three tasks, one chain.

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | `apps/calliope/src/pg-client.ts` |
| 1 | T002 | T001 | `apps/calliope/src/blob-store.ts` (new) |
| 1 | T003 | T001, T002 | `apps/calliope/__tests__/blob-store.test.ts` (new) |

## Work-chunks

### T001 — The `blobs` DDL joins the bootstrap  ·  S  ·  sequential
- **Serves:** plan slice "`blobs` DDL" — the plan's central object.
- **Acceptance:** Given a fresh database, When `ensureSchema()` runs, Then
  `blobs` exists with columns exactly `{id bigint identity PK, text NOT NULL}`,
  a unique expression index on `sha256(convert_to(text,'UTF8'))`, and a GIN
  index on `to_tsvector('english', text)`; And re-running `ensureSchema()` is a
  no-op (all statements `IF NOT EXISTS`); And every pre-existing table is
  untouched.
- **Exposes:** `db_table:blobs` (shape per data-model.md) · decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/pg-client.ts`
  (`SCHEMA_SQL` — append the three statements from data-model.md verbatim; no
  other edit to this file).
- **State:** none (DDL only).
- **Decisions-slice:** `id bigint PK` / content-unique [Rob] · expression index
  over hash column [Default, research §1] · no structural columns [Rob].
- **Conflicts-with:** none (only task touching pg-client.ts).
- **Open:** —
- **Size basis:** three DDL statements appended to an existing literal → S.

### T002 — The `BlobStore` module  ·  M  ·  sequential
- **Serves:** plan slice "BlobStore module" — the mint/fetch/search surface.
- **Acceptance:** Given the contract in contracts/blob-store.md, When the
  module is implemented, Then its surface is exactly `mint` / `getText` /
  `findByContent` / `search` with the documented signatures and guarantees
  G1–G5 + G7; And ids are decimal strings end-to-end (no `number` coercion);
  And `mint` uses `INSERT … ON CONFLICT (sha256(convert_to(text,'UTF8'))) DO
  NOTHING RETURNING id` with a verify-select fallback that re-checks
  `text = $1`; And no method updates or deletes a blob row.
- **Exposes:** `module:blob-store:{mint,getText,findByContent,search}` (shapes
  per plan Contracts & Seams) · decided.
- **Touches (RR, field-level):** create `file:apps/calliope/src/blob-store.ts`
  (constructor over `pg.Pool`, matching `PgBodyClient`'s pattern); read
  `db_table:blobs`.
- **State:** none (stateless module over the pool).
- **Decisions-slice:** mint concurrency pattern [Claude] · id as string
  [Claude] · FTS via websearch_to_tsquery + ts_rank [Default] · no delete
  surface [Default].
- **Conflicts-with:** none (new file).
- **Open:** —
- **Size basis:** four methods, one nontrivial SQL pattern, a race contract → M.

### T003 — The conformance suite  ·  M  ·  sequential
- **Serves:** Constitution IV/V — the falsifiable gate on G1–G7.
- **Acceptance:** Given docker, When
  `bun run test -- __tests__/blob-store.test.ts` runs, Then every guarantee
  G1–G7 has at least one test and all pass against a real `postgres:17-alpine`;
  including: duplicate mint writes no row (row-count asserted, G1); >2.7 KB
  text dedupes (the btree-ceiling edge, G3); empty + unicode round-trip
  byte-exact (G3); absent id/content → null (G4); no-match search → [] (G5);
  information_schema shows columns exactly `{id, text}` (G6); ≥32 concurrent
  mints of one text → one row, all ids equal (G7). Suite skips (visibly) when
  docker is absent, per the `pg-client.test.ts` precedent.
- **Exposes:** — (test-only).
- **Touches (RR, field-level):** create
  `file:apps/calliope/__tests__/blob-store.test.ts` (harness copied from
  `apps/calliope/__tests__/pg-client.test.ts`: docker run, port probe,
  readiness loop, afterAll teardown); call `module:blob-store:*`.
- **State:** ephemeral container per suite run.
- **Budget:** suite ≤ 120 s including container boot (matches existing
  real-postgres suites' beforeAll timeout).
- **Decisions-slice:** real postgres over simulator [existing repo precedent].
- **Conflicts-with:** none (new file).
- **Open:** —
- **Size basis:** ~10 tests incl. a concurrency case over a container harness → M.

---
Done-when (the gate):
- [x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
- [x] every [P] verified conflict-free (none claimed)
- [x] critical path identified; no dependency cycles
- [x] every Exposes shape traces to plan.md Contracts & Seams
- [x] State + Budget present where stateful / perf-load-bearing (T003 budget)
