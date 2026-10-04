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
 * Runs in the calliope pod, under calliope's own SVID and env. The image
 * ships only the bundled server, so bundle this file first and copy it in:
 *
 *   bun build src/mcp/retype-memory-bodies.ts --target=bun --outfile r.js
 *   kubectl -n prime cp r.js <pod>:/tmp/r.js
 *   kubectl -n prime exec <pod> -- bun /tmp/r.js --probe       # dry run
 *   kubectl -n prime exec <pod> -- bun /tmp/r.js [--batch N]   # apply
 *   kubectl -n prime exec -i <pod> -- bun /tmp/r.js --revert < log.json
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
  batches: BatchRecord[];
  nodes?: { id: string; label: string }[];
}

/** How many tokens one resolve_nodes call carries. */
export const RESOLVE_CHUNK = 500;

/** Labels for ids, resolved RESOLVE_CHUNK at a time. */
export async function labelsOf(
  dial: ChaosDial,
  ids: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
    Object.assign(
      out,
      await dial.resolveNodes(ids.slice(i, i + RESOLVE_CHUNK)),
    );
  }
  return out;
}

/** The body containers still typed Note (a node with no label is skipped). */
export async function selectCandidates(
  dial: ChaosDial,
  scope: string,
): Promise<{ extent: number; candidates: Candidate[] }> {
  const notes = await dial.findByValue(scope, "hasType", FROM_TYPE);
  const already = new Set(await dial.findByValue(scope, "hasType", TO_TYPE));
  const candidates = Object.entries(await labelsOf(dial, notes))
    .filter(([, label]) => BODY_TITLE.test(label))
    .map(([id, label]) => ({ id, label, hasTarget: already.has(id) }));
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
  const log: RetypeLog = {
    graph: scope,
    predicate: "hasType",
    from: FROM_TYPE,
    to: TO_TYPE,
    probe: opts.probe,
    note_extent: extent,
    selected: candidates.length,
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

/** The seams the CLI reaches for when not handed them. */
export interface RetypeDeps {
  dial?: ChaosDial;
  write?: (line: string) => void;
  stdin?: AsyncIterable<Uint8Array | string>;
}

/** Drain a byte stream to text (the revert log arrives on stdin). */
export async function readAll(
  source: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
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
  const write = deps.write ?? process.stdout.write.bind(process.stdout);
  if (argv.includes("--revert")) {
    const text = await readAll(deps.stdin ?? process.stdin);
    const log = JSON.parse(text) as Pick<RetypeLog, "batches">;
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

/** The process seams `cli` reaches for when not handed them. */
export interface CliDeps extends RetypeDeps {
  exit?: (code: number) => void;
  stderr?: (line: string) => void;
}

/**
 * Run main and exit with its outcome. The exit is explicit because the
 * live dial's X509Source holds a Workload API stream open, which would keep
 * the event loop (and the kubectl exec) alive after main settles.
 */
export async function cli(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {},
): Promise<void> {
  const exit = deps.exit ?? process.exit.bind(process);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  try {
    await main(argv, env, deps);
    exit(0);
  } catch (err: unknown) {
    stderr(`retype-memory-bodies: fatal: ${String(err)}\n`);
    exit(1);
  }
}

const entry = process.argv[1];
const isEntry =
  entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntry) void cli();
