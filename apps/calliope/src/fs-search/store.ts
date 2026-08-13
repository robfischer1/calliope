/**
 * The search index store (Findability F2) — `<root>/.grace/search.sqlite`:
 * an FTS5 table + a 384-dim int8 vector table at the paragraph grain, per
 * `specs/033-search-verb/data-model.md`. Content-hash keyed vectors are the
 * one-forward-pass mechanism: `missingVectors()` returns only hashes no
 * vector exists for, so an edit that changed one paragraph costs one embed.
 *
 * No ANN structure anywhere — brute force at this corpus size is the ruled
 * architecture (docs/search-architecture.md). Methods are async because the
 * handle opens lazily through the two-runtime adapter (sqlite-compat).
 */

import type { CompatDatabase } from "./sqlite-compat.js";
import { openDatabase } from "./sqlite-compat.js";
import type { Paragraph } from "./chunker.js";

/** Snippet highlight markers — control chars, never legal prose. */
export const HL_OPEN = "";
export const HL_CLOSE = "";

export interface FtsHit {
  path: string;
  snippet: string;
}

export interface VectorRow {
  path: string;
  hash: string;
  text: string;
  vector: Int8Array;
}

const DDL = `
CREATE TABLE IF NOT EXISTS files (
  path  TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id    INTEGER PRIMARY KEY,
  path  TEXT NOT NULL,
  ord   INTEGER NOT NULL,
  hash  TEXT NOT NULL,
  text  TEXT NOT NULL,
  UNIQUE (path, ord)
);
CREATE INDEX IF NOT EXISTS blocks_by_hash ON blocks(hash);
CREATE INDEX IF NOT EXISTS blocks_by_path ON blocks(path);
CREATE TABLE IF NOT EXISTS vectors (
  hash   TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  model  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  text, content='blocks', content_rowid='id'
);
`;

