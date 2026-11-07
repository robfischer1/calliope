/**
 * CALLIOPE_DIRECT_CAPTURE — calliope writes graph facts by chaos `capture` as
 * itself, not through themis `admit` (the strangler migration of the write
 * path; per-star flag, off by default, rollback = unset the flag).
 *
 * Two pure halves, both held to their oracles:
 *
 *  - {@link toDirectCaptureOps}: the capture batch themis WOULD have sent for
 *    the same friendly ops (themis `opsFromWire` + `ops.ToWire`). It is a
 *    sibling of local-admit's `toCaptureOps`, which the desktop sidecar keeps
 *    unchanged: that port ignores an addEdge graph pin (themis honours the
 *    `issues` graph), a pinned removeEdge by NAME, the per-fact `author` and
 *    the `naive` policy.
 *  - {@link classifyRefusal}: the reply contract of stellar-core's
 *    `admitcapture` package. A definite refusal is `admitted:false` with one
 *    violation; ANY OTHER failure is in doubt (the write may have landed) and
 *    must throw, never become a refusal.
 */

import { createHash } from "node:crypto";

import { ChaosClientError, type ChaosOp } from "./chaos-client.js";
import { contentHash } from "./local-admit.js";
import { canonicalInstant, canonicalWallclock } from "./instant.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const UNIT = "\u001f";

/** sha256 hex of the bare graph name `issues` — themis `vocab.IssuesGraph`. */
const ISSUES_GRAPH_HEX = createHash("sha256").update("issues").digest("hex");

/** One translated capture op (chaos's decodeOps dialect). */
export type DirectCaptureOp = Record<string, unknown> & { op: string };

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function bad(detail: string): ChaosClientError {
  return new ChaosClientError(`direct capture: ${detail}`, "bad_result");
}

/**
 * themis `ops.CanonicalLiteral`: the stored form of `value` under `dtype` and
 * the `naive` policy. calliope never sends `naive`; `refuse` (the default) and
 * `utc` are honoured, `eastern` needs a zone table calliope does not carry and
 * is refused loudly rather than guessed.
 */
function canonicalLiteral(value: string, dtype: string, naive: string): string {
  if (naive !== "" && dtype !== "instant") {
    throw bad("naive is legal only with dtype instant");
  }
  if (dtype === "instant") {
    const policy = naive === "" ? "refuse" : naive;
    if (policy === "refuse")
      return stored(canonicalInstant(value), value, dtype);
    if (policy === "utc") {
      const wall = canonicalWallclock(value);
      return stored(
        wall === null ? canonicalInstant(value) : canonicalInstant(`${wall}Z`),
        value,
        dtype,
      );
    }
    if (policy === "eastern") {
      throw bad("naive eastern is not supported by calliope's direct capture");
    }
    throw bad("naive is not one of refuse, utc, eastern");
  }
  if (dtype === "wallclock") {
    return stored(canonicalWallclock(value), value, dtype);
  }
  return value;
}

function stored(
  canonical: string | null,
  value: string,
  dtype: string,
): string {
  if (canonical === null) {
    throw bad(`${JSON.stringify(value)} is not a valid ${dtype} literal`);
  }
  return canonical;
}

/**
 * themis `opsFromWire` + `ToWire` for calliope's friendly ops, one atomic
 * capture batch. Throws a `bad_result` ChaosClientError for anything themis
 * would refuse (empty scope, an edge without exactly one object, a typed
 * literal beside a node/blob target, an unknown op), before anything is sent.
 */
export function toDirectCaptureOps(
  ops: ChaosOp[],
  scope: string,
): DirectCaptureOp[] {
  if (scope === "") {
    throw bad(
      'scope is required — an unbound write lands in name_hash(""), a ' +
        "phantom graph",
    );
  }
  const labels = new Map<string, number>();
  let createIndex = 0;
  for (const op of ops) {
    if (op.op === "createNode") {
      const label = str(op.label);
      if (label !== "" && !labels.has(label)) labels.set(label, createIndex);
      createIndex += 1;
    }
  }
  const ref = (raw: unknown): unknown => {
    const id = str(raw);
    const mint = labels.get(id);
    return mint === undefined ? id : { $mint: mint };
  };
  const out: DirectCaptureOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "createNode":
        out.push({
          op: "createNode",
          label: str(op.label),
          // themis reads node_type first, kind as the fallback.
          kind: str(op.node_type) !== "" ? str(op.node_type) : str(op.kind),
        });
        break;
      case "relabel":
        out.push({ op: "relabel", id: str(op.id), label: str(op.label) });
        break;
      case "addEdge":
      case "removeEdge":
        out.push(...edgeRows(op, scope, ref));
        break;
      default:
        throw bad(`unknown op ${op.op}`);
    }
  }
  return out;
}

