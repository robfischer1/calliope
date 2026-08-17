/**
 * The local admit (spec 045, master-plan F13) — baby-chaos has no themis.
 *
 * On the fleet, every write rides the gate: themis translates the friendly
 * op dialect into chaos's capture wire (ops.py → go-court ops.go ToWire).
 * The desktop ships the ENGINE (chaosstore + postgres), not the court —
 * one machine, one writer, nothing to arbitrate — so the same translation
 * runs here, in process, and the batch lands on chaosstore's own `capture`
 * door. The translation is a PORT of go-court/internal/ops/ops.go ToWire,
 * held to it by the same pinned constants its tests use (ContentHash of
 * "done", NameHash of "moirae") — cross-language parity by constant, not
 * by re-deriving with the code under test.
 */

import { createHash } from "node:crypto";

/** Coerce an unknown wire field to string (typeof-narrowed, never [object]). */
function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
import {
  type AdmitResult,
  type ChaosDial,
  ChaosClientError,
  type ChaosOp,
  type HistoryEntry,
  LiveChaosDial,
  type NodeEdge,
  type QuadRow,
} from "./chaos-client.js";

/** sha256 over the 0x1f-joined canonical scalar form — themis ContentHash. */
export function contentHash(value: string, dtype = "", lang = ""): string {
  for (const field of [value, dtype, lang]) {
    if (field.includes("\u001f")) {
      throw new ChaosClientError(
        "local admit: a scalar field carrying 0x1f would collide the " +
          "canonical form — refused (themis ContentHash's own rule)",
        "bad_result",
      );
    }
  }
  return createHash("sha256")
    .update(`${value}\u001f${dtype}\u001f${lang}`, "utf8")
    .digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

/** One translated capture op (chaos's decodeOps dialect). */
type CaptureOp = Record<string, unknown> & { op: string };

/**
 * Port of ToWire: friendly ops → one atomic capture batch. Batch-local
 * createNode labels resolve to `{$mint: i}` (non-empty label, first
 * create wins — themis's exact rule); literals intern in the same batch
 * and ride as their content-hash; blob targets cross as `{"$blob": id}`.
 */
export function toCaptureOps(ops: ChaosOp[], scope: string): CaptureOp[] {
  if (scope === "") {
    throw new ChaosClientError(
      "local admit: scope is required — an unbound write lands in " +
        'name_hash(""), a phantom graph (the 2026-07-05 scatter, pinned)',
      "bad_result",
    );
  }
  const scopeGraph = scope;
  const labels = new Map<string, number>();
  let createIndex = 0;
  for (const op of ops) {
    if (op.op === "createNode") {
      const label = asStr(op.label);
      if (label !== "" && !labels.has(label)) labels.set(label, createIndex);
      createIndex += 1;
    }
  }
  const wireRef = (raw: unknown): unknown => {
    const id = asStr(raw);
    const mint = labels.get(id);
    if (mint !== undefined) return { $mint: mint };
    return id;
  };
  const out: CaptureOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "createNode":
        out.push({
          op: "createNode",
          label: asStr(op.label),
          kind: asStr(op.kind),
        });
        break;
      case "relabel":
        out.push({
          op: "relabel",
          id: asStr(op.id),
          label: asStr(op.label),
        });
        break;
      case "addEdge":
      case "removeEdge": {
        const toLiteral = op.to_literal;
        const toNode = op.to_node;
        const toBlob = op.to_blob;
        const set = [toLiteral, toNode, toBlob].filter(
          (t) => t !== null && t !== undefined,
        );
        if (set.length !== 1) {
          throw new ChaosClientError(
            `local admit: ${op.op} needs exactly one of to_literal/` +
              `to_node/to_blob, got ${String(set.length)}`,
            "bad_result",
          );
        }
        let o: unknown;
        if (toBlob !== null && toBlob !== undefined) {
          o = { $blob: asStr(toBlob) };
        } else if (toNode !== null && toNode !== undefined) {
          o = wireRef(toNode);
        } else {
          const value = asStr(toLiteral);
          out.push({ op: "intern", value });
          o = contentHash(value);
        }
        const g =
          op.op === "removeEdge" &&
          typeof op.graph === "string" &&
          HEX64.test(op.graph)
            ? op.graph
            : scopeGraph;
        out.push({
          op: op.op,
          s: wireRef(op.from_id),
          predicate: asStr(op.predicate),
          o,
          g,
        });
        break;
      }
      default:
        throw new ChaosClientError(
          `local admit: unknown op ${op.op}`,
          "bad_result",
        );
    }
  }
  return out;
}

