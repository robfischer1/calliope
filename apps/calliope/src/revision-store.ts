/**
 * The revision store (C4) — Calliope's home for git-for-ideas: the vault's
 * file-revision archive (which notes changed, when, how, with AI summaries)
 * and its revision-grain triple deltas (the frontmatter/link evolution
 * record), re-homed from the monolith.
 *
 * The archive is FROZEN history (capture stopped 2026-05-27; the go-forward
 * self-instrumentation is the Aglaia block-op stream). Source ids are
 * preserved verbatim — the deltas key on revision id, and idempotent
 * migration re-runs converge on `ON CONFLICT DO NOTHING`.
 *
 * Blob content NEVER lives here: `git_blob_sha` / `parent_blob_sha` are
 * pointers into the vault's own git repo (the blob store). Deltas arrive
 * DENORMALIZED — the monolith kept (subject, predicate, object) as pks into
 * a 13M-row node dictionary; the migration resolves them to labels so this
 * archive is self-contained.
 */

import type { Pool } from "pg";

/** A file revision row (the phdb `history.file_revisions` shape, id-preserved). */
export interface RevisionRow {
  id: number;
  schema_type: string | null;
  repo: string | null;
  commit_sha: string | null;
  file_path: string;
  prior_file_path: string | null;
  change_type: string | null;
  authorship: string | null;
  summary: string | null;
  summary_model: string | null;
  summary_generated_at: string | null;
  git_blob_sha: string | null;
  parent_blob_sha: string | null;
  captured_at: string | null;
}

/** A denormalized triple delta (labels, not dictionary pks). */
export interface RevisionDeltaRow {
  id: number;
  revision_id: number;
  op: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
}

/** Query surface for the `file_revisions` verb. */
export interface RevisionQuery {
  id?: number;
  file_path?: string;
  repo?: string;
  limit?: number;
}

/** The store seam — Pg in production, Fixture in tests. */
export interface RevisionStore {
  importRevision(row: RevisionRow): Promise<void>;
  importDelta(row: RevisionDeltaRow): Promise<void>;
  revisions(query?: RevisionQuery): Promise<RevisionRow[]>;
  deltasFor(revisionId: number): Promise<RevisionDeltaRow[]>;
  counts(): Promise<{ revisions: number; deltas: number }>;
}

const DEFAULT_LIMIT = 50;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_revisions (
  id                   bigint PRIMARY KEY,
  schema_type          text,
  repo                 text,
  commit_sha           text,
  file_path            text NOT NULL,
  prior_file_path      text,
  change_type          text,
  authorship           text,
  summary              text,
  summary_model        text,
  summary_generated_at text,
  git_blob_sha         text,
  parent_blob_sha      text,
  captured_at          timestamptz
);
CREATE INDEX IF NOT EXISTS file_revisions_path
  ON file_revisions (file_path, captured_at DESC);
CREATE INDEX IF NOT EXISTS file_revisions_repo
  ON file_revisions (repo, captured_at DESC);

CREATE TABLE IF NOT EXISTS revision_deltas (
  id          bigint PRIMARY KEY,
  revision_id bigint NOT NULL,
  op          text,
  subject     text,
  predicate   text,
  object      text
);
CREATE INDEX IF NOT EXISTS revision_deltas_revision
  ON revision_deltas (revision_id, id);
