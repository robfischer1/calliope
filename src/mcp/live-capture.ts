/**
 * Live {@link UraniaCapture} over the urania engine-service — the transport that
 * lets Calliope-MCP write the SAME content-addressed substrate clotho does.
 *
 * This mirrors moirae's `urania_client.py` (the wire) + `urania_store.py` (the
 * graph→datom translation) so a body written here is byte-compatible with one
 * written by clotho's store:
 *
 *  - Wire: a `tools/call` JSON-RPC POST to `${URANIA_URL}/mcp`; `capture` takes
 *    hex-encoded `s/p/o/g` ops plus `{op:"intern", value}` for scalars;
 *    `materialize` returns `{id, attrs:[{p, value, is_node}]}`.
 *  - Hashing (a fixed protocol constant, computed locally — no per-hash round
 *    trip): `name_hash(iri)` = SHA-256 of the UTF-8 IRI; `content_hash(value)`
 *    = SHA-256 of `value \x1f "" \x1f ""` (empty dtype + lang).
 *  - Graph slice: every fact is asserted in the `moirae` named-graph
 *    (`name_hash("moirae")`), the same `g` clotho writes — so the prose facet
 *    and the work facet share one graph.
 *
 * calliope's body-model ops ({@link UraniaOp}: createNode / addEdge /
 * removeEdge over the `hasPart` / `text` / `order_key` / `hasType` predicates)
 * are translated here into urania's wire vocabulary. A "node" id on calliope's
 * side is a urania node's name-hash, hex-encoded (the form `materialize` returns
 * for `is_node` attrs), so section ids round-trip through resolve() → capture().
 *
 * NOTE — Hades gate: the intended long-term write path is the Hades gate. Its
 * write API is not available to this repo yet, so — exactly as clotho does today
 * — this writes the urania engine-service directly. Flagged in deviations.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AuthoredBy,
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../urania-client.js";
import { HAS_PART, ORDER_KEY, TEXT } from "../urania-client.js";

const HAS_TYPE = "hasType";
const UNIT = "\x1f"; // urania.store._UNIT — canonical-term field delimiter
const DEFAULT_URL = "http://nas01:8202";
const TIMEOUT_MS = 30_000;

/** SHA-256 name-hash of a node/predicate IRI (urania contract), as hex. */
export function nameHash(iri: string): string {
  return createHash("sha256").update(iri, "utf8").digest("hex");
}