/**
 * The desktop dial: reads (and graph registration) ride the same chaos
 * door the live dial uses — pointed at loopback chaosstore — and admit
 * translates in-process and lands on `capture`. AdmitResult keeps the
 * gate's shape: minted node tokens in batch order, the transaction id,
 * violations empty (there is no court here; an engine refusal surfaces
 * as a thrown wire error, exactly like any other store fault).
 */
export class LocalChaosDial implements ChaosDial {
  readonly #reads: LiveChaosDial;
  readonly #chaosUrl: string;
  readonly #author: string;
  #id = 0;

  constructor(chaosUrl: string, author = "human") {
    this.#chaosUrl = chaosUrl.endsWith("/mcp") ? chaosUrl : `${chaosUrl}/mcp`;
    this.#reads = new LiveChaosDial({ chaosUrl, themisUrl: chaosUrl });
    this.#author = author;
  }

  async admit(ops: ChaosOp[], scope: string): Promise<AdmitResult> {
    const wire = toCaptureOps(ops, scope);
    this.#id += 1;
    const raw = (await localRpc(this.#chaosUrl, this.#id, "capture", {
      ops: wire,
      author: this.#author,
    })) as {
      tx?: unknown;
      results?: { op?: unknown; id?: unknown }[];
    } | null;
    if (raw === null || typeof raw !== "object") {
      throw new ChaosClientError(
        "local admit: empty capture result",
        "bad_result",
      );
    }
    const minted: string[] = [];
    for (const r of raw.results ?? []) {
      if (r.op === "createNode" && typeof r.id === "string") minted.push(r.id);
    }
    const out: AdmitResult = { admitted: true, minted, violations: [] };
    if (typeof raw.tx === "number") out.tx = raw.tx;
    return out;
  }

  findByName(kind: string, label: string): Promise<string[]> {
    return this.#reads.findByName(kind, label);
  }
  resolveNodes(tokens: string[]): Promise<Record<string, string>> {
    return this.#reads.resolveNodes(tokens);
  }
  edges(token: string): Promise<NodeEdge[]> {
    return this.#reads.edges(token);
  }
  findByValue(
    scope: string,
    predicate: string,
    value: string,
  ): Promise<string[]> {
    return this.#reads.findByValue(scope, predicate, value);
  }
  registerGraph(name: string): Promise<void> {
    return this.#reads.registerGraph(name);
  }
  quadsFrom(
    subjects: string[],
    asOfTx: number | null,
    predicateNames: string[] | null,
    graph?: string,
  ): Promise<QuadRow[]> {
    return this.#reads.quadsFrom(subjects, asOfTx, predicateNames, graph);
  }
  resolveScalars(hashes: string[]): Promise<Record<string, string>> {
    return this.#reads.resolveScalars(hashes);
  }
  history(
    subjects: string[],
    follow: string[],
    graph?: string,
  ): Promise<HistoryEntry[]> {
    return this.#reads.history(subjects, follow, graph);
  }
  heldBlobs(graph?: string): Promise<string[]> {
    return this.#reads.heldBlobs(graph);
  }
}

/** One tools/call POST against the local chaosstore door (mcpserve). */
async function localRpc(
  endpoint: string,
  id: number,
  verb: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: verb, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new ChaosClientError(
      `local capture: HTTP ${String(res.status)}`,
      "wire_error",
    );
  }
  const text = await res.text();
  const payload =
    text.startsWith("event:") || text.includes("\ndata:")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("") || "null"
      : text;
  const body = JSON.parse(payload) as {
    error?: unknown;
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: unknown;
    };
  };
  if (body.error !== undefined) {
    throw new ChaosClientError(
      `local ${verb}: ${JSON.stringify(body.error)}`,
      "wire_error",
    );
  }
  const result = body.result;
  if (result?.isError === true) {
    throw new ChaosClientError(
      `local ${verb}: ${JSON.stringify(result.content ?? [])}`,
      "wire_error",
    );
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const first = result?.content?.[0]?.text;
  if (first === undefined || first === "") return null;
  return JSON.parse(first) as unknown;
}
