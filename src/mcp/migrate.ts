#!/usr/bin/env node
/**
 * C2 migration tool — carve the prose-body facet out of Chaos into the
 * sovereign store (specs/002-facet-carve-sovereign-store).
 *
 * Modes (run inside the deployed container — it carries both networks + env):
 *
 *   node dist/mcp/migrate.js            # migrate + parity + export (idempotent)
 *   node dist/mcp/migrate.js --probe    # drift probe: count body facets left in Chaos
 *   node dist/mcp/migrate.js --retract  # post-cutover: retract body facets from Chaos
 *                                       #   (refuses without a prior export file)
 *
 * The default run enumerates every `hasPart`-carrying subject in the `moirae`
 * graph (chaos `graph_edges`), copies each body into pg PRESERVING section ids
 * / text / order keys (provenance `calliope` — the substrate does not record
 * per-section authorship on reads), writes a full JSON export artifact, then
 * verifies per-node parity (sha256 over the ordered (order_key, text) list read
 * back from BOTH stores). Any mismatch exits nonzero — the parity gate.
 *
 * Retraction is the point of no return and is gated: it requires the export
 * artifact from a prior clean run to exist, and re-verifies parity before
 * removing anything. It removes, per body owner, the `hasPart` edges, and per
 * section-typed node (current AND superseded versions), the `text` /
 * `order_key` / `hasType` facts.
 */

import { createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { Section } from "../types.js";
import {
  UraniaBodyClient,
  HAS_PART,
  SECTION_TYPE,
  TEXT,
  ORDER_KEY,
} from "../urania-client.js";
import type { UraniaOp } from "../urania-client.js";
import { PgBodyClient } from "../pg-client.js";
import { LiveUraniaCapture, nameHash } from "./live-capture.js";

const MOIRAE = "moirae";
const EXPORT_PATH =
  process.env.EXPORT_PATH ?? "/tmp/calliope-migration-export.json";

/** One enumerated chaos node with full edge fidelity (graph_edges shape). */
interface EdgeNode {
  id: string;
  edges: { predicate: string; value: string; is_node: boolean }[];
}

function contentHashOfBody(sections: readonly Section[]): string {
  const canonical = sections.map((s) => [s.orderKey, s.text]);
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/** Dial chaos `graph_edges` for the full moirae enumeration. */
async function enumerateMoirae(live: LiveUraniaCapture): Promise<EdgeNode[]> {
  // rpc is private; ride the documented tool surface through a tiny shim.
  const rpc = (
    live as unknown as {
      rpc(verb: string, args: Record<string, unknown>): Promise<unknown>;
    }
  ).rpc.bind(live);
  const rows = (await rpc("graph_edges", {
    graph: nameHash(MOIRAE),
  })) as EdgeNode[] | null;
  return rows ?? [];
}

function bodyOwners(nodes: readonly EdgeNode[]): string[] {
  return nodes
    .filter((n) => n.edges.some((e) => e.predicate === HAS_PART))
    .map((n) => n.id);
}

function sectionNodes(nodes: readonly EdgeNode[]): EdgeNode[] {
  return nodes.filter((n) =>
    n.edges.some((e) => e.predicate === "hasType" && e.value === SECTION_TYPE),
  );
}

async function migrate(
  chaosClient: UraniaBodyClient,
  pg: PgBodyClient,
  owners: readonly string[],
): Promise<{ nodes: number; sections: number; mismatches: string[] }> {
  const exportDump: Record<string, Section[]> = {};
  const mismatches: string[] = [];
  let sectionCount = 0;

  for (const nodeId of owners) {
    const source = await chaosClient.readBody(nodeId);
    exportDump[nodeId] = source;
    for (const section of source) {
      await pg.importSection(nodeId, section, "calliope");
    }
    await pg.retainOnly(
      nodeId,
      source.map((s) => s.id),
    );
    sectionCount += source.length;

    const migrated = await pg.readBody(nodeId);
    if (contentHashOfBody(migrated) !== contentHashOfBody(source)) {
      mismatches.push(nodeId);
    }
  }

  writeFileSync(EXPORT_PATH, JSON.stringify(exportDump, null, 2));
  return { nodes: owners.length, sections: sectionCount, mismatches };
}

function probe(nodes: readonly EdgeNode[]): void {
  const owners = bodyOwners(nodes);
  const sections = sectionNodes(nodes);
  const hasPartEdges = nodes
    .flatMap((n) => n.edges)
    .filter((e) => e.predicate === HAS_PART).length;
  process.stdout.write(
    `${JSON.stringify({
      body_owners: owners.length,
      haspart_edges: hasPartEdges,
      section_nodes: sections.length,
    })}\n`,
  );
}

async function retract(
  live: LiveUraniaCapture,
  chaosClient: UraniaBodyClient,
  pg: PgBodyClient,
  nodes: readonly EdgeNode[],
): Promise<void> {
  if (!existsSync(EXPORT_PATH)) {
    throw new Error(
      `--retract refused: export artifact ${EXPORT_PATH} not found — run the migration first.`,
    );
  }
  // Re-verify parity against the live pg store before removing anything.
  const owners = bodyOwners(nodes);
  for (const nodeId of owners) {
    const source = await chaosClient.readBody(nodeId);
    const migrated = await pg.readBody(nodeId);
    if (contentHashOfBody(migrated) !== contentHashOfBody(source)) {
      throw new Error(
        `--retract refused: parity mismatch on ${nodeId} — re-run the migration.`,
      );
    }
  }

  const ops: UraniaOp[] = [];
  for (const node of nodes) {
    for (const edge of node.edges) {
      if (edge.predicate === HAS_PART) {
        ops.push({
          op: "removeEdge",
          from: node.id,
          predicate: HAS_PART,
          to: edge.value,
        });
      }
    }
  }
  for (const section of sectionNodes(nodes)) {
    for (const edge of section.edges) {
      if (
        edge.predicate === TEXT ||
        edge.predicate === ORDER_KEY ||
        (edge.predicate === "hasType" && edge.value === SECTION_TYPE)
      ) {
        ops.push({
          op: "removeEdge",
          from: section.id,
          predicate: edge.predicate,
          to: edge.value,
        });
      }
    }
  }

  // Chunked captures: each capture is one tx; keep batches bounded.
  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    await live.capture(ops.slice(i, i + CHUNK), "calliope");
  }
  process.stdout.write(`${JSON.stringify({ retracted_ops: ops.length })}\n`);
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--retract")
    ? "retract"
    : process.argv.includes("--probe")
      ? "probe"
      : "migrate";

  const chaosUrl = process.env.CHAOS_URL ?? process.env.URANIA_URL;
  process.env.CALLIOPE_URANIA_WIRED = "1";
  const live = new LiveUraniaCapture(chaosUrl);
  const chaosClient = new UraniaBodyClient(live);
  const nodes = await enumerateMoirae(live);

  if (mode === "probe") {
    probe(nodes);
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    throw new Error("DATABASE_URL is required for migrate/retract.");
  }
  const pool = new Pool({ connectionString: dbUrl });
  const pg = new PgBodyClient(pool);
  await pg.ensureSchema();

  try {
    if (mode === "retract") {
      await retract(live, chaosClient, pg, nodes);
      return;
    }
    const result = await migrate(chaosClient, pg, bodyOwners(nodes));
    process.stdout.write(
      `${JSON.stringify({
        migrated_nodes: result.nodes,
        migrated_sections: result.sections,
        parity_mismatches: result.mismatches,
        export: EXPORT_PATH,
      })}\n`,
    );
    if (result.mismatches.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the bin, not when imported by a test — compare the
// resolved entry path (argv[1]) against this module's URL (ESM "is main").
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `migrate: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

export { contentHashOfBody, bodyOwners, sectionNodes };
export type { EdgeNode };
