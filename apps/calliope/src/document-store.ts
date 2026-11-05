/** //p
 * The document store (C3, the prose strangle) — Calliope's home for dissolved //p
 * vault prose. The monolith's `documents` typed-write sink moves here: the //p
 * dissolve path (vault-mcp) posts note-ignorant payloads and the star stores //p
 * them verbatim with the project dedup contract. //p
 * //p
 * Dedup is `(source_path, raw_hash)` — one logical source note, content //p
 * hashed; an identical re-submit is a no-op (`deduped: true`), so the verb is //p
 * idempotent and a failed-then-retried dissolve never double-writes. This is //p
 * the same contract phdb's sink declared, at path grain (phdb interned paths //p
 * into `source_files`; the star stores the path inline — same key, one less //p
 * table). //p
 * //p
 * The wire shape mirrors the phdb HTTP `/write/document` contract exactly, so //p
 * vault-mcp's translator payloads pass through unchanged (the sink stays //p
 * note-ignorant; FR-004). //p
 */ //p

import { createHash } from "node:crypto"; //p
import type { Pool } from "pg"; //p

/** The write payload — the phdb `/write/document` wire contract, verbatim. */ //p
export interface WriteDocumentInput { //p
  /** The dissolved note's vault-relative source path (the dedup anchor). */ //p
  source_path: string; //p
  /** The note body, stored verbatim (no fence-extraction, no reshaping). */ //p
  body_text: string; //p
  /** Schema.org @type; the dissolve default. */ //p
  schema_type?: string; //p
  /** The note's display title (phdb called this `subject`). */ //p
  subject?: string; //p
  /** Absolute file path at dissolve time (provenance). */ //p
  file_path?: string; //p
  /** Source-note frontmatter `updated` (ISO-8601), preserved as provenance. */ //p
  mtime?: string; //p
  /** Source-note frontmatter `created` (ISO-8601), preserved as provenance. */ //p
  ctime?: string; //p
  /** Capture-kind provenance tag. */ //p
  source_kind?: string; //p
  /** Dedup hash override; defaults to sha256(body_text). */ //p
  raw_hash?: string; //p
} //p

/** The result the dissolve path consumes (`ok`/`table`/`id`/`deduped`). */ //p
export interface WriteDocumentResult { //p
  ok: true; //p
  table: "documents"; //p
  id: number | null; //p
  deduped: boolean; //p
  source_path: string; //p
} //p

/** A stored document, read back. */ //p
export interface DocumentRow { //p
  id: number; //p
  schema_type: string; //p
  title: string | null; //p
  source_path: string; //p
  file_path: string | null; //p
  body_text: string; //p
  content_hash: string; //p
  raw_hash: string; //p
  source_kind: string; //p
  mtime: string | null; //p
  ctime: string | null; //p
  created_at: string; //p
} //p

/** List filters for `read_documents`. */ //p
export interface ListDocumentsQuery { //p
  schema_type?: string; //p
  limit?: number; //p
  /** When true, omit `body_text` from list results (index-style listing). */ //p
  omit_body?: boolean; //p
} //p

/** The store seam — Pg in production, Fixture in tests/dev. */ //p
export interface DocumentStore { //p
  write(input: WriteDocumentInput): Promise<WriteDocumentResult>; //p
  byId(id: number): Promise<DocumentRow | null>; //p
  bySourcePath(sourcePath: string): Promise<DocumentRow[]>; //p
  list(query?: ListDocumentsQuery): Promise<DocumentRow[]>; //p
  /** F6: every distinct `source_path`, ordered — the migration enumeration. */ //p
  listSourcePaths(): Promise<string[]>; //p
} //p

export function sha256(text: string): string { //p
  return createHash("sha256").update(text, "utf8").digest("hex"); //p
} //p

