/**
 * PgBodyClient — the sovereign-store {@link BodyClient} (C2, the facet carve).
 *
 * Bodies live in Calliope's own PostgreSQL (`calliope-db`), not as substrate
 * triples in Chaos: one `sections` table with copy-on-write lineage. Semantics
 * mirror the substrate client exactly as observed through the BodyClient
 * contract — reads sort by `order_key` COLLATE "C"; a coarse save mints a
 * fresh fractional key sequence and deactivates the prior version rows; a
 * single-section edit keeps its `order_key`, mints a fresh 64-hex id, and
 * records the superseded row (`supersedes`) with the old row kept inactive
 * as the prior version.
 *
 * Provenance: `authored_by` is persisted per section version. The default is
 * `"human"`, matching the live backends' historical default (the gateway
 * `SET ROLE human` seam); service-internal writers pass `"calliope"`.
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  AppliedOp,
  ApplySectionOpsResult,
  BodyClient,
  RevisionMeta,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";
import type { AuthoredBy } from "./urania-client.js";
import { sequence } from "./order-key.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sections (
  id          text NOT NULL,
  node_id     text NOT NULL,
  text        text NOT NULL,
  order_key   text NOT NULL,
  authored_by text NOT NULL DEFAULT 'human',
  active      boolean NOT NULL DEFAULT true,
  supersedes  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Composite key: the substrate allows one section OBJECT to be hasPart of
  -- several owners (the ULID node + its content-hash twin share sections), so
  -- a section row is per (owner, section) — id alone is NOT unique. (Found by
  -- the C2 parity gate: 15 twin owners read back empty under an id-only PK.)
  PRIMARY KEY (node_id, id)
);
CREATE INDEX IF NOT EXISTS sections_node_active
  ON sections (node_id, order_key COLLATE "C") WHERE active;
-- A11 lineage metadata: a delete op writes a tombstone row (supersedes = the
-- removed id) so as-of reconstruction sees the removal; tombstones carry no
-- content and never surface in reads. Idempotent, default false — every
-- pre-A11 row is a content row.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS tombstone boolean NOT NULL DEFAULT false;
`;

/** Mint a section placement id: 64-hex, collision-safe via a random nonce. */
function mintSectionId(nodeId: string, text: string, orderKey: string): string {
  return createHash("sha256")
    .update(`${nodeId}\x1f${text}\x1f${orderKey}\x1f${randomUUID()}`, "utf8")
    .digest("hex");
}

/** Row shape read back from the `sections` table. */
interface SectionRow {
  id: string;
  text: string;
  order_key: string;
}

export class PgBodyClient implements BodyClient {
  readonly #pool: Pool;
  readonly #authoredBy: AuthoredBy;

  constructor(pool: Pool, authoredBy: AuthoredBy = "human") {
    this.#pool = pool;
    this.#authoredBy = authoredBy;
  }

  /** Bootstrap the `sections` schema (idempotent — CREATE IF NOT EXISTS). */
  async ensureSchema(): Promise<void> {
    await this.#pool.query(SCHEMA_SQL);
  }