export class SearchStore {
  readonly #dbPath: string;
  #db: CompatDatabase | null = null;
  #opening: Promise<CompatDatabase> | null = null;
  /** Bumped on every mutation — the vector cache's staleness signal. */
  #version = 0;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
  }

  get version(): number {
    return this.#version;
  }

  async #ready(): Promise<CompatDatabase> {
    if (this.#db !== null) return this.#db;
    this.#opening ??= openDatabase(this.#dbPath).then((db) => {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(DDL);
      this.#db = db;
      return db;
    });
    return this.#opening;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /** Every indexed file with its recorded (mtime, size) — the catch-up diff. */
  async listFiles(): Promise<Map<string, { mtime: number; size: number }>> {
    const db = await this.#ready();
    const rows = db.prepare("SELECT path, mtime, size FROM files").all() as {
      path: string;
      mtime: number;
      size: number;
    }[];
    return new Map(rows.map((r) => [r.path, { mtime: r.mtime, size: r.size }]));
  }

  /** Count of indexed files — the N=0 signal for the availability envelope. */
  async fileCount(): Promise<number> {
    const db = await this.#ready();
    const row = db.prepare("SELECT COUNT(*) AS n FROM files").get() as
      { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Replace a file's blocks with `paragraphs`, keeping FTS in sync and
   * sweeping vectors nothing references anymore. Returns the hashes that
   * still need embedding (present in blocks, absent in vectors).
   */
  async upsertFile(
    filePath: string,
    mtime: number,
    size: number,
    paragraphs: Paragraph[],
  ): Promise<{ missing: string[] }> {
    const db = await this.#ready();
    db.exec("BEGIN");
    try {
      this.#deleteBlocksFor(db, filePath);
      const insert = db.prepare(
        "INSERT INTO blocks (path, ord, hash, text) VALUES (?, ?, ?, ?)",
      );
      const ftsInsert = db.prepare(
        "INSERT INTO fts (rowid, text) VALUES (?, ?)",
      );
      for (const p of paragraphs) {
        const info = insert.run(filePath, p.ord, p.hash, p.text);
        ftsInsert.run(info.lastInsertRowid, p.text);
      }
      db.prepare(
        "INSERT INTO files (path, mtime, size) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
      ).run(filePath, mtime, size);
      this.#sweepOrphanVectors(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.#version++;
    const rows = db
      .prepare(
        "SELECT DISTINCT b.hash AS hash FROM blocks b " +
          "LEFT JOIN vectors v ON v.hash = b.hash " +
          "WHERE b.path = ? AND v.hash IS NULL",
      )
      .all(filePath) as { hash: string }[];
    return { missing: rows.map((r) => r.hash) };
  }

  /** Remove a vanished file's rows (FTS kept in sync; orphans swept). */
  async removeFile(filePath: string): Promise<void> {
    const db = await this.#ready();
    db.exec("BEGIN");
    try {
      this.#deleteBlocksFor(db, filePath);
      db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      this.#sweepOrphanVectors(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.#version++;
  }

  #deleteBlocksFor(db: CompatDatabase, filePath: string): void {
    const rows = db
      .prepare("SELECT id, text FROM blocks WHERE path = ?")
      .all(filePath) as { id: number; text: string }[];
    const ftsDelete = db.prepare(
      "INSERT INTO fts (fts, rowid, text) VALUES ('delete', ?, ?)",
    );
    for (const row of rows) ftsDelete.run(row.id, row.text);
    db.prepare("DELETE FROM blocks WHERE path = ?").run(filePath);
  }

  #sweepOrphanVectors(db: CompatDatabase): void {
    db.exec(
      "DELETE FROM vectors WHERE hash NOT IN (SELECT DISTINCT hash FROM blocks)",
    );
  }

  /** Corpus-wide unembedded hashes (deduped, with a text to embed), oldest
   *  blocks first — the background queue's work list. */
  async missingVectors(
    limit: number,
  ): Promise<{ hash: string; text: string }[]> {
    const db = await this.#ready();
    return db
      .prepare(
        "SELECT b.hash AS hash, MIN(b.text) AS text FROM blocks b " +
          "LEFT JOIN vectors v ON v.hash = b.hash " +
          "WHERE v.hash IS NULL GROUP BY b.hash ORDER BY MIN(b.id) LIMIT ?",
      )
      .all(limit) as { hash: string; text: string }[];
  }

  /** Store one embedded vector (int8[384], L2-normalized ×127). */
  async putVector(
    hash: string,
    vector: Int8Array,
    model: string,
  ): Promise<void> {
    const db = await this.#ready();
    db.prepare(
      "INSERT INTO vectors (hash, vector, model) VALUES (?, ?, ?) " +
        "ON CONFLICT(hash) DO UPDATE SET vector = excluded.vector, model = excluded.model",
    ).run(
      hash,
      new Uint8Array(vector.buffer, vector.byteOffset, vector.length),
      model,
    );
    this.#version++;
  }

  /** Drop vectors from a different nominal model (space seam enforcement). */
  async dropForeignVectors(model: string): Promise<number> {
    const db = await this.#ready();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM vectors WHERE model <> ?")
      .get(model) as { n: number } | undefined;
    db.prepare("DELETE FROM vectors WHERE model <> ?").run(model);
    if ((before?.n ?? 0) > 0) this.#version++;
    return before?.n ?? 0;
  }

  /** Every embedded block (optionally scope-filtered) — the brute-force scan. */
  async embeddedBlocks(scope?: string): Promise<VectorRow[]> {
    const db = await this.#ready();
    const glob = scopeGlob(scope);
    const sql =
      "SELECT b.path AS path, b.hash AS hash, b.text AS text, v.vector AS vector " +
      `FROM blocks b JOIN vectors v ON v.hash = b.hash ${glob === null ? "" : "WHERE b.path GLOB ?"}`;
    const stmt = db.prepare(sql);
    const rows = (glob === null ? stmt.all() : stmt.all(glob)) as {
      path: string;
      hash: string;
      text: string;
      vector: Uint8Array;
    }[];
    return rows.map((r) => ({
      path: r.path,
      hash: r.hash,
      text: r.text,
      vector: new Int8Array(
        r.vector.buffer,
        r.vector.byteOffset,
        r.vector.length,
      ),
    }));
  }

  /** FTS arm: ranked paths with marked snippets (best block per path). */
  async ftsSearch(
    query: string,
    scope: string | undefined,
    limit: number,
  ): Promise<FtsHit[]> {
    const match = toMatchExpression(query);
    if (match === "") return [];
    const db = await this.#ready();
    const glob = scopeGlob(scope);
    const sql =
      "SELECT b.path AS path, " +
      `snippet(fts, 0, '${HL_OPEN}', '${HL_CLOSE}', '…', 12) AS snippet ` +
      "FROM fts JOIN blocks b ON b.id = fts.rowid " +
      `WHERE fts MATCH ? ${glob === null ? "" : "AND b.path GLOB ?"} ORDER BY rank LIMIT ?`;
    const stmt = db.prepare(sql);
    const rows = (
      glob === null ? stmt.all(match, limit) : stmt.all(match, glob, limit)
    ) as FtsHit[];
    // Best (first-ranked) block per path only — the hit is the note.
    const seen = new Set<string>();
    const out: FtsHit[] = [];
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      out.push(row);
    }
    return out;
  }
}

/** A subtree scope becomes a GLOB pattern, or null for the whole root. */
function scopeGlob(scope: string | undefined): string | null {
  if (scope === undefined || scope === "") return null;
  return `${scope.replace(/\/$/, "")}/*`;
}

/** A raw user query becomes a safe FTS5 MATCH: quoted terms, implicit AND. */
export function toMatchExpression(query: string): string {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t !== "")
    .map((t) => `"${t}"`);
  return terms.join(" ");
}
