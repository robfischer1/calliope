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
import type { BodyClient, Section, SectionInput } from "./types.js";
import type { AuthoredBy } from "./urania-client.js";
import { sequence } from "./order-key.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sections (
  id          text PRIMARY KEY,
  node_id     text NOT NULL,
  text        text NOT NULL,
  order_key   text NOT NULL,
  authored_by text NOT NULL DEFAULT 'human',
  active      boolean NOT NULL DEFAULT true,
  supersedes  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sections_node_active
  ON sections (node_id, order_key COLLATE "C") WHERE active;
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
      await client.query(`UPDATE sections SET active = false WHERE id = $1`, [
        sectionId,
      ]);
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
       ON CONFLICT (id) DO NOTHING`,
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
