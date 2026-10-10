/**
 * The R-D15 witness for the shared aiws:converge core (only write what
 * changed), the TypeScript peer of mnemosyne's `internal/converge`.
 *
 * notes-sink's hand-written reconcile decides and writes; after it has, the
 * core is asked the same question over the held snapshot read BEFORE the
 * write, and every {legacy, core} difference is counted, never acted on. A
 * core that cannot answer is a counted fault, never a changed answer.
 *
 * CALLIOPE_CONVERGE_MODE is this star's own switch: `legacy` (the core is not
 * called) or `witness` (the default). `enforce` is the later flip; this slice
 * only witnesses, so a request for it runs as witness.
 *
 * Witnessed: the note's attribute slots (provenance, extra, additive). NOT
 * witnessed: the body (calliope's container, the declared carve-out) and
 * inline tags (their own reconcile).
 */

import { decideFacts } from "@forge/stellar-core-ts/convergecore";
import type { FactsQuery, Slot } from "@forge/stellar-core-ts/convergecore";

import { graphToken, type ChaosOp } from "./chaos-client.js";

export const ENV_MODE = "CALLIOPE_CONVERGE_MODE";
const AUTHOR = "calliope";

/** Disagreement cases; all three gate the enforce flip. */
export const CASES = ["outcome", "ops", "refusal"] as const;
export type Case = (typeof CASES)[number];

/** `legacy` (core not called) or `witness`. Anything else is witness. */
export function convergeMode(
  env: NodeJS.ProcessEnv = process.env,
): "legacy" | "witness" {
  return env[ENV_MODE] === "legacy" ? "legacy" : "witness";
}

/** One comparable fact op. */
export interface FactOp {
  kind: "add" | "retract";
  p: string;
  o: string;
  node: boolean;
}

/** A held outbound edge, with the scope it lives in ("" = the write scope). */
export interface HeldEdge {
  predicate: string;
  value: string;
  isNode: boolean;
  graph?: string;
}

const counters = {
  calls: 0,
  faults: 0,
  dis: { outcome: 0, ops: 0, refusal: 0 } as Record<Case, number>,
};

/** Counters as heartbeat metrics: always present, zero until counted. */
export function convergeMetrics(): Record<string, number> {
  return {
    calliope_converge_core_calls_total: counters.calls,
    calliope_converge_core_faults_total: counters.faults,
    calliope_converge_core_disagreements_outcome_total: counters.dis.outcome,
    calliope_converge_core_disagreements_ops_total: counters.dis.ops,
    calliope_converge_core_disagreements_refusal_total: counters.dis.refusal,
    // This build only witnesses: legacy acts.
    calliope_converge_core_enforcing: 0,
  };
}

/** Zero the counters (tests). */
export function resetConvergeMetrics(): void {
  counters.calls = 0;
  counters.faults = 0;
  counters.dis = { outcome: 0, ops: 0, refusal: 0 };
}

/** Reduce admitted edge ops to comparable fact ops (other ops are skipped). */
export function factOps(ops: readonly ChaosOp[]): FactOp[] {
  const out: FactOp[] = [];
  for (const op of ops) {
    if (op.op !== "addEdge" && op.op !== "removeEdge") continue;
    const toNode = op.to_node;
    const node = typeof toNode === "string";
    const lit = op.to_literal;
    const o = node ? toNode : typeof lit === "string" ? lit : "";
    out.push({
      kind: op.op === "addEdge" ? "add" : "retract",
      p: String(op.predicate),
      o,
      node,
    });
  }
  return out;
}

/** What the legacy path did, for one note. */
export interface Observation {
  /** The note's name (its identity). */
  name: string;
  /** Node tokens holding the name now; empty for a mint. */
  holders: string[];
  /** The write scope. */
  scope: string;
  /** Wanted single-valued slots and add-only (additive) pairs. */
  one: ReadonlyMap<string, string>;
  additive: readonly (readonly [string, string])[];
  /** Held edges read BEFORE the legacy write (empty for a mint). */
  held: readonly HeldEdge[];
  legacyOutcome: "unchanged" | "created" | "updated";
  legacyOps: readonly FactOp[];
}

