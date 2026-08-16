/**
 * BlobStore — the content-deduped prose store (spec 039, master-plan F1).
 *
 * One table of immutable text rows keyed by a surrogate bigint. Minting the
 * same bytes twice returns the same id and writes nothing. The blob knows
 * nothing about who wrote it or where it belongs — membership, ordering and
 * authorship are graph concerns (the tree, F3+). Nothing here updates or
 * deletes a row: blobs are immortal until the F7 census reaps orphans.
 */

import type { Pool } from "pg";

/** ts_rank score — an ordering signal only; the absolute value is meaningless. */
export interface BlobSearchHit {
  /** blobs.id as a decimal string — bigint never crosses through number. */
  id: string;
  rank: number;
}

// The exact expression of the blobs_content_key unique index; ON CONFLICT
// must match it token-for-token or postgres won't recognize the arbiter.
// (blob_content_hash is the schema's declared-IMMUTABLE sha256-of-UTF8.)
const CONTENT_KEY = `blob_content_hash(text)`;

/** The prose-store surface the write path consumes — implemented by the
 *  real {@link BlobStore} and, for the fixture backend, by
 *  {@link FixtureBlobStore} (one model, two engines — the fixture cannot
 *  drift from the store the fleet runs). */
export interface ProseStore {
  mint(text: string): Promise<string>;
  getText(id: string): Promise<string | null>;
  /** Batched fetch — ONE round trip whatever the count; ids that resolve
   *  to nothing are simply missing from the map (the caller marks them
   *  dangling). Empty input answers an empty map with no query. */
  getTexts(ids: string[]): Promise<Map<string, string>>;
  findByContent(text: string): Promise<string | null>;
  search(query: string, limit?: number): Promise<BlobSearchHit[]>;
}

export class BlobStore implements ProseStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Idempotent content-addressed mint. New text inserts and returns the new
   * id; byte-identical text writes NOTHING and returns the existing id.
   * Race-safe: concurrent duplicate mints converge on one row via
   * ON CONFLICT DO NOTHING (the loser's select sees the winner's commit).
   * The fallback select re-checks text equality so a hash collision would
   * fail loudly (no row returned) instead of unifying distinct prose.
   */
  async mint(text: string): Promise<string> {
    const inserted = await this.#pool.query<{ id: string }>(
      `INSERT INTO blobs (text) VALUES ($1)
       ON CONFLICT (${CONTENT_KEY}) DO NOTHING
       RETURNING id`,
      [text],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) return insertedRow.id;
    const existing = await this.findByContent(text);
    if (existing === null)
      throw new Error(
        "blob mint failed: content-key conflict but no row matches the text",
      );
    return existing;
  }

  /** Exact stored text for an id; null when the id names nothing. */
  async getText(id: string): Promise<string | null> {
    const res = await this.#pool.query<{ text: string }>(
      `SELECT text FROM blobs WHERE id = $1`,
      [id],
    );
    return res.rows[0]?.text ?? null;
  }

  async getTexts(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const res = await this.#pool.query<{ id: string; text: string }>(
      `SELECT id, text FROM blobs WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of res.rows) out.set(row.id, row.text);
    return out;
  }

  /** The id for byte-identical stored text; null when never stored. */
  async findByContent(text: string): Promise<string | null> {
    const res = await this.#pool.query<{ id: string }>(
      `SELECT id FROM blobs
        WHERE ${CONTENT_KEY} = blob_content_hash($1)
          AND text = $1`,
      [text],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Ranked full-text search (GIN-backed). Empty result for a no-match or
   * stopword-only query — never an error.
   */
  async search(query: string, limit = 20): Promise<BlobSearchHit[]> {
    const res = await this.#pool.query<{ id: string; rank: number }>(
      `SELECT id,
              ts_rank(to_tsvector('english', text),
                      websearch_to_tsquery('english', $1))::float8 AS rank
         FROM blobs
        WHERE to_tsvector('english', text)
              @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC, id
        LIMIT $2`,
      [query, limit],
    );
    return res.rows.map((r) => ({ id: r.id, rank: r.rank }));
  }
}

/** In-memory ProseStore for the fixture backend and the tool tests:
 *  byte-identical dedup, decimal ids, no ranking (search answers matches
 *  unranked — the write path never searches; the real ranking contract is
 *  the pg suite's). */
export class FixtureBlobStore implements ProseStore {
  readonly #byText = new Map<string, string>();
  readonly #byId = new Map<string, string>();
  #seq = 0;

  mint(text: string): Promise<string> {
    const hit = this.#byText.get(text);
    if (hit !== undefined) return Promise.resolve(hit);
    this.#seq += 1;
    const id = String(this.#seq);
    this.#byText.set(text, id);
    this.#byId.set(id, text);
    return Promise.resolve(id);
  }

  getText(id: string): Promise<string | null> {
    return Promise.resolve(this.#byId.get(id) ?? null);
  }

  getTexts(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const text = this.#byId.get(id);
      if (text !== undefined) out.set(id, text);
    }
    return Promise.resolve(out);
  }

  findByContent(text: string): Promise<string | null> {
    return Promise.resolve(this.#byText.get(text) ?? null);
  }

  search(query: string): Promise<BlobSearchHit[]> {
    const out: BlobSearchHit[] = [];
    for (const [id, text] of this.#byId) {
      if (query !== "" && text.includes(query)) out.push({ id, rank: 0 });
    }
    return Promise.resolve(out);
  }

  /** Test helper: how many blobs exist (dedup assertions). */
  get size(): number {
    return this.#byId.size;
  }
}
