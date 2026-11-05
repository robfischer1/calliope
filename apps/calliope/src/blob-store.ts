/** //p
 * BlobStore — the content-deduped prose store (spec 039, master-plan F1). //p
 * //p
 * One table of immutable text rows keyed by a surrogate bigint. Minting the //p
 * same bytes twice returns the same id and writes nothing. The blob knows //p
 * nothing about who wrote it or where it belongs — membership, ordering and //p
 * authorship are graph concerns (the tree, F3+). Nothing here updates or //p
 * deletes a row: blobs are immortal until the F7 census reaps orphans. //p
 */ //p

import type { Pool } from "pg"; //p

/** ts_rank score — an ordering signal only; the absolute value is meaningless. */ //p
export interface BlobSearchHit { //p
  /** blobs.id as a decimal string — bigint never crosses through number. */ //p
  id: string; //p
  rank: number; //p
} //p

// The exact expression of the blobs_content_key unique index; ON CONFLICT //p
// must match it token-for-token or postgres won't recognize the arbiter. //p
// (blob_content_hash is the schema's declared-IMMUTABLE sha256-of-UTF8.) //p
const CONTENT_KEY = `blob_content_hash(text)`; //p

/** The prose-store surface the write path consumes — implemented by the //p
 *  real {@link BlobStore} and, for the fixture backend, by //p
 *  {@link FixtureBlobStore} (one model, two engines — the fixture cannot //p
 *  drift from the store the fleet runs). */ //p
export interface ProseStore { //p
  mint(text: string): Promise<string>; //p
  getText(id: string): Promise<string | null>; //p
  /** Batched fetch — ONE round trip whatever the count; ids that resolve //p
   *  to nothing are simply missing from the map (the caller marks them //p
   *  dangling). Empty input answers an empty map with no query. */ //p
  getTexts(ids: string[]): Promise<Map<string, string>>; //p
  findByContent(text: string): Promise<string | null>; //p
  search(query: string, limit?: number): Promise<BlobSearchHit[]>; //p
} //p

export class BlobStore implements ProseStore { //p
  readonly #pool: Pool; //p

  constructor(pool: Pool) { //p
    this.#pool = pool; //p
  } //p

  /** //p
   * Idempotent content-addressed mint. New text inserts and returns the new //p
   * id; byte-identical text writes NOTHING and returns the existing id. //p
   * Race-safe: concurrent duplicate mints converge on one row via //p
   * ON CONFLICT DO NOTHING (the loser's select sees the winner's commit). //p
   * The fallback select re-checks text equality so a hash collision would //p
   * fail loudly (no row returned) instead of unifying distinct prose. //p
   */ //p
  async mint(text: string): Promise<string> { //p
    const inserted = await this.#pool.query<{ id: string }>( //p
      `INSERT INTO blobs (text) VALUES ($1)
       ON CONFLICT (${CONTENT_KEY}) DO NOTHING
       RETURNING id`,
      [text], //p
    ); //p
    const insertedRow = inserted.rows[0]; //p
    if (insertedRow) return insertedRow.id; //p
    const existing = await this.findByContent(text); //p
    if (existing === null) //p
      throw new Error( //p
        "blob mint failed: content-key conflict but no row matches the text", //p
      ); //p
    return existing; //p
  } //p

  /** Exact stored text for an id; null when the id names nothing. */ //p
  async getText(id: string): Promise<string | null> { //p
    const res = await this.#pool.query<{ text: string }>( //p
      `SELECT text FROM blobs WHERE id = $1`, //p
      [id], //p
    ); //p
    return res.rows[0]?.text ?? null; //p
  } //p

  async getTexts(ids: string[]): Promise<Map<string, string>> { //p
    const out = new Map<string, string>(); //p
    if (ids.length === 0) return out; //p
    const res = await this.#pool.query<{ id: string; text: string }>( //p
      `SELECT id, text FROM blobs WHERE id = ANY($1::bigint[])`, //p
      [ids], //p
    ); //p
    for (const row of res.rows) out.set(row.id, row.text); //p
    return out; //p
  } //p

  /** The id for byte-identical stored text; null when never stored. */ //p
  async findByContent(text: string): Promise<string | null> { //p
    const res = await this.#pool.query<{ id: string }>( //p
      `SELECT id FROM blobs
        WHERE ${CONTENT_KEY} = blob_content_hash($1)
          AND text = $1`,
      [text], //p
    ); //p
    return res.rows[0]?.id ?? null; //p
  } //p

  /** //p
   * Ranked full-text search (GIN-backed). Empty result for a no-match or //p
   * stopword-only query — never an error. //p
   */ //p
  async search(query: string, limit = 20): Promise<BlobSearchHit[]> { //p
    const res = await this.#pool.query<{ id: string; rank: number }>( //p
      `SELECT id,
              ts_rank(to_tsvector('english', text),
                      websearch_to_tsquery('english', $1))::float8 AS rank
         FROM blobs
        WHERE to_tsvector('english', text)
              @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC, id
        LIMIT $2`,
      [query, limit], //p
    ); //p
    return res.rows.map((r) => ({ id: r.id, rank: r.rank })); //p
  } //p
} //p