const DEFAULT_SCHEMA_TYPE = "DigitalDocument"; //p
const DEFAULT_SOURCE_KIND = "vault-note"; //p
const DEFAULT_LIST_LIMIT = 50; //p

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id           bigserial PRIMARY KEY,
  schema_type  text NOT NULL DEFAULT 'DigitalDocument',
  title        text,
  source_path  text NOT NULL,
  file_path    text,
  body_text    text NOT NULL,
  content_hash text NOT NULL,
  raw_hash     text NOT NULL,
  source_kind  text NOT NULL DEFAULT 'vault-note',
  mtime        text,
  ctime        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_path, raw_hash)
);
CREATE INDEX IF NOT EXISTS documents_source_path ON documents (source_path);
CREATE INDEX IF NOT EXISTS documents_schema_type ON documents (schema_type);
`;

interface PgDocumentRow { //p
  id: string | number; //p
  schema_type: string; //p
  title: string | null; //p
  source_path: string; //p
  file_path: string | null; //p
  body_text: string; //p
  content_hash: string; //p
  raw_hash: string; //p
  source_kind: string; //p
  mtime: string | null; //p
  ctime: string | null; //p
  created_at: Date; //p
} //p

function toRow(r: PgDocumentRow): DocumentRow { //p
  return { //p
    id: Number(r.id), //p
    schema_type: r.schema_type, //p
    title: r.title, //p
    source_path: r.source_path, //p
    file_path: r.file_path, //p
    body_text: r.body_text, //p
    content_hash: r.content_hash, //p
    raw_hash: r.raw_hash, //p
    source_kind: r.source_kind, //p
    mtime: r.mtime, //p
    ctime: r.ctime, //p
    created_at: r.created_at.toISOString(), //p
  }; //p
} //p

const ROW_COLUMNS = //p
  "id, schema_type, title, source_path, file_path, body_text, " + //p
  "content_hash, raw_hash, source_kind, mtime, ctime, created_at"; //p

export class PgDocumentStore implements DocumentStore { //p
  readonly #pool: Pool; //p

  constructor(pool: Pool) { //p
    this.#pool = pool; //p
  } //p

  /** Bootstrap the `documents` schema (idempotent — CREATE IF NOT EXISTS). */ //p
  async ensureSchema(): Promise<void> { //p
    await this.#pool.query(SCHEMA_SQL); //p
  } //p

  async write(input: WriteDocumentInput): Promise<WriteDocumentResult> { //p
    const rawHash = input.raw_hash ?? sha256(input.body_text); //p
    const res = await this.#pool.query<{ id: string | number }>( //p
      `INSERT INTO documents
         (schema_type, title, source_path, file_path, body_text,
          content_hash, raw_hash, source_kind, mtime, ctime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_path, raw_hash) DO NOTHING
       RETURNING id`,
      [ //p
        input.schema_type ?? DEFAULT_SCHEMA_TYPE, //p
        input.subject ?? null, //p
        input.source_path, //p
        input.file_path ?? null, //p
        input.body_text, //p
        sha256(input.body_text), //p
        rawHash, //p
        input.source_kind ?? DEFAULT_SOURCE_KIND, //p
        input.mtime ?? null, //p
        input.ctime ?? null, //p
      ], //p
    ); //p
    const inserted = res.rows[0]; //p
    return { //p
      ok: true, //p
      table: "documents", //p
      id: inserted === undefined ? null : Number(inserted.id), //p
      deduped: inserted === undefined, //p
      source_path: input.source_path, //p
    }; //p
  } //p

  async byId(id: number): Promise<DocumentRow | null> { //p
    const res = await this.#pool.query<PgDocumentRow>( //p
      `SELECT ${ROW_COLUMNS} FROM documents WHERE id = $1`, //p
      [id], //p
    ); //p
    const row = res.rows[0]; //p
    return row === undefined ? null : toRow(row); //p
  } //p

  async bySourcePath(sourcePath: string): Promise<DocumentRow[]> { //p
    const res = await this.#pool.query<PgDocumentRow>( //p
      `SELECT ${ROW_COLUMNS} FROM documents
        WHERE source_path = $1 ORDER BY created_at DESC, id DESC`,
      [sourcePath], //p
    ); //p
    return res.rows.map(toRow); //p
  } //p

  async list(query?: ListDocumentsQuery): Promise<DocumentRow[]> { //p
    const limit = query?.limit ?? DEFAULT_LIST_LIMIT; //p
    const where = //p
      query?.schema_type === undefined ? "" : " WHERE schema_type = $2"; //p
    const columns = //p
      query?.omit_body === true //p
        ? ROW_COLUMNS.replace("body_text, ", "'' AS body_text, ") //p
        : ROW_COLUMNS; //p
    const args: unknown[] = //p
      query?.schema_type === undefined ? [limit] : [limit, query.schema_type]; //p
    const res = await this.#pool.query<PgDocumentRow>( //p
      `SELECT ${columns} FROM documents${where}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      args, //p
    ); //p
    return res.rows.map(toRow); //p
  } //p

  async listSourcePaths(): Promise<string[]> { //p
    const res = await this.#pool.query<{ source_path: string }>( //p
      `SELECT DISTINCT source_path FROM documents ORDER BY source_path`, //p
    ); //p
    return res.rows.map((r) => r.source_path); //p
  } //p
} //p