`;

interface PgRevisionRow extends Omit<RevisionRow, "id" | "captured_at"> {
  id: string | number;
  captured_at: Date | null;
}

function toRevision(r: PgRevisionRow): RevisionRow {
  return {
    ...r,
    id: Number(r.id),
    captured_at: r.captured_at === null ? null : r.captured_at.toISOString(),
  };
}

const REV_COLUMNS =
  "id, schema_type, repo, commit_sha, file_path, prior_file_path, " +
  "change_type, authorship, summary, summary_model, summary_generated_at, " +
  "git_blob_sha, parent_blob_sha, captured_at";

export class PgRevisionStore implements RevisionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Bootstrap the revision schema (idempotent — CREATE IF NOT EXISTS). */
  async ensureSchema(): Promise<void> {
    await this.#pool.query(SCHEMA_SQL);
  }

  async importRevision(row: RevisionRow): Promise<void> {
    await this.#pool.query(
      `INSERT INTO file_revisions (${REV_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.schema_type,
        row.repo,
        row.commit_sha,
        row.file_path,
        row.prior_file_path,
        row.change_type,
        row.authorship,
        row.summary,
        row.summary_model,
        row.summary_generated_at,
        row.git_blob_sha,
        row.parent_blob_sha,
        row.captured_at,
      ],
    );
  }

  async importDelta(row: RevisionDeltaRow): Promise<void> {
    await this.#pool.query(
      `INSERT INTO revision_deltas (id, revision_id, op, subject, predicate, object)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.revision_id, row.op, row.subject, row.predicate, row.object],
    );
  }

  async revisions(query?: RevisionQuery): Promise<RevisionRow[]> {
    const limit = query?.limit ?? DEFAULT_LIMIT;
    if (query?.id !== undefined) {
      const res = await this.#pool.query<PgRevisionRow>(
        `SELECT ${REV_COLUMNS} FROM file_revisions WHERE id = $1`,
        [query.id],
      );
      return res.rows.map(toRevision);
    }
    const clauses: string[] = [];
    const args: unknown[] = [limit];
    if (query?.file_path !== undefined) {
      args.push(query.file_path);
      clauses.push(`file_path = $${String(args.length)}`);
    }
    if (query?.repo !== undefined) {
      args.push(query.repo);
      clauses.push(`repo = $${String(args.length)}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.#pool.query<PgRevisionRow>(
      `SELECT ${REV_COLUMNS} FROM file_revisions${where}
        ORDER BY captured_at DESC NULLS LAST, id DESC LIMIT $1`,
      args,
    );
    return res.rows.map(toRevision);
  }

  async deltasFor(revisionId: number): Promise<RevisionDeltaRow[]> {
    const res = await this.#pool.query<
      Omit<RevisionDeltaRow, "id" | "revision_id"> & {
        id: string | number;
        revision_id: string | number;
      }
    >(
      `SELECT id, revision_id, op, subject, predicate, object
         FROM revision_deltas WHERE revision_id = $1 ORDER BY id`,
      [revisionId],
    );
    return res.rows.map((r) => ({
      ...r,
      id: Number(r.id),
      revision_id: Number(r.revision_id),
    }));
  }

  async counts(): Promise<{ revisions: number; deltas: number }> {
    const res = await this.#pool.query<{ revisions: string; deltas: string }>(
      `SELECT (SELECT COUNT(*) FROM file_revisions) AS revisions,
              (SELECT COUNT(*) FROM revision_deltas) AS deltas`,
    );
    const row = res.rows[0];
    return {
      revisions: Number(row?.revisions ?? 0),
      deltas: Number(row?.deltas ?? 0),
    };
  }
}

/** In-memory {@link RevisionStore} — tool tests, no wire. */
export class FixtureRevisionStore implements RevisionStore {
  readonly #revisions = new Map<number, RevisionRow>();
  readonly #deltas = new Map<number, RevisionDeltaRow>();

  importRevision(row: RevisionRow): Promise<void> {
    if (!this.#revisions.has(row.id)) this.#revisions.set(row.id, row);
    return Promise.resolve();
  }

  importDelta(row: RevisionDeltaRow): Promise<void> {
    if (!this.#deltas.has(row.id)) this.#deltas.set(row.id, row);
    return Promise.resolve();
  }

  revisions(query?: RevisionQuery): Promise<RevisionRow[]> {
    const limit = query?.limit ?? DEFAULT_LIMIT;
    let rows = [...this.#revisions.values()];
    if (query?.id !== undefined) {
      rows = rows.filter((r) => r.id === query.id);
      return Promise.resolve(rows);
    }
    if (query?.file_path !== undefined) {
      rows = rows.filter((r) => r.file_path === query.file_path);
    }
    if (query?.repo !== undefined) {
      rows = rows.filter((r) => r.repo === query.repo);
    }
    rows.sort(
      (a, b) =>
        (b.captured_at ?? "").localeCompare(a.captured_at ?? "") || b.id - a.id,
    );
    return Promise.resolve(rows.slice(0, limit));
  }

  deltasFor(revisionId: number): Promise<RevisionDeltaRow[]> {
    return Promise.resolve(
      [...this.#deltas.values()]
        .filter((d) => d.revision_id === revisionId)
        .sort((a, b) => a.id - b.id),
    );
  }

  counts(): Promise<{ revisions: number; deltas: number }> {
    return Promise.resolve({
      revisions: this.#revisions.size,
      deltas: this.#deltas.size,
    });
  }
}