/** Build the core's query for one observation. */
export function buildQuery(o: Observation): FactsQuery {
  const slots: Slot[] = [...o.one.keys()].map((p) => ({
    s: o.name,
    p,
    mode: "one",
    ack: "",
  }));
  const addPreds = new Set(o.additive.map(([p]) => p));
  for (const p of addPreds) {
    if (!o.one.has(p)) {
      slots.push({ s: o.name, p, mode: "add-only", ack: "" });
    }
  }
  const owned = new Set(slots.map((s) => s.p));
  return {
    author: AUTHOR,
    dry: false,
    reach: { writeGraph: o.scope, anyGraph: false, drainGraphs: [] },
    consent: "off",
    birthAck: "",
    acks: [],
    subjects: [
      {
        key: o.name,
        holders: o.holders,
        heldLabel: o.holders.length > 0 ? o.name : "",
        wantedLabel: o.holders.length > 0 ? "" : o.name,
      },
    ],
    slots,
    wanted: [
      ...[...o.one].map(([p, v]) => ({
        s: o.name,
        p,
        o: v,
        g: o.scope,
        node: false,
      })),
      ...o.additive.map(([p, v]) => ({
        s: o.name,
        p,
        o: v,
        g: o.scope,
        node: false,
      })),
    ],
    held: o.held
      .filter((e) => owned.has(e.predicate))
      .map((e) => ({
        s: o.name,
        p: e.predicate,
        o: e.value,
        // A placed read names the scope by token; the query names it by name.
        g:
          e.graph === undefined ||
          e.graph === "" ||
          e.graph === graphToken(o.scope)
            ? o.scope
            : e.graph,
        node: e.isNode,
      })),
    faults: [],
    lineage: [],
    heldLineage: [],
    bodies: [],
    cues: [],
  };
}

/** The ops one side has more of than the other, counting repeats. */
function differing(
  legacy: readonly FactOp[],
  core: readonly FactOp[],
): FactOp[] {
  const same = (a: FactOp, b: FactOp): boolean =>
    a.kind === b.kind && a.p === b.p && a.o === b.o && a.node === b.node;
  const legacyOnly = [...legacy];
  const coreOnly: FactOp[] = [];
  for (const op of core) {
    const i = legacyOnly.findIndex((l) => same(l, op));
    if (i < 0) coreOnly.push(op);
    else legacyOnly.splice(i, 1);
  }
  return [...legacyOnly, ...coreOnly];
}

/** Name the disagreement, or undefined when legacy and core agree. */
export function classify(
  o: Observation,
  answer: ReturnType<typeof decideFacts>,
): { kase: Case; why: string } | undefined {
  if ("err" in answer) {
    return {
      kase: "refusal",
      why: `core refused a write legacy made: ${answer.err.code}`,
    };
  }
  const r = answer.ok;
  if (r.verdict !== "holds") {
    return {
      kase: "outcome",
      why: `core's verdict is ${r.verdict}, legacy wrote`,
    };
  }
  const core: FactOp[] = r.ops
    .filter((op) => op.kind !== "relabel")
    .map((op) => ({
      kind: op.kind === "add" ? "add" : "retract",
      p: op.p,
      o: op.o,
      node: op.node,
    }));
  const differ = differing(o.legacyOps, core);
  const sameOutcome = o.legacyOutcome === r.outcome;
  if (sameOutcome && differ.length === 0) return undefined;
  // Kinds and predicates only: a value can be a title or a path.
  const preds = [...new Set(differ.map((d) => `${d.kind} ${d.p}`))]
    .sort()
    .join(", ");
  return {
    kase: sameOutcome ? "ops" : "outcome",
    why: `legacy ${o.legacyOutcome}, core ${r.outcome}; differing ops [${preds}]`,
  };
}

/**
 * Ask the core and compare. Never changes the caller's answer and never
 * throws: a core that cannot answer is a counted fault.
 */
export function observe(
  o: Observation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (convergeMode(env) === "legacy") return;
  counters.calls += 1;
  try {
    const found = classify(o, decideFacts(buildQuery(o)));
    if (found !== undefined) {
      counters.dis[found.kase] += 1;
      console.warn(
        `converge witness: legacy and core disagree case=${found.kase} why=${found.why}`,
      );
    }
  } catch (err) {
    counters.faults += 1;
    console.error(
      `converge witness: core did not answer; the legacy answer stands: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