function edgeRows(
  op: ChaosOp,
  scope: string,
  ref: (raw: unknown) => unknown,
): DirectCaptureOp[] {
  const present = (v: unknown): boolean => v !== null && v !== undefined;
  const { to_literal: toLiteral, to_node: toNode, to_blob: toBlob } = op;
  const dtype = str(op.dtype);
  const naive = str(op.naive);
  if (
    (dtype !== "" || naive !== "") &&
    (typeof toLiteral !== "string" || present(toNode) || present(toBlob))
  ) {
    throw bad(
      "dtype and naive are legal only beside a to_literal that is a string",
    );
  }
  const set = [toLiteral, toNode, toBlob].filter(present);
  if (set.length !== 1) {
    throw bad(
      `${op.op} needs exactly one of to_literal/to_node/to_blob, got ` +
        String(set.length),
    );
  }
  const rows: DirectCaptureOp[] = [];
  let o: unknown;
  if (present(toBlob)) {
    o = { $blob: str(toBlob) };
  } else if (present(toNode)) {
    o = ref(toNode);
  } else {
    const value = canonicalLiteral(str(toLiteral), dtype, naive);
    if (value.includes(UNIT) || dtype.includes(UNIT)) {
      throw bad("a scalar field carries the 0x1f unit-separator byte");
    }
    rows.push(
      dtype === "" ? { op: "intern", value } : { op: "intern", value, dtype },
    );
    o = contentHash(value, dtype);
  }
  rows.push({
    op: op.op,
    s: ref(op.from_id),
    predicate: str(op.predicate),
    o,
    g: graphOf(op, scope),
    ...(str(op.author) !== "" ? { author: str(op.author) } : {}),
  });
  return rows;
}

/**
 * The graph an edge lands in. A removeEdge pin is honoured whole (a name or a
 * 64-hex token, `RemoveEdge.GraphHex`); an addEdge pin only when it is the
 * `issues` graph (`assertGraph`) — any other graph would slip past the scope
 * gate unseen, so themis ignores it and so do we.
 */
function graphOf(op: ChaosOp, scope: string): string {
  const pin = str(op.graph);
  if (op.op === "removeEdge") return pin !== "" ? pin : scope;
  if (pin.toLowerCase() === ISSUES_GRAPH_HEX && HEX64.test(pin)) {
    return pin.toLowerCase();
  }
  return scope;
}

// --- the reply contract ------------------------------------------------------

/** capture's definite verdicts and the violation check each reports. */
const DEFINITE: ReadonlyMap<string, string> = new Map([
  ["capture_refused", ""],
  ["conflict", "conflict"],
  ["bad_args", "bad_args"],
  ["unsigned_claim", "unsigned_claim"],
  ["on_behalf_of_refused", "on_behalf_of_refused"],
  ["policy_scope_refused", "scope"],
  ["write_permission_refused", "scope"],
]);

/** A `capture_refused` that wears a store fault is no verdict: it may have landed. */
const STORE_FAULTS = [
  "gostore: begin",
  "gostore: commit",
  "gostore: reading ",
  "concurrency races",
  "guard lock:",
  "guard read:",
  "guard scan:",
  "context canceled",
  "context deadline exceeded",
  "conn closed",
];

const CLASSES: readonly { check: string; words: readonly string[] }[] = [
  { check: "depends_on_cycle", words: ["cycle guard"] },
  { check: "scope", words: ["write permission", "not granted"] },
  { check: "spo", words: ["object guard", "subject guard"] },
  { check: "cardinality", words: ["cardinality guard"] },
  { check: "shape", words: ["shape"] },
  { check: "existence", words: ["unknown node token", "no nodes row"] },
];

function refusalCheck(text: string): string {
  for (const c of CLASSES) {
    if (c.words.some((w) => text.includes(w))) return c.check;
  }
  return "capture_refused";
}

/** What the reply contract makes of a star refusal. */
export type RefusalVerdict =
  | { kind: "conflict" }
  | { kind: "refused"; check: string }
  | { kind: "in_doubt" };

/**
 * The code a refusal carries. A typed `{code, detail}` answers by its code; one
 * whose code is not a capture verdict still counts when its text OPENS with
 * the marker (a transport failure that merely quotes one stays in doubt).
 */
function effectiveCode(code: string, detail: string): string {
  if (DEFINITE.has(code)) return code;
  if (detail.startsWith("conflict")) return "conflict";
  if (detail.startsWith("capture_refused")) {
    return detail.includes("conflict") ? "conflict" : "capture_refused";
  }
  return "";
}

/** Tell a definite refusal from a failure in doubt (admitcapture reply.go). */
export function classifyRefusal(code: string, detail: string): RefusalVerdict {
  const eff = effectiveCode(code, detail);
  const check = DEFINITE.get(eff);
  if (check === undefined) return { kind: "in_doubt" };
  if (eff === "conflict") return { kind: "conflict" };
  if (eff === "capture_refused") {
    if (STORE_FAULTS.some((w) => detail.includes(w))) {
      return { kind: "in_doubt" };
    }
    return { kind: "refused", check: refusalCheck(detail) };
  }
  return { kind: "refused", check };
}

/**
 * The node tokens a capture created, in batch order: result entries with a hex
 * id that are not an intern echo or an edge/dictionary op. A top-level
 * admit-shaped `minted` list is the fallback.
 */
export function mintedOf(raw: {
  results?: unknown;
  minted?: unknown;
}): string[] {
  const minted: string[] = [];
  if (Array.isArray(raw.results)) {
    for (const entry of raw.results as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as { op?: unknown; id?: unknown };
      if (
        row.op === "intern" ||
        row.op === "addEdge" ||
        row.op === "removeEdge" ||
        row.op === "relabel"
      ) {
        continue;
      }
      if (typeof row.id === "string" && HEX64.test(row.id)) {
        minted.push(row.id.toLowerCase());
      }
    }
    return minted;
  }
  if (Array.isArray(raw.minted)) return (raw.minted as unknown[]).map(str);
  return minted;
}
