/**
 * The tag mirror (C9) — Calliope's own index over the tags it writes.
 *
 * The GRAPH is the truth (`hasTag` edges on `graph:notes`); this pg table is
 * the sole-writer's mirror, carrying what the graph doesn't: per-tag write
 * PROVENANCE (`inline` vs `explicit` — the explicit-survival substrate) and
 * the cheap DISTINCT enumeration `list_tags` needs (no chaos verb enumerates
 * distinct literal values). Drift heals on a note's next reconcile; the
 * table is rebuildable from the graph.
 */

import type { Pool } from "pg";
import type { TagRow } from "./tags.js";

/** One distinct tag with its carrier count. */
export interface TagCount {
  tag: string;
  count: number;
}

/** The mirror's surface — fixture-implementable. */
export interface TagStore {
  byNode(nodeId: string): Promise<TagRow[]>;
  upsert(nodeId: string, tag: string, source: TagRow["source"]): Promise<void>;
  remove(nodeId: string, tag: string): Promise<void>;
  distinct(): Promise<TagCount[]>;
}

/** The pg mirror on the sovereign store's shared pool. */
export class PgTagStore implements TagStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS note_tags (
         node_id text NOT NULL,
         tag     text NOT NULL,
         source  text NOT NULL CHECK (source IN ('inline', 'explicit')),
         PRIMARY KEY (node_id, tag)
       )`,
    );
  }

  async byNode(nodeId: string): Promise<TagRow[]> {
    const res = await this.pool.query<{ tag: string; source: string }>(
      "SELECT tag, source FROM note_tags WHERE node_id = $1 ORDER BY tag",
      [nodeId],
    );
    return res.rows.map((r) => ({
      tag: r.tag,
      source: r.source === "explicit" ? "explicit" : "inline",
    }));
  }

  async upsert(
    nodeId: string,
    tag: string,
    source: TagRow["source"],
  ): Promise<void> {
    // An existing row keeps its provenance (explicit wins; a re-add never
    // demotes explicit to inline).
    await this.pool.query(
      `INSERT INTO note_tags (node_id, tag, source) VALUES ($1, $2, $3)
       ON CONFLICT (node_id, tag) DO NOTHING`,
      [nodeId, tag, source],
    );
  }

  async remove(nodeId: string, tag: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM note_tags WHERE node_id = $1 AND tag = $2",
      [nodeId, tag],
    );
  }

  async distinct(): Promise<TagCount[]> {
    const res = await this.pool.query<{ tag: string; count: string }>(
      "SELECT tag, COUNT(*)::text AS count FROM note_tags GROUP BY tag ORDER BY tag",
    );
    return res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }
}

/** In-memory mirror for tests + the standalone fixture server. */
export class FixtureTagStore implements TagStore {
  private readonly rows = new Map<string, Map<string, TagRow["source"]>>();

  byNode(nodeId: string): Promise<TagRow[]> {
    const m = this.rows.get(nodeId) ?? new Map<string, TagRow["source"]>();
    return Promise.resolve(
      [...m.entries()]
        .map(([tag, source]) => ({ tag, source }))
        .sort((a, b) => a.tag.localeCompare(b.tag)),
    );
  }

  upsert(nodeId: string, tag: string, source: TagRow["source"]): Promise<void> {
    const m = this.rows.get(nodeId) ?? new Map<string, TagRow["source"]>();
    if (!m.has(tag)) {
      m.set(tag, source);
    }
    this.rows.set(nodeId, m);
    return Promise.resolve();
  }

  remove(nodeId: string, tag: string): Promise<void> {
    this.rows.get(nodeId)?.delete(tag);
    return Promise.resolve();
  }

  distinct(): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const m of this.rows.values()) {
      for (const tag of m.keys()) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Promise.resolve(
      [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => a.tag.localeCompare(b.tag)),
    );
  }
}
