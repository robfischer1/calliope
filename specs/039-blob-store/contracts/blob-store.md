# Contract — `BlobStore` (module surface)

The named shapes from the planning context's Inter-feature seams
(`exposes: blobs`, `exposes: blob mint / fetch`), written as the in-process
TypeScript surface later features consume (F3 names rows; F4/F5 call the
module; MCP verbs arrive with those features, not here).

```ts
// apps/calliope/src/blob-store.ts
export interface BlobSearchHit {
  /** blobs.id as a decimal string — bigint never crosses through number. */
  id: string;
  /** ts_rank score — ordering signal only; absolute value is meaningless. */
  rank: number;
}

export class BlobStore {
  constructor(pool: Pool);

  /**
   * Idempotent content-addressed mint. New text → new row, its id returned.
   * Byte-identical text → NO row written, the existing id returned.
   * Concurrent duplicate mints converge on one row (ON CONFLICT DO NOTHING
   * + select-by-hash; the verify-select re-checks text equality so a hash
   * collision fails loudly instead of unifying distinct prose).
   */
  mint(text: string): Promise<string>;

  /** Exact stored text for an id; null when the id names nothing. */
  getText(id: string): Promise<string | null>;

  /** The id for byte-identical stored text; null when never stored. */
  findByContent(text: string): Promise<string | null>;

  /**
   * Ranked full-text search (websearch_to_tsquery / ts_rank, GIN-backed).
   * Empty result for a no-match query — never an error. limit defaults 20.
   */
  search(query: string, limit?: number): Promise<BlobSearchHit[]>;
}
```

**Guarantees (conformance targets, diffed by the suite):**

| # | Guarantee | Spec anchor |
| :--- | :--- | :--- |
| G1 | mint is idempotent on bytes; duplicate writes nothing | FR-002, SC-001 |
| G2 | distinct bytes → distinct ids | FR-003, SC-002 |
| G3 | getText round-trips byte-exact (incl. empty + unicode + >2.7 KB) | FR-004, SC-005 |
| G4 | absent id / absent content → null, never throw, never fabricate | FR-004, FR-005 |
| G5 | search returns ranked hits; no-match → `[]` | FR-006, SC-003 |
| G6 | `blobs` columns are exactly `{id, text}` | FR-007, SC-004 |
| G7 | concurrent duplicate mints: 1 row, equal ids | FR-008 |