/** In-memory ProseStore for the fixture backend and the tool tests: //p
 *  byte-identical dedup, decimal ids, no ranking (search answers matches //p
 *  unranked — the write path never searches; the real ranking contract is //p
 *  the pg suite's). */ //p
export class FixtureBlobStore implements ProseStore { //p
  readonly #byText = new Map<string, string>(); //p
  readonly #byId = new Map<string, string>(); //p
  #seq = 0; //p

  mint(text: string): Promise<string> { //p
    const hit = this.#byText.get(text); //p
    if (hit !== undefined) return Promise.resolve(hit); //p
    this.#seq += 1; //p
    const id = String(this.#seq); //p
    this.#byText.set(text, id); //p
    this.#byId.set(id, text); //p
    return Promise.resolve(id); //p
  } //p

  getText(id: string): Promise<string | null> { //p
    return Promise.resolve(this.#byId.get(id) ?? null); //p
  } //p

  getTexts(ids: string[]): Promise<Map<string, string>> { //p
    const out = new Map<string, string>(); //p
    for (const id of ids) { //p
      const text = this.#byId.get(id); //p
      if (text !== undefined) out.set(id, text); //p
    } //p
    return Promise.resolve(out); //p
  } //p

  findByContent(text: string): Promise<string | null> { //p
    return Promise.resolve(this.#byText.get(text) ?? null); //p
  } //p

  search(query: string): Promise<BlobSearchHit[]> { //p
    const out: BlobSearchHit[] = []; //p
    for (const [id, text] of this.#byId) { //p
      if (query !== "" && text.includes(query)) out.push({ id, rank: 0 }); //p
    } //p
    return Promise.resolve(out); //p
  } //p

  /** Test helper: how many blobs exist (dedup assertions). */ //p
  get size(): number { //p
    return this.#byId.size; //p
  } //p

  /** Every id, ascending (the census's candidate universe). */ //p
  allIds(): string[] { //p
    return [...this.#byId.keys()].sort((a, b) => Number(a) - Number(b)); //p
  } //p

  /** The census's reap (F7) — the one sanctioned deletion. */ //p
  reapIds(ids: string[]): number { //p
    let n = 0; //p
    for (const id of ids) { //p
      const text = this.#byId.get(id); //p
      if (text === undefined) continue; //p
      this.#byId.delete(id); //p
      this.#byText.delete(text); //p
      n += 1; //p
    } //p
    return n; //p
  } //p
} //p

/** The census's store-side surface (F7) — deliberately NOT on ProseStore: //p
 *  reaping is the census's one sanctioned mutation, and the general prose //p
 *  surface stays read-and-mint only (the F1 pin holds). */ //p
export interface GcStore { //p
  /** Highest minted id at snapshot time; null on an empty store. */ //p
  maxId(): Promise<string | null>; //p
  /** Every id ≤ upTo (the census's candidate universe). */ //p
  listIdsUpTo(upTo: string): Promise<string[]>; //p
  /** Ids marked unheld by a previous complete census. */ //p
  readMarks(): Promise<string[]>; //p
  /** Replace the mark set (only ever called after a COMPLETE census). */ //p
  writeMarks(ids: string[]): Promise<void>; //p
  /** Delete reaped blobs + their marks. Returns the count removed. */ //p
  reap(ids: string[]): Promise<number>; //p
} //p

/** GcStore over the sovereign store — same pool, separate class. */ //p
export class PgBlobGc implements GcStore { //p
  readonly #pool: Pool; //p
  constructor(pool: Pool) { //p
    this.#pool = pool; //p
  } //p
  async maxId(): Promise<string | null> { //p
    const res = await this.#pool.query<{ max: string | null }>( //p
      `SELECT max(id)::text AS max FROM blobs`, //p
    ); //p
    return res.rows[0]?.max ?? null; //p
  } //p
  async listIdsUpTo(upTo: string): Promise<string[]> { //p
    const res = await this.#pool.query<{ id: string }>( //p
      `SELECT id FROM blobs WHERE id <= $1 ORDER BY id`, //p
      [upTo], //p
    ); //p
    return res.rows.map((r) => r.id); //p
  } //p
  async readMarks(): Promise<string[]> { //p
    const res = await this.#pool.query<{ id: string }>( //p
      `SELECT id FROM blob_gc_marks ORDER BY id`, //p
    ); //p
    return res.rows.map((r) => r.id); //p
  } //p
  async writeMarks(ids: string[]): Promise<void> { //p
    await this.#pool.query(`DELETE FROM blob_gc_marks`); //p
    if (ids.length === 0) return; //p
    await this.#pool.query( //p
      `INSERT INTO blob_gc_marks (id)
       SELECT unnest($1::bigint[]) ON CONFLICT (id) DO NOTHING`,
      [ids], //p
    ); //p
  } //p
  async reap(ids: string[]): Promise<number> { //p
    if (ids.length === 0) return 0; //p
    const res = await this.#pool.query( //p
      `DELETE FROM blobs WHERE id = ANY($1::bigint[])`, //p
      [ids], //p
    ); //p
    await this.#pool.query( //p
      `DELETE FROM blob_gc_marks WHERE id = ANY($1::bigint[])`, //p
      [ids], //p
    ); //p
    return res.rowCount ?? 0; //p
  } //p
} //p

/** GcStore over the in-memory fixture — one model, two engines. */ //p
export class FixtureBlobGc implements GcStore { //p
  #marks: string[] = []; //p
  constructor(private readonly store: FixtureBlobStore) {} //p
  maxId(): Promise<string | null> { //p
    const ids = this.store.allIds(); //p
    return Promise.resolve( //p
      ids.length === 0 ? null : (ids[ids.length - 1] ?? null), //p
    ); //p
  } //p
  listIdsUpTo(upTo: string): Promise<string[]> { //p
    return Promise.resolve( //p
      this.store.allIds().filter((id) => Number(id) <= Number(upTo)), //p
    ); //p
  } //p
  readMarks(): Promise<string[]> { //p
    return Promise.resolve([...this.#marks]); //p
  } //p
  writeMarks(ids: string[]): Promise<void> { //p
    this.#marks = [...ids]; //p
    return Promise.resolve(); //p
  } //p
  reap(ids: string[]): Promise<number> { //p
    const n = this.store.reapIds(ids); //p
    this.#marks = this.#marks.filter((id) => !ids.includes(id)); //p
    return Promise.resolve(n); //p
  } //p
} //p