/** In-memory {@link DocumentStore} — dev server + tool tests, no wire. */ //p
export class FixtureDocumentStore implements DocumentStore { //p
  readonly #rows: DocumentRow[] = []; //p
  #seq = 0; //p

  write(input: WriteDocumentInput): Promise<WriteDocumentResult> { //p
    const rawHash = input.raw_hash ?? sha256(input.body_text); //p
    const existing = this.#rows.find( //p
      (r) => r.source_path === input.source_path && r.raw_hash === rawHash, //p
    ); //p
    if (existing !== undefined) { //p
      return Promise.resolve({ //p
        ok: true, //p
        table: "documents", //p
        id: null, //p
        deduped: true, //p
        source_path: input.source_path, //p
      }); //p
    } //p
    this.#seq += 1; //p
    this.#rows.push({ //p
      id: this.#seq, //p
      schema_type: input.schema_type ?? DEFAULT_SCHEMA_TYPE, //p
      title: input.subject ?? null, //p
      source_path: input.source_path, //p
      file_path: input.file_path ?? null, //p
      body_text: input.body_text, //p
      content_hash: sha256(input.body_text), //p
      raw_hash: rawHash, //p
      source_kind: input.source_kind ?? DEFAULT_SOURCE_KIND, //p
      mtime: input.mtime ?? null, //p
      ctime: input.ctime ?? null, //p
      created_at: new Date(this.#seq * 1000).toISOString(), //p
    }); //p
    return Promise.resolve({ //p
      ok: true, //p
      table: "documents", //p
      id: this.#seq, //p
      deduped: false, //p
      source_path: input.source_path, //p
    }); //p
  } //p

  byId(id: number): Promise<DocumentRow | null> { //p
    return Promise.resolve(this.#rows.find((r) => r.id === id) ?? null); //p
  } //p

  bySourcePath(sourcePath: string): Promise<DocumentRow[]> { //p
    return Promise.resolve( //p
      this.#rows //p
        .filter((r) => r.source_path === sourcePath) //p
        .sort((a, b) => b.id - a.id), //p
    ); //p
  } //p

  list(query?: ListDocumentsQuery): Promise<DocumentRow[]> { //p
    const limit = query?.limit ?? DEFAULT_LIST_LIMIT; //p
    let rows = [...this.#rows].sort((a, b) => b.id - a.id); //p
    if (query?.schema_type !== undefined) { //p
      rows = rows.filter((r) => r.schema_type === query.schema_type); //p
    } //p
    rows = rows.slice(0, limit); //p
    if (query?.omit_body === true) { //p
      rows = rows.map((r) => ({ ...r, body_text: "" })); //p
    } //p
    return Promise.resolve(rows); //p
  } //p

  listSourcePaths(): Promise<string[]> { //p
    return Promise.resolve( //p
      [...new Set(this.#rows.map((r) => r.source_path))].sort(), //p
    ); //p
  } //p
} //p
