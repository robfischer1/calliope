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
import { Pool, type PoolClient } from "pg";
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
import { between, sequence } from "./order-key.js";

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
-- F1 lineage join table: one row per (successor, predecessor) edge within an
-- owning node, so a merge (A+B->C) can record N predecessors — inexpressible
-- in the single supersedes column. The column stays (and is still written)
-- until F3 cuts the verb surface over; from F1 on it is a denormalization and
-- this table is the authoritative edge source (readRevisionAt consults it).
CREATE TABLE IF NOT EXISTS supersessions (
  successor_id   text NOT NULL,
  predecessor_id text NOT NULL,
  node_id        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, successor_id, predecessor_id)
);
CREATE INDEX IF NOT EXISTS supersessions_predecessor
  ON supersessions (node_id, predecessor_id);
-- Idempotent backfill: every historical superseding row (edit / reorder /
-- tombstone-delete) becomes an edge stamped with its own created_at, so
-- backfilled and dual-written edges are indistinguishable. Add markers
-- (supersedes = '') are NOT edges and never backfill.
INSERT INTO supersessions (successor_id, predecessor_id, node_id, created_at)
SELECT id, supersedes, node_id, created_at
  FROM sections
 WHERE supersedes IS NOT NULL AND supersedes <> ''
ON CONFLICT (node_id, successor_id, predecessor_id) DO NOTHING;
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

  async saveBody(
    nodeId: string,
    sections: SectionInput[],
    authoredBy?: AuthoredBy,
  ): Promise<void> {
    const author = authoredBy ?? this.#authoredBy;
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
            author,
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
    authoredBy?: AuthoredBy,
  ): Promise<Section> {
    const author = authoredBy ?? this.#authoredBy;
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
      // F4: a byte-identical re-submit is a no-op — no row, no lineage edge,
      // no revision event, same id back. Decided in-transaction (under the
      // FOR UPDATE lock), so a racing real edit cannot be swallowed.
      if (target.text === text) {
        await client.query("COMMIT");
        return { id: target.id, text: target.text, orderKey: target.order_key };
      }
      const nextId = mintSectionId(nodeId, text, target.order_key);
      await client.query(
        `UPDATE sections SET active = false WHERE node_id = $1 AND id = $2`,
        [nodeId, sectionId],
      );
      await client.query(
        `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [nextId, nodeId, text, target.order_key, author, sectionId],
      );
      await this.#writeEdge(client, nodeId, nextId, sectionId);
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
    authoredBy?: AuthoredBy,
  ): Promise<ApplySectionOpsResult> {
    const author = authoredBy ?? this.#authoredBy;
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
            [id, nodeId, op.text, op.orderKey, author],
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
            [stone, nodeId, target.order_key, author, op.sectionId],
          );
          await this.#writeEdge(client, nodeId, stone, op.sectionId);
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
          [nextId, nodeId, text, orderKey, author, op.sectionId],
        );
        await this.#writeEdge(client, nodeId, nextId, op.sectionId);
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
   * F3 identity-preserving split — see {@link BodyClient.splitSection}. One
   * transaction: the original deactivates; two fresh children land (first
   * keeps the key, second takes `between(target, next)`), each carrying
   * `supersedes = original` in the column AND a join-table edge, so the
   * original's anchors resolve forward to both.
   */
  async splitSection(
    nodeId: string,
    sectionId: string,
    offset: number,
    authoredBy?: AuthoredBy,
  ): Promise<[Section, Section]> {
    const author = authoredBy ?? this.#authoredBy;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(
        `bad_offset: split offset must be a non-negative integer (got ${String(offset)}).`,
      );
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<SectionRow>(
        `SELECT id, text, order_key FROM sections
          WHERE node_id = $1 AND active
          ORDER BY order_key COLLATE "C", id
          FOR UPDATE`,
        [nodeId],
      );
      const idx = cur.rows.findIndex((r) => r.id === sectionId);
      const target = idx >= 0 ? cur.rows[idx] : undefined;
      if (target === undefined) {
        throw new Error(
          `stale_section: section ${sectionId} is not part of node ${nodeId}.`,
        );
      }
      if (offset > target.text.length) {
        throw new Error(
          `bad_offset: ${String(offset)} exceeds the block's length ` +
            `(${String(target.text.length)}).`,
        );
      }
      const next = cur.rows[idx + 1];
      const firstKey = target.order_key;
      const secondKey = between(firstKey, next?.order_key ?? null);
      const firstText = target.text.slice(0, offset);
      const secondText = target.text.slice(offset);
      const firstId = mintSectionId(nodeId, firstText, firstKey);
      const secondId = mintSectionId(nodeId, secondText, secondKey);
      await client.query(
        `UPDATE sections SET active = false WHERE node_id = $1 AND id = $2`,
        [nodeId, sectionId],
      );
      for (const [id, text, key] of [
        [firstId, firstText, firstKey],
        [secondId, secondText, secondKey],
      ] as const) {
        await client.query(
          `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, nodeId, text, key, author, sectionId],
        );
        await this.#writeEdge(client, nodeId, id, sectionId);
      }
      await client.query("COMMIT");
      return [
        { id: firstId, text: firstText, orderKey: firstKey },
        { id: secondId, text: secondText, orderKey: secondKey },
      ];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * F3 identity-preserving merge — see {@link BodyClient.mergeSections}. One
   * transaction: both ADJACENT parents deactivate; one survivor lands at the
   * first parent's key. The single-valued `supersedes` column names the first
   * parent; the join table carries BOTH — the op the column cannot express,
   * which is what F1 exists for.
   */
  async mergeSections(
    nodeId: string,
    firstId: string,
    secondId: string,
    separator = "",
    authoredBy?: AuthoredBy,
  ): Promise<Section> {
    const author = authoredBy ?? this.#authoredBy;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<SectionRow>(
        `SELECT id, text, order_key FROM sections
          WHERE node_id = $1 AND active
          ORDER BY order_key COLLATE "C", id
          FOR UPDATE`,
        [nodeId],
      );
      const iFirst = cur.rows.findIndex((r) => r.id === firstId);
      const iSecond = cur.rows.findIndex((r) => r.id === secondId);
      const first = iFirst >= 0 ? cur.rows[iFirst] : undefined;
      const second = iSecond >= 0 ? cur.rows[iSecond] : undefined;
      if (first === undefined || second === undefined) {
        throw new Error(
          `stale_section: section ${first === undefined ? firstId : secondId} ` +
            `is not part of node ${nodeId}.`,
        );
      }
      if (iSecond !== iFirst + 1) {
        throw new Error(
          `not_adjacent: ${firstId} and ${secondId} are not adjacent in ` +
            `order (merge joins a block with its immediate successor).`,
        );
      }
      const text = first.text + separator + second.text;
      const mergedId = mintSectionId(nodeId, text, first.order_key);
      await client.query(
        `UPDATE sections SET active = false
          WHERE node_id = $1 AND id = ANY($2::text[])`,
        [nodeId, [firstId, secondId]],
      );
      await client.query(
        `INSERT INTO sections (id, node_id, text, order_key, authored_by, supersedes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [mergedId, nodeId, text, first.order_key, author, firstId],
      );
      await this.#writeEdge(client, nodeId, mergedId, firstId);
      await this.#writeEdge(client, nodeId, mergedId, secondId);
      await client.query("COMMIT");
      return { id: mergedId, text, orderKey: first.order_key };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * F8 arc coalescing — collapse an intra-arc supersession chain to its
   * endpoints, physically. Walks backward from the ACTIVE row `blockId`
   * while predecessors are strictly newer than `sinceRevision`, collecting
   * removable intermediates; deletes them (rows + lineage edges) and rewires
   * the final row's lineage — column AND join table — to the walk's stop row.
   *
   * A predecessor is removable ONLY when every guard passes:
   *  - it is inactive, not a tombstone, and newer than the arc start;
   *  - it has exactly ONE predecessor edge and ONE successor edge (no
   *    split/merge fan touches it);
   *  - its creation event wrote exactly ONE row — a pause-edit. A row born
   *    in a multi-row event (a split child, an ops batch) is a BOUNDARY:
   *    deleting it would make its event reconstruct without its siblings.
   *
   * The rewired edge carries the FINAL row's `created_at`, so mid-arc
   * moments reconstruct to the pre-arc state and the endpoints stay
   * byte-exact. Returns `{removed, from, to}`; `removed: 0` when nothing
   * qualifies. The first deliberate deletion in this store — which is why
   * the verb above it ships flag-gated.
   */
  async coalesceArc(
    nodeId: string,
    blockId: string,
    sinceRevision: string,
  ): Promise<{ removed: number; from: string; to: string }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const rowsRes = await client.query<{
        id: string;
        active: boolean;
        tombstone: boolean;
        created_at: Date;
      }>(
        `SELECT id, active, tombstone, created_at FROM sections
          WHERE node_id = $1 FOR UPDATE`,
        [nodeId],
      );
      const rows = new Map(rowsRes.rows.map((r) => [r.id, r]));
      const final = rows.get(blockId);
      if (final?.active !== true) {
        throw new Error(
          `stale_section: block ${blockId} is not an active block of ${nodeId}.`,
        );
      }
      const edgesRes = await client.query<{
        successor_id: string;
        predecessor_id: string;
      }>(
        `SELECT successor_id, predecessor_id FROM supersessions
          WHERE node_id = $1`,
        [nodeId],
      );
      const predsOf = new Map<string, string[]>();
      const succsOf = new Map<string, string[]>();
      for (const e of edgesRes.rows) {
        predsOf.set(e.successor_id, [
          ...(predsOf.get(e.successor_id) ?? []),
          e.predecessor_id,
        ]);
        succsOf.set(e.predecessor_id, [
          ...(succsOf.get(e.predecessor_id) ?? []),
          e.successor_id,
        ]);
      }
      const eventPeers = new Map<number, number>();
      for (const r of rowsRes.rows) {
        const t = r.created_at.getTime();
        eventPeers.set(t, (eventPeers.get(t) ?? 0) + 1);
      }
      const since = new Date(sinceRevision).getTime();

      const removable: string[] = [];
      let to = "";
      let cur = blockId;
      for (;;) {
        const preds = predsOf.get(cur) ?? [];
        if (preds.length !== 1) {
          to = "";
          break;
        }
        const pid = preds[0] ?? "";
        const p = rows.get(pid);
        if (p === undefined) {
          to = pid; // referenced but not stored under this node — endpoint
          break;
        }
        const isBoundary =
          p.created_at.getTime() <= since ||
          p.tombstone ||
          p.active ||
          (succsOf.get(pid) ?? []).length !== 1 ||
          (predsOf.get(pid) ?? []).length !== 1 ||
          (eventPeers.get(p.created_at.getTime()) ?? 0) !== 1;
        if (isBoundary) {
          to = pid;
          break;
        }
        removable.push(pid);
        cur = pid;
      }

      if (removable.length === 0 || to === "") {
        await client.query("COMMIT");
        return { removed: 0, from: blockId, to };
      }

      await client.query(
        `DELETE FROM sections WHERE node_id = $1 AND id = ANY($2::text[])`,
        [nodeId, removable],
      );
      await client.query(
        `DELETE FROM supersessions
          WHERE node_id = $1
            AND (successor_id = ANY($2::text[])
                 OR predecessor_id = ANY($2::text[]))`,
        [nodeId, removable],
      );
      await client.query(
        `UPDATE sections SET supersedes = $3
          WHERE node_id = $1 AND id = $2`,
        [nodeId, blockId, to],
      );
      // The rewired edge carries the FINAL row's stamp (see the doc above).
      await client.query(
        `INSERT INTO supersessions (successor_id, predecessor_id, node_id, created_at)
         SELECT $2, $3, $1, created_at FROM sections
          WHERE node_id = $1 AND id = $2
         ON CONFLICT (node_id, successor_id, predecessor_id) DO NOTHING`,
        [nodeId, blockId, to],
      );
      await client.query("COMMIT");
      return { removed: removable.length, from: blockId, to };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * F1 dual-write: one lineage edge per superseding write, inside the write's
   * own transaction. `created_at` defaults to the transaction-stable `now()`,
   * so the edge and the successor row it describes share the event stamp.
   */
  async #writeEdge(
    client: PoolClient,
    nodeId: string,
    successorId: string,
    predecessorId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO supersessions (successor_id, predecessor_id, node_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (node_id, successor_id, predecessor_id) DO NOTHING`,
      [successorId, predecessorId, nodeId],
    );
  }

  /**
   * F1 (the F3-facing seam): record that `successorId` supersedes each of
   * `predecessorIds` under `nodeId` — N edges in one statement, idempotent
   * re-apply (the PK dedups). A merge records N > 1.
   */
  async recordSupersession(
    nodeId: string,
    successorId: string,
    predecessorIds: readonly string[],
  ): Promise<void> {
    if (predecessorIds.length === 0) return;
    await this.#pool.query(
      `INSERT INTO supersessions (successor_id, predecessor_id, node_id)
       SELECT $1, p, $2 FROM unnest($3::text[]) AS p
       ON CONFLICT (node_id, successor_id, predecessor_id) DO NOTHING`,
      [successorId, nodeId, [...predecessorIds]],
    );
  }

  /**
   * F1 both-direction lineage point query: who does `blockId` supersede, and
   * who supersedes it — under one owner. No recursive walk.
   */
  async lineageOf(
    nodeId: string,
    blockId: string,
  ): Promise<{ predecessors: string[]; successors: string[] }> {
    const [preds, succs] = await Promise.all([
      this.#pool.query<{ predecessor_id: string }>(
        `SELECT predecessor_id FROM supersessions
          WHERE node_id = $1 AND successor_id = $2
          ORDER BY predecessor_id`,
        [nodeId, blockId],
      ),
      this.#pool.query<{ successor_id: string }>(
        `SELECT successor_id FROM supersessions
          WHERE node_id = $1 AND predecessor_id = $2
          ORDER BY successor_id`,
        [nodeId, blockId],
      ),
    ]);
    return {
      predecessors: preds.rows.map((r) => r.predecessor_id),
      successors: succs.rows.map((r) => r.successor_id),
    };
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
          -- F1: the supersession lookup consults the join table (the
          -- authoritative edge source), so N-predecessor merges reconstruct
          -- without another read-path change at F3.
          AND NOT EXISTS (
            SELECT 1 FROM supersessions p
             WHERE p.node_id = $1 AND p.predecessor_id = s.id
               AND p.created_at <= $2
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
