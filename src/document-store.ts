/**
 * The document store (C3, the prose strangle) — Calliope's home for dissolved
 * vault prose. The monolith's `documents` typed-write sink moves here: the
 * dissolve path (vault-mcp) posts note-ignorant payloads and the star stores
 * them verbatim with the project dedup contract.
 *
 * Dedup is `(source_path, raw_hash)` — one logical source note, content
 * hashed; an identical re-submit is a no-op (`deduped: true`), so the verb is
 * idempotent and a failed-then-retried dissolve never double-writes. This is
 * the same contract phdb's sink declared, at path grain (phdb interned paths
 * into `source_files`; the star stores the path inline — same key, one less
 * table).
 *
 * The wire shape mirrors the phdb HTTP `/write/document` contract exactly, so
 * vault-mcp's translator payloads pass through unchanged (the sink stays
 * note-ignorant; FR-004).
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";

/** The write payload — the phdb `/write/document` wire contract, verbatim. */
export interface WriteDocumentInput {
  /** The dissolved note's vault-relative source path (the dedup anchor). */
  source_path: string;
  /** The note body, stored verbatim (no fence-extraction, no reshaping). */
  body_text: string;
  /** Schema.org @type; the dissolve default. */
  schema_type?: string;
  /** The note's display title (phdb called this `subject`). */
  subject?: string;
  /** Absolute file path at dissolve time (provenance). */
  file_path?: string;
  /** Source-note frontmatter `updated` (ISO-8601), preserved as provenance. */
  mtime?: string;
  /** Source-note frontmatter `created` (ISO-8601), preserved as provenance. */
  ctime?: string;
  /** Capture-kind provenance tag. */
  source_kind?: string;
  /** Dedup hash override; defaults to sha256(body_text). */
  raw_hash?: string;
}

/** The result the dissolve path consumes (`ok`/`table`/`id`/`deduped`). */
export interface WriteDocumentResult {
  ok: true;
  table: "documents";
  id: number | null;
  deduped: boolean;
  source_path: string;
}

/** A stored document, read back. */
export interface DocumentRow {
  id: number;
  schema_type: string;
  title: string | null;
  source_path: string;
  file_path: string | null;
  body_text: string;
  content_hash: string;
  raw_hash: string;
  source_kind: string;
  mtime: string | null;
  ctime: string | null;
  created_at: string;
}

/** List filters for `read_documents`. */
export interface ListDocumentsQuery {
  schema_type?: string;
  limit?: number;
  /** When true, omit `body_text` from list results (index-style listing). */
  omit_body?: boolean;
}

/** The store seam — Pg in production, Fixture in tests/dev. */
export interface DocumentStore {
  write(input: WriteDocumentInput): Promise<WriteDocumentResult>;
  byId(id: number): Promise<DocumentRow | null>;
  bySourcePath(sourcePath: string): Promise<DocumentRow[]>;
  list(query?: ListDocumentsQuery): Promise<DocumentRow[]>;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DEFAULT_SCHEMA_TYPE = "DigitalDocument";
const DEFAULT_SOURCE_KIND = "vault-note";
const DEFAULT_LIST_LIMIT = 50;

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

interface PgDocumentRow {
  id: string | number;
  schema_type: string;
  title: string | null;
  source_path: string;
  file_path: string | null;
  body_text: string;
  content_hash: string;
  raw_hash: string;
  source_kind: string;
  mtime: string | null;
  ctime: string | null;
  created_at: Date;
}

function toRow(r: PgDocumentRow): DocumentRow {
  return {
    id: Number(r.id),
    schema_type: r.schema_type,
    title: r.title,
    source_path: r.source_path,
    file_path: r.file_path,
    body_text: r.body_text,
    content_hash: r.content_hash,
    raw_hash: r.raw_hash,
    source_kind: r.source_kind,
    mtime: r.mtime,
    ctime: r.ctime,
    created_at: r.created_at.toISOString(),
  };
}

const ROW_COLUMNS =
  "id, schema_type, title, source_path, file_path, body_text, " +
  "content_hash, raw_hash, source_kind, mtime, ctime, created_at";

export class PgDocumentStore implements DocumentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Bootstrap the `documents` schema (idempotent — CREATE IF NOT EXISTS). */
  async ensureSchema(): Promise<void> {
    await this.#pool.query(SCHEMA_SQL);
  }