  /**
   * Every node id that currently has a body — the backfill enumeration
   * (`DISTINCT node_id WHERE active`), ordered for a deterministic sweep.
   */
  async listBodyNodeIds(): Promise<string[]> {
    const res = await this.#pool.query<{ node_id: string }>(
      `SELECT DISTINCT node_id FROM sections WHERE active ORDER BY node_id`,
    );
    return res.rows.map((r) => r.node_id);
  }

  async readBody(nodeId: string): Promise<Section[]> {
    const res = await this.#pool.query<SectionRow>(
      `SELECT id, text, order_key FROM sections
        WHERE node_id = $1 AND active
        ORDER BY order_key COLLATE "C", id`,
      [nodeId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      text: r.text,
      orderKey: r.order_key,
    }));
  }

  async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    const keys = sequence(sections.length);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE sections SET active = false WHERE node_id = $1 AND active`,
        [nodeId],
      );
      for (let i = 0; i < sections.length; i++) {
        const text = sections[i]?.text ?? "";
        const orderKey = keys[i] ?? "";
        await client.query(
          `INSERT INTO sections (id, node_id, text, order_key, authored_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            mintSectionId(nodeId, text, orderKey),
            nodeId,
            text,
            orderKey,
            this.#authoredBy,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async editSection(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<SectionRow>(
        `SELECT id, text, order_key FROM sections
          WHERE node_id = $1 AND id = $2 AND active
          FOR UPDATE`,
        [nodeId, sectionId],
      );
      const target = cur.rows[0];
      if (target === undefined) {
        throw new Error(
          `editSection: section ${sectionId} is not part of node ${nodeId}.`,
        );
      }
      const nextId = mintSectionId(nodeId, text, target.order_key);
      await client.query(
        `UPDATE sections SET active = false WHERE node_id = $1 AND id = $2`,
        [nodeId, sectionId],
      );
      await client.query(
        `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [nextId, nodeId, text, target.order_key, this.#authoredBy, sectionId],
      );
      await client.query("COMMIT");
      return { id: nextId, text, orderKey: target.order_key };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A11 block-grain transactional apply — ALL ops or none, one write-event
   * (`now()` is transaction-stable, so every row shares the event stamp).
   *
   * Per-op persistence in the sovereign store's lineage model:
   * - `update`  — the {@link editSection} copy-on-write (fresh id, supersedes
   *               the old row; key kept unless the op carries one);
   * - `reorder` — copy-on-write re-placement (same prose, new key, fresh id —
   *               a placement id names a placement, and a reorder IS one);
   * - `add`     — a new row with `supersedes = ''` (a lineage row that is NOT
   *               a generation marker, so as-of reconstruction keeps earlier
   *               sections);
   * - `delete`  — deactivate + a TOMBSTONE row superseding the removed id, so
   *               reconstruction sees the removal at this event.
   *
   * A `sectionId` that is not currently active rejects the whole batch with
   * a `stale_section` error; a duplicate `sectionId` in one batch rejects as
   * malformed. Nothing is applied on either.
   */
  async applySectionOps(
    nodeId: string,
    ops: SectionOp[],
  ): Promise<ApplySectionOpsResult> {
    const referenced = ops.flatMap((op) =>
      op.op === "add" ? [] : [op.sectionId],
    );
    if (new Set(referenced).size !== referenced.length) {
      throw new Error(
        `applySectionOps: duplicate section id in batch for node ${nodeId}.`,
      );
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<SectionRow>(
        `SELECT id, text, order_key FROM sections
          WHERE node_id = $1 AND active
          FOR UPDATE`,
        [nodeId],
      );
      const byId = new Map(cur.rows.map((r) => [r.id, r]));
      for (const id of referenced) {
        if (!byId.has(id)) {
          throw new Error(
            `stale_section: section ${id} is not part of node ${nodeId}.`,
          );
        }
      }

      const applied: AppliedOp[] = [];
      for (const op of ops) {
        if (op.op === "add") {
          const id = mintSectionId(nodeId, op.text, op.orderKey);
          await client.query(
            `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
             VALUES ($1, $2, $3, $4, $5, '')`,
            [id, nodeId, op.text, op.orderKey, this.#authoredBy],
          );
          applied.push({ id, orderKey: op.orderKey });
          continue;
        }
        const target = byId.get(op.sectionId);
        if (target === undefined) {
          // Unreachable (validated above); throwing keeps `applied` aligned
          // and rolls the transaction back rather than misapplying.
          throw new Error(
            `stale_section: section ${op.sectionId} vanished mid-batch.`,
          );
        }
        await client.query(
          `UPDATE sections SET active = false WHERE node_id = $1 AND id = $2`,
          [nodeId, op.sectionId],
        );
        if (op.op === "delete") {
          const stone = mintSectionId(nodeId, "", target.order_key);
          await client.query(
            `INSERT INTO sections
               (id, node_id, text, order_key, authored_by, supersedes, active, tombstone)
             VALUES ($1, $2, '', $3, $4, $5, false, true)`,
            [stone, nodeId, target.order_key, this.#authoredBy, op.sectionId],
          );
          applied.push({ id: target.id, orderKey: target.order_key });
          continue;
        }
        const text = op.op === "update" ? op.text : target.text;
        const orderKey =
          op.op === "reorder" ? op.orderKey : (op.orderKey ?? target.order_key);
        const nextId = mintSectionId(nodeId, text, orderKey);
        await client.query(
          `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [nextId, nodeId, text, orderKey, this.#authoredBy, op.sectionId],
        );
        applied.push({ id: nextId, orderKey });
      }

      const post = await client.query<SectionRow>(
        `SELECT id, text, order_key FROM sections
          WHERE node_id = $1 AND active
          ORDER BY order_key COLLATE "C", id`,
        [nodeId],
      );
      await client.query("COMMIT");
      return {
        sections: post.rows.map((r) => ({
          id: r.id,
          text: r.text,
          orderKey: r.order_key,
        })),
        applied,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * List the body's write-events, newest first (A8 — the history surface).
   * One event = one distinct `created_at` (rows written in one transaction
   * share it). `kind` is `"save"` when the event minted a fresh generation
   * (any row with `supersedes IS NULL`), `"edit"` for a single-section
   * copy-on-write edit. Reconstruction needs no schema change — the lineage
   * columns (`supersedes`, `created_at`, `authored_by`) already carry it.
   */
  async readRevisions(nodeId: string, limit = 50): Promise<RevisionMeta[]> {
    const res = await this.#pool.query<{
      revision: string;
      is_save: boolean;
      is_ops: boolean;
      authored_by: string;
      sections: number;
    }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision,
              bool_or(supersedes IS NULL) AS is_save,
              -- A11 batch signature: any add ('' supersedes), any tombstone,
              -- or several rows in one non-generation event.
              (count(*) > 1
               OR bool_or(tombstone)
               OR bool_or(supersedes = '')) AS is_ops,
              max(authored_by) AS authored_by,
              count(*)::int AS sections
         FROM sections
        WHERE node_id = $1
        GROUP BY created_at
        ORDER BY created_at DESC
        LIMIT $2`,
      [nodeId, limit],
    );
    return res.rows.map((r) => ({
      revision: r.revision,
      kind: r.is_save ? "save" : r.is_ops ? "ops" : "edit",
      authoredBy: r.authored_by,
      sections: r.sections,
    }));
  }

  /**
   * Reconstruct the body as of the write-event `revision` (an ISO timestamp
   * from {@link readRevisions}): take the latest fresh generation at or
   * before T (`supersedes IS NULL` rows), then let edit chains created at or
   * before T win over the rows they supersede. A revision predating the
   * body's first save yields `[]`.
   */
  async readRevisionAt(nodeId: string, revision: string): Promise<Section[]> {
    const res = await this.#pool.query<SectionRow>(
      `WITH gen AS (
         SELECT max(created_at) AS t0 FROM sections
          WHERE node_id = $1 AND supersedes IS NULL AND created_at <= $2
       )
       SELECT s.id, s.text, s.order_key
         FROM sections s, gen
        WHERE s.node_id = $1
          AND s.created_at <= $2
          AND s.created_at >= gen.t0
          AND NOT s.tombstone
          AND NOT EXISTS (
            SELECT 1 FROM sections r
             WHERE r.node_id = $1 AND r.supersedes = s.id
               AND r.created_at <= $2
          )
        ORDER BY s.order_key COLLATE "C", s.id`,
      [nodeId, revision],
    );
    return res.rows.map((r) => ({
      id: r.id,
      text: r.text,
      orderKey: r.order_key,
    }));
  }

  /**
   * Migration-only insert: land a section row preserving its EXISTING id and
   * order key (the substrate's), marking provenance. Idempotent — an id
   * already present is left untouched (`ON CONFLICT DO NOTHING`).
   */
  async importSection(
    nodeId: string,
    section: Section,
    authoredBy: AuthoredBy = "calliope",
  ): Promise<void> {
    await this.#pool.query(
      `INSERT INTO sections (id, node_id, text, order_key, authored_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (node_id, id) DO NOTHING`,
      [section.id, nodeId, section.text, section.orderKey, authoredBy],
    );
  }

  /**
   * Migration helper: deactivate every active row of `nodeId` that is NOT in
   * `keepIds` — used by the idempotent re-run to converge on the source body.
   */
  async retainOnly(nodeId: string, keepIds: readonly string[]): Promise<void> {
    await this.#pool.query(
      `UPDATE sections SET active = false
        WHERE node_id = $1 AND active AND NOT (id = ANY($2::text[]))`,
      [nodeId, [...keepIds]],
    );
  }
}
