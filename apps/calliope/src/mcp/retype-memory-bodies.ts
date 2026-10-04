#!/usr/bin/env bun
/**
 * One-off backfill: retype mnemosyne's body containers from hasType "Note"
 * to hasType "Memory" on the notes graph.
 *
 * mnemosyne writes each memory's prose into a calliope container titled
 * `memory:<scope>:<name>`. Before create_note took a `type`, every one of
 * them carried hasType "Note", so they all sat in the Notes extent. New
 * bodies now mint as Memory; this moves the standing ones.
 *
 * Only the hasType edge moves. The node's kind stays Note: `(Note, title)` is
 * create_note's reuse key, so a different kind would mint a twin on the next
 * body write. Shapes govern by nodes.kind, so the Memory shape's required
 * fields never apply to these nodes.
 *
 * Run in the calliope pod, like cleanup-tags (env: `CALLIOPE_CHAOS_URL`,
 * `CALLIOPE_THEMIS_URL`, `CALLIOPE_NOTES_SCOPE`):
 *
 *   bun run src/mcp/retype-memory-bodies.ts --probe       # dry run
 *   bun run src/mcp/retype-memory-bodies.ts [--batch N]   # apply
 *   bun run src/mcp/retype-memory-bodies.ts --revert < log.json
 *
 * Each mode prints one JSON document on stdout. The apply document IS the
 * revert log: every batch's tx and node ids. Idempotent: a node already
 * Memory-only is not selected again, and a node holding both types only
 * loses the Note edge.
 */

import { pathToFileURL } from "node:url";
import {
  LiveChaosDial,
  notesScope,
  opAdd,
  opRemove,
  type ChaosDial,
  type ChaosOp,
} from "../chaos-client.js";

export const FROM_TYPE = "Note";
export const TO_TYPE = "Memory";
/** mnemosyne's body.ContainerTitle: `memory:<scope>:<name>`. */
export const BODY_TITLE = /^memory:[^:\s]+:./;

export interface Candidate {
  id: string;
  label: string;
  /** True when the node already carries hasType Memory (a half retype). */
  hasTarget: boolean;
}

export interface BatchRecord {
  tx: number | null;
  ids: string[];
}

export interface RetypeLog {
  graph: string;
  predicate: "hasType";
  from: string;
  to: string;
  probe: boolean;
  /** Nodes with hasType Note before the run. */
  note_extent: number;
  selected: number;
  by_scope: Record<string, number>;
  batches: BatchRecord[];
  nodes?: { id: string; label: string }[];
}

async function labelsOf(
  dial: ChaosDial,
  ids: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 500) {
    Object.assign(out, await dial.resolveNodes(ids.slice(i, i + 500)));
  }
  return out;
}

/** The body containers still typed Note, sorted by id. */
export async function selectCandidates(
  dial: ChaosDial,
  scope: string,
): Promise<{ extent: number; candidates: Candidate[] }> {
  const notes = await dial.findByValue(scope, "hasType", FROM_TYPE);
  const already = new Set(await dial.findByValue(scope, "hasType", TO_TYPE));
  const labels = await labelsOf(dial, notes);
  const candidates = notes
    .filter((id) => BODY_TITLE.test(labels[id] ?? ""))
    .sort()
    .map((id) => ({ id, label: labels[id] ?? "", hasTarget: already.has(id) }));
  return { extent: notes.length, candidates };
}

function retypeOps(c: Candidate): ChaosOp[] {
  const ops = [opRemove(c.id, "hasType", { toLiteral: FROM_TYPE })];
  if (!c.hasTarget) ops.push(opAdd(c.id, "hasType", { toLiteral: TO_TYPE }));
  return ops;
}

/** Plan, and unless probing apply, in batches of `batch` nodes. */
export async function retype(
  dial: ChaosDial,
  scope: string,
  opts: { probe: boolean; batch: number },
): Promise<RetypeLog> {
  const { extent, candidates } = await selectCandidates(dial, scope);
  const byScope: Record<string, number> = {};
  for (const c of candidates) {
    const s = c.label.split(":")[1] ?? "";
    byScope[s] = (byScope[s] ?? 0) + 1;
  }
  const log: RetypeLog = {
    graph: scope,
    predicate: "hasType",
    from: FROM_TYPE,
    to: TO_TYPE,
    probe: opts.probe,
    note_extent: extent,
    selected: candidates.length,
    by_scope: byScope,
    batches: [],
  };
  if (opts.probe) {
    log.nodes = candidates.map(({ id, label }) => ({ id, label }));
    return log;
  }
  for (let i = 0; i < candidates.length; i += opts.batch) {
    const chunk = candidates.slice(i, i + opts.batch);
    const res = await dial.admit(chunk.flatMap(retypeOps), scope);
    if (!res.admitted) {
      // The log so far is the revert record for what DID land.
      throw new RetypeRefused(log, res.violations);
    }
    log.batches.push({ tx: res.tx ?? null, ids: chunk.map((c) => c.id) });
  }
  return log;
}

export class RetypeRefused extends Error {
  constructor(
    readonly log: RetypeLog,
    readonly violations: unknown[],
  ) {
    super(`the gate refused a batch: ${JSON.stringify(violations)}`);
  }
}

/** Undo an apply log: each node back to hasType Note, batch by batch. */
export async function revert(
  dial: ChaosDial,
  scope: string,
  log: Pick<RetypeLog, "batches">,
): Promise<BatchRecord[]> {
  const out: BatchRecord[] = [];
  for (const b of log.batches) {
    const ops = b.ids.flatMap((id) => [
      opRemove(id, "hasType", { toLiteral: TO_TYPE }),
      opAdd(id, "hasType", { toLiteral: FROM_TYPE }),
    ]);
    const res = await dial.admit(ops, scope);
    if (!res.admitted) {
      throw new Error(
        `revert of tx ${String(b.tx)} refused: ${JSON.stringify(res.violations)}`,
      );
    }
    out.push({ tx: res.tx ?? null, ids: b.ids });
  }
  return out;
}

export interface RetypeDeps {
  dial?: ChaosDial;
  write?: (line: string) => void;
  stdin?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The value after `--batch`, default 200; refuses a non-positive one. */
export function batchSize(argv: readonly string[]): number {
  const at = argv.indexOf("--batch");
  if (at === -1) return 200;
  const n = Number(argv[at + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--batch needs a positive integer");
  }
  return n;
}

export async function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  deps: RetypeDeps = {},
): Promise<void> {
  const dial = deps.dial ?? new LiveChaosDial();
  const scope = notesScope(env);
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  if (argv.includes("--revert")) {
    const read = deps.stdin ?? readStdin;
    const log = JSON.parse(await read()) as Pick<RetypeLog, "batches">;
    const reverted = await revert(dial, scope, log);
    write(`${JSON.stringify({ reverted })}\n`);
    return;
  }
  const probe = argv.includes("--probe");
  try {
    const log = await retype(dial, scope, { probe, batch: batchSize(argv) });
    write(`${JSON.stringify(log)}\n`);
  } catch (err) {
    if (err instanceof RetypeRefused) {
      write(`${JSON.stringify({ ...err.log, refused: err.violations })}\n`);
    }
    throw err;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // Exit explicitly: the dial's X509Source holds a Workload API stream open,
  // which keeps the event loop (and the kubectl exec) alive after main.
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(
        `retype-memory-bodies: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
