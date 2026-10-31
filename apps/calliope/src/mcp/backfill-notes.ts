#!/usr/bin/env bun
/**
 * Backfill the consciousness bus with EXISTING notes (absorb-arch-kiss).
 *
 * The live publisher ({@link ConsciousnessPublisher}) fires on a note WRITE,
 * so a container written before the bus carried `metadata.container` (or
 * before a publisher was wired at all) never reached eros's `calliope_notes`
 * slice. This sweep enumerates every note container in the notes graph,
 * projects each one exactly as a write would (`projectNote`), and publishes
 * it through the same publisher — one code path, so a backfilled row is
 * byte-identical to a freshly written one.
 *
 * OPERATOR-RUN ONLY. Nothing in the star's boot or deploy path imports or
 * invokes this file; it is a standalone `bun run`, like the other CLIs.
 *
 *   bun run src/mcp/backfill-notes.ts --dry-run          # counts only, no broker
 *   bun run src/mcp/backfill-notes.ts                    # publish everything
 *   bun run src/mcp/backfill-notes.ts --batch-size 50 --pause-ms 2000
 *
 * Run from a checkout that can reach the sovereign store and the chaos door
 * AND the broker — NOT the deployed image (it ships only the bundled
 * `server.js`; there is no source tree and no `bun install` inside it).
 *
 * Env (same as the star): DATABASE_URL / STELLAR_DB_AUTH (the store),
 * CHAOS_URL + the notes scope env (the graph), KAFKA_BOOTSTRAP (the broker;
 * required unless --dry-run; CALLIOPE_CONSCIOUSNESS_EMIT=0 refuses).
 *
 * IDEMPOTENT. A row's compaction key is `calliope_notes:<source_id>` with
 * `source_id = blake2b-8(styx://<node>) & (2^63-1)` — a function of the node
 * alone — so re-publishing a container upserts the same eros row, and a
 * second run (or a run overlapping live writes) only rewrites rows.
 *
 * SKIPS, never retracts: a suppressed (hidden) note is counted and left
 * alone, as is a container with no prose. The sweep pages the node list in
 * `--batch-size` slices and sleeps `--pause-ms` between slices so the bus and
 * eros's consumer are not hit in one burst. A per-note failure is tallied and
 * the sweep continues; any failure sets exit code 1. The last stdout line is
 * one JSON summary.
 */

import { pathToFileURL } from "node:url";
import { suppressedNotes } from "../note-suppress.js";
import type { NoteProjection, NotePublisher } from "./consciousness-emit.js";
import { makeConsciousnessPublisher } from "./consciousness-emit.js";
import { prepareBackend } from "./backend.js";
import { projectNote } from "./note-projection.js";

export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_PAUSE_MS = 1000;

/** What the sweep needs from the store — satisfied by the real facet or a double. */
export interface NoteSource {
  /** Every note container id (any order; the sweep sorts). */
  list(): Promise<string[]>;
  /** The suppressed notes — left alone. */
  hidden(): Promise<ReadonlySet<string>>;
  /** The projection a write would publish; `undefined` = no prose. */
  project(node: string): Promise<NoteProjection | undefined>;
}

export interface BackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
  pauseMs?: number;
  /** Test seam; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress sink (one line per batch); defaults to none. */
  log?: (line: string) => void;
}

export interface BackfillSummary {
  dryRun: boolean;
  containers: number;
  suppressed: number;
  empty: number;
  published: number;
  failed: number;
  batches: number;
}

export interface CliArgs {
  dryRun: boolean;
  batchSize: number;
  pauseMs: number;
}

function intFlag(name: string, raw: string | undefined, min: number): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < min) {
    throw new Error(`${name} needs an integer >= ${String(min)}`);
  }
  return n;
}

/** Parse argv (after the script); unknown flags are refused, never ignored. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    pauseMs: DEFAULT_PAUSE_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--batch-size") {
      i += 1;
      out.batchSize = intFlag("--batch-size", argv[i], 1);
    } else if (arg === "--pause-ms") {
      i += 1;
      out.pauseMs = intFlag("--pause-ms", argv[i], 0);
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publish every note container. `--dry-run` lists and counts only: it reads
 * no container (so `empty` is unknown and reported 0) and never touches the
 * publisher.
 */
export async function backfillNotes(
  source: NoteSource,
  publisher: NotePublisher | undefined,
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const dryRun = opts.dryRun === true;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((): void => undefined);
  if (!dryRun && publisher === undefined) {
    throw new Error("backfill-notes: no publisher (a live run needs a broker)");
  }

  const nodes = [...new Set(await source.list())].sort();
  const hidden = await source.hidden();
  const summary: BackfillSummary = {
    dryRun,
    containers: nodes.length,
    suppressed: 0,
    empty: 0,
    published: 0,
    failed: 0,
    batches: 0,
  };
  if (dryRun) {
    summary.suppressed = nodes.filter((n) => hidden.has(n)).length;
    return summary;
  }

  for (let at = 0; at < nodes.length; at += batchSize) {
    if (summary.batches > 0 && pauseMs > 0) await sleep(pauseMs);
    summary.batches += 1;
    for (const node of nodes.slice(at, at + batchSize)) {
      if (hidden.has(node)) {
        summary.suppressed += 1;
        continue;
      }
      try {
        const projection = await source.project(node);
        if (projection === undefined) {
          summary.empty += 1;
        } else if (await publisher?.publish(projection)) {
          summary.published += 1;
        } else {
          summary.failed += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
    log(
      `batch ${String(summary.batches)}: ${String(Math.min(at + batchSize, nodes.length))}/${String(nodes.length)} seen,` +
        ` ${String(summary.published)} published, ${String(summary.failed)} failed`,
    );
  }
  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const backend = await prepareBackend("pg");
  const facet = backend.containers;
  const chaos = backend.chaos;
  if (facet === undefined || chaos === undefined) {
    throw new Error(
      "backfill-notes: the pg backend carries no container facet",
    );
  }
  const publisher = args.dryRun
    ? undefined
    : makeConsciousnessPublisher(process.env);
  if (!args.dryRun && publisher === undefined) {
    throw new Error(
      "backfill-notes: publishing is off (set KAFKA_BOOTSTRAP; unset CALLIOPE_CONSCIOUSNESS_EMIT=0)",
    );
  }
  const source: NoteSource = {
    list: () => chaos.dial.findByValue(chaos.scope, "hasType", "Note"),
    hidden: () => suppressedNotes(chaos.dial, chaos.scope),
    project: (node) => projectNote(facet, node),
  };
  const summary = await backfillNotes(source, publisher, {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    pauseMs: args.pauseMs,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  // The kafka client holds no close handle here; exit explicitly once the
  // summary is out (every publish above was awaited to the broker's ack).
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