/** SHA-256 content-hash of a scalar's canonical form (urania contract), as hex. */
export function contentHash(value: string): string {
  const canonical = [value, "", ""].join(UNIT);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The `moirae` named-graph — the `g` shared with clotho's work facet. */
const MOIRAE_GRAPH = nameHash("moirae");

/**
 * Predicates whose object is a node (a `hasPart` edge points note→section);
 * everything else (`text`, `order_key`, `hasType`) carries a scalar literal.
 */
const NODE_PREDICATES = new Set<string>([HAS_PART]);

/** Name-hash of each calliope predicate, for wire encoding (the write path). */
const PREDICATE_HASH: Record<string, string> = {
  [HAS_PART]: nameHash(HAS_PART),
  [TEXT]: nameHash(TEXT),
  [ORDER_KEY]: nameHash(ORDER_KEY),
  [HAS_TYPE]: nameHash(HAS_TYPE),
};

/** calliope's body-model predicates — the set resolve() keeps. */
const BODY_PREDICATES = new Set<string>([HAS_PART, TEXT, ORDER_KEY, HAS_TYPE]);

/** A urania wire op (hex `s/p/o/g`) or a scalar intern. */
type WireOp =
  | { op: "intern"; value: string }
  | {
      op: "addEdge" | "removeEdge";
      s: string;
      p: string;
      o: string;
      g: string;
    };

/** One edge as urania's `materialize_edges` returns it (resolved name). */
interface UraniaEdge {
  predicate: string;
  value: string;
  is_node?: boolean;
}

/** Error from a urania `tools/call` (JSON-RPC error or `isError` result). */
export class UraniaError extends Error {}

/**
 * Thin transport over the urania engine-service, then the calliope-op→wire-op
 * translation on top of it. Injected into {@link UraniaBodyClient}.
 */
export class LiveUraniaCapture implements UraniaCapture {
  private readonly endpoint: string;
  private id = 0;

  constructor(url?: string) {
    const base = (url ?? process.env.URANIA_URL ?? DEFAULT_URL).replace(
      /\/+$/,
      "",
    );
    this.endpoint = `${base}/mcp`;
  }

  /** POST a `tools/call`; unwrap FastMCP's `{result}` envelope. */
  private async rpc(
    verb: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.id += 1;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: this.id,
      method: "tools/call",
      params: { name: verb, arguments: args },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    let body: {
      error?: unknown;
      result?: {
        isError?: boolean;
        content?: unknown;
        structuredContent?: unknown;
      };
    };
    try {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: payload,
        signal: controller.signal,
      });
      body = (await resp.json()) as typeof body;
    } finally {
      clearTimeout(timer);
    }
    if (body.error !== undefined) {
      throw new UraniaError(`${verb}: ${JSON.stringify(body.error)}`);
    }
    const result = body.result;
    if (result?.isError === true) {
      throw new UraniaError(`${verb}: ${JSON.stringify(result.content)}`);
    }
    const structured = result?.structuredContent;
    if (
      structured !== null &&
      typeof structured === "object" &&
      Object.keys(structured).length === 1 &&
      "result" in structured
    ) {
      return structured.result;
    }
    return structured;
  }

  /**
   * Resolve one node's outbound edges to calliope triples. urania's
   * `materialize_edges(node)` returns `{id, edges:[{predicate, value, is_node}]}`
   * — the no-LWW, multi-valued read (a note's N `hasPart` edges all survive,
   * where `materialize` would collapse them to one). The `predicate` is already
   * the resolved B1 NAME, so it's read directly. Each edge becomes
   * `{ from: subject, predicate, to }` (node hex / scalar value as `to`);
   * predicates outside calliope's body model are dropped.
   */
  async resolve(subject: string): Promise<UraniaTriple[]> {
    const mat = (await this.rpc("materialize_edges", { node: subject })) as {
      edges?: UraniaEdge[];
    } | null;
    const edges = mat?.edges ?? [];
    const triples: UraniaTriple[] = [];
    for (const edge of edges) {
      if (!BODY_PREDICATES.has(edge.predicate)) continue;
      triples.push({
        from: subject,
        predicate: edge.predicate,
        to: edge.value,
      });
    }
    return triples;
  }

  /**
   * Translate calliope ops to urania wire ops and apply them in one capture.
   *
   * @param ops - The ops to apply.
   * @param authoredBy - Provenance identity forwarded as the `author` field to
   *   the urania engine-service. Defaults to `"calliope"` (legacy / machine
   *   author). Pass `"human"` to attribute the write to Rob — the gateway auth
   *   seam (Charon → Hades) enforces `SET ROLE human` on those writes.
   */
  async capture(
    ops: UraniaOp[],
    authoredBy: AuthoredBy = "calliope",
  ): Promise<void> {
    const wire: WireOp[] = [];
    for (const op of ops) {
      switch (op.op) {
        case "createNode":
          // A node exists by carrying a fact: assert `node hasType "<type>"`.
          // (The `hasType` is the SECTION_TYPE scalar; urania has no createNode.)
          wire.push(...factLit(op.id, HAS_TYPE, op.hasType));
          break;
        case "addEdge":
          wire.push(...edgeOps(op.from, op.predicate, op.to, true));
          break;
        case "removeEdge":
          wire.push(...edgeOps(op.from, op.predicate, op.to, false));
          break;
      }
    }
    const deduped = dedupOps(wire);
    if (deduped.length > 0) {
      await this.rpc("capture", {
        ops: deduped.map(hexOp),
        author: authoredBy,
      });
    }
  }

  /**
   * Mint a fresh section placement id: a urania node name-hash (hex). The
   * `nodeId` of the owning note is not needed (ids are globally unique), so the
   * structurally-compatible no-arg form satisfies the {@link UraniaCapture}
   * contract.
   */
  mintSectionId(): string {
    return nameHash(`calliope:${randomUUID()}`);
  }
}

/** Ops to assert/retract `subject predicate <object>` (node- or scalar-target). */
function edgeOps(
  from: string,
  predicate: string,
  to: string,
  add: boolean,
): WireOp[] {
  const p = PREDICATE_HASH[predicate] ?? nameHash(predicate);
  const kind = add ? "addEdge" : "removeEdge";
  if (NODE_PREDICATES.has(predicate)) {
    // Object is a node id (already a name-hash hex) — a relation edge.
    return [{ op: kind, s: from, p, o: to, g: MOIRAE_GRAPH }];
  }
  // Object is a scalar literal — intern its value, edge points at content-hash.
  const o = contentHash(to);
  const edge: WireOp = { op: kind, s: from, p, o, g: MOIRAE_GRAPH };
  return add ? [{ op: "intern", value: to }, edge] : [edge];
}

/** intern + addEdge to assert `subject predicate scalar(value)`. */
function factLit(subject: string, predicate: string, value: string): WireOp[] {
  return edgeOps(subject, predicate, value, true);
}

/** Hex-encode the byte-valued (s/p/o/g) fields of one wire op. */
function hexOp(op: WireOp): Record<string, unknown> {
  return { ...op };
}

/**
 * Collapse a batch so each fact `(s,p,o,g)` appears once (last wins) and each
 * intern once by value — urania's `facts` PK is `(s,p,o,g,tx)` and one capture
 * is one tx, so the same fact twice in a batch is a PK violation. Mirrors
 * `urania_store.dedup_ops`.
 */
function dedupOps(ops: WireOp[]): WireOp[] {
  const interns = new Map<string, WireOp>();
  const facts = new Map<string, WireOp>();
  for (const op of ops) {
    if (op.op === "intern") {
      interns.set(op.value, op);
    } else {
      facts.set(`${op.s} ${op.p} ${op.o} ${op.g}`, op);
    }
  }
  return [...interns.values(), ...facts.values()];
}