  async write(input: WriteDocumentInput): Promise<WriteDocumentResult> {
    const rawHash = input.raw_hash ?? sha256(input.body_text);
    const res = await this.#pool.query<{ id: string | number }>(
      `INSERT INTO documents
         (schema_type, title, source_path, file_path, body_text,
          content_hash, raw_hash, source_kind, mtime, ctime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_path, raw_hash) DO NOTHING
       RETURNING id`,
      [
        input.schema_type ?? DEFAULT_SCHEMA_TYPE,
        input.subject ?? null,
        input.source_path,
        input.file_path ?? null,
        input.body_text,
        sha256(input.body_text),
        rawHash,
        input.source_kind ?? DEFAULT_SOURCE_KIND,
        input.mtime ?? null,
        input.ctime ?? null,
      ],
    );
    const inserted = res.rows[0];
    return {
      ok: true,
      table: "documents",
      id: inserted === undefined ? null : Number(inserted.id),
      deduped: inserted === undefined,
      source_path: input.source_path,
    };
  }

  async byId(id: number): Promise<DocumentRow | null> {
    const res = await this.#pool.query<PgDocumentRow>(
      `SELECT ${ROW_COLUMNS} FROM documents WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row === undefined ? null : toRow(row);
  }

  async bySourcePath(sourcePath: string): Promise<DocumentRow[]> {
    const res = await this.#pool.query<PgDocumentRow>(
      `SELECT ${ROW_COLUMNS} FROM documents
        WHERE source_path = $1 ORDER BY created_at DESC, id DESC`,
      [sourcePath],
    );
    return res.rows.map(toRow);
  }

  async list(query?: ListDocumentsQuery): Promise<DocumentRow[]> {
    const limit = query?.limit ?? DEFAULT_LIST_LIMIT;
    const where =
      query?.schema_type === undefined ? "" : " WHERE schema_type = $2";
    const columns =
      query?.omit_body === true
        ? ROW_COLUMNS.replace("body_text, ", "'' AS body_text, ")
        : ROW_COLUMNS;
    const args: unknown[] =
      query?.schema_type === undefined ? [limit] : [limit, query.schema_type];
    const res = await this.#pool.query<PgDocumentRow>(
      `SELECT ${columns} FROM documents${where}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      args,
    );
    return res.rows.map(toRow);
  }
}

/** In-memory {@link DocumentStore} — dev server + tool tests, no wire. */
export class FixtureDocumentStore implements DocumentStore {
  readonly #rows: DocumentRow[] = [];
  #seq = 0;

  write(input: WriteDocumentInput): Promise<WriteDocumentResult> {
    const rawHash = input.raw_hash ?? sha256(input.body_text);
    const existing = this.#rows.find(
      (r) => r.source_path === input.source_path && r.raw_hash === rawHash,
    );
    if (existing !== undefined) {
      return Promise.resolve({
        ok: true,
        table: "documents",
        id: null,
        deduped: true,
        source_path: input.source_path,
      });
    }
    this.#seq += 1;
    this.#rows.push({
      id: this.#seq,
      schema_type: input.schema_type ?? DEFAULT_SCHEMA_TYPE,
      title: input.subject ?? null,
      source_path: input.source_path,
      file_path: input.file_path ?? null,
      body_text: input.body_text,
      content_hash: sha256(input.body_text),
      raw_hash: rawHash,
      source_kind: input.source_kind ?? DEFAULT_SOURCE_KIND,
      mtime: input.mtime ?? null,
      ctime: input.ctime ?? null,
      created_at: new Date(this.#seq * 1000).toISOString(),
    });
    return Promise.resolve({
      ok: true,
      table: "documents",
      id: this.#seq,
      deduped: false,
      source_path: input.source_path,
    });
  }

  byId(id: number): Promise<DocumentRow | null> {
    return Promise.resolve(this.#rows.find((r) => r.id === id) ?? null);
  }

  bySourcePath(sourcePath: string): Promise<DocumentRow[]> {
    return Promise.resolve(
      this.#rows
        .filter((r) => r.source_path === sourcePath)
        .sort((a, b) => b.id - a.id),
    );
  }

  list(query?: ListDocumentsQuery): Promise<DocumentRow[]> {
    const limit = query?.limit ?? DEFAULT_LIST_LIMIT;
    let rows = [...this.#rows].sort((a, b) => b.id - a.id);
    if (query?.schema_type !== undefined) {
      rows = rows.filter((r) => r.schema_type === query.schema_type);
    }
    rows = rows.slice(0, limit);
    if (query?.omit_body === true) {
      rows = rows.map((r) => ({ ...r, body_text: "" }));
    }
    return Promise.resolve(rows);
  }
}
