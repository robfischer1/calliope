/**
 * ChaosClient — Calliope's graph-write muscle (C8).
 *
 * The prose tenant's east-west dials onto the constellation's graph plane:
 *
 *  - **themis** (`CALLIOPE_THEMIS_URL`, default `http://themis:8200/mcp`) —
 *    the gated write. `admit(ops, scope)` runs permit → capture; a refused
 *    batch surfaces its violations verbatim. The op grammar mirrors athena's
 *    `court.py` (the proven litigant): `{op:"createNode", kind, label}` ·
 *    `{op:"addEdge", from_id, predicate, to_literal|to_node}`. **No
 *    intra-batch refs exist on the wire** — a mint-then-link is two `admit`
 *    calls; the minted tokens cross back in `minted[]`.
 *
 *  - **chaos** (`CALLIOPE_CHAOS_URL`, default `http://chaos:8206/mcp`) — the
 *    identity reads. `findByName(kind, label)` is the documented F2 reuse
 *    lookup (`createNode` never dedups; a caller wanting reuse-not-create
 *    looks the name up first); `resolveNodes(tokens)` is the existence oracle
 *    (the node dictionary; unknown hashes are omitted).
 *
 * This is deliberately NOT an extension of `HadesCapture` (the human-plane
 * body write via Charon) nor of `LiveUraniaCapture` (the raw body-capture) —
 * identity mints ride the GATE. The transport is the same single-POST
 * `tools/call` JSON-RPC those transports use.
 */

const DEFAULT_THEMIS_URL = "http://themis:8200";
const DEFAULT_CHAOS_URL = "http://chaos:8206";
const TIMEOUT_MS = 30_000;

const HEX64 = /^[0-9a-f]{64}$/;

/** Coerce an unknown wire field to string (typeof-narrowed, never [object]). */
function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** One admit op — the friendly wire dict themis `_ops_from_wire` parses. */
export type ChaosOp = Record<string, unknown> & { op: string };

/** Build a mint op; the token returns in `admit(...).minted`. */
export function opCreate(kind: string, label = ""): ChaosOp {
  return { op: "createNode", kind, label };
}

/** Assert one edge; exactly one of toLiteral/toNode. */
export function opAdd(
  fromId: string,
  predicate: string,
  target: { toLiteral?: string; toNode?: string },
): ChaosOp {
  return {
    op: "addEdge",
    from_id: fromId,
    predicate,
    to_literal: target.toLiteral ?? null,
    to_node: target.toNode ?? null,
  };
}

/** The gate's answer: admitted or refused-with-violations. */
export interface AdmitResult {
  admitted: boolean;
  minted: string[];
  violations: unknown[];
}

/** A structured chaos/themis failure — the wire's error, never swallowed. */
export class ChaosClientError extends Error {
  constructor(
    message: string,
    readonly code: "wire_error" | "admit_refused" | "bad_result" = "wire_error",
    readonly violations: unknown[] = [],
  ) {
    super(message);
    this.name = "ChaosClientError";
  }
}

/** One outbound edge as chaos `materialize_edges` answers it (resolved form). */
export interface NodeEdge {
  predicate: string;
  value: string;
  isNode: boolean;
}

/** The dial surface `create_note` needs — fixture-implementable. */
export interface ChaosDial {
  admit(ops: ChaosOp[], scope: string): Promise<AdmitResult>;
  findByName(kind: string, label: string): Promise<string[]>;
  resolveNodes(tokens: string[]): Promise<Record<string, string>>;
  /** The node's outbound edges — the heal-on-reuse read. */
  edges(token: string): Promise<NodeEdge[]>;
}

/** POST one `tools/call` and unwrap FastMCP's `{result}` envelope. */
async function rpc(
  endpoint: string,
  id: number,
  verb: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
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
    const resp = await fetch(endpoint, {
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
    throw new ChaosClientError(`${verb}: ${JSON.stringify(body.error)}`);
  }
  const result = body.result;
  if (result?.isError === true) {
    throw new ChaosClientError(`${verb}: ${JSON.stringify(result.content)}`);
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

/** The live dials — themis for writes, chaos for identity reads. */
export class LiveChaosDial implements ChaosDial {
  private readonly themis: string;
  private readonly chaos: string;
  private id = 0;

  constructor(opts?: { themisUrl?: string; chaosUrl?: string }) {
    const themisBase = (
      opts?.themisUrl ??
      process.env.CALLIOPE_THEMIS_URL ??
      DEFAULT_THEMIS_URL
    ).replace(/\/+$/, "");
    const chaosBase = (
      opts?.chaosUrl ??
      process.env.CALLIOPE_CHAOS_URL ??
      process.env.CHAOS_URL ??
      DEFAULT_CHAOS_URL
    ).replace(/\/+$/, "");
    this.themis = themisBase.endsWith("/mcp")
      ? themisBase
      : `${themisBase}/mcp`;
    this.chaos = chaosBase.endsWith("/mcp") ? chaosBase : `${chaosBase}/mcp`;
  }

  async admit(ops: ChaosOp[], scope: string): Promise<AdmitResult> {
    this.id += 1;
    const raw = (await rpc(this.themis, this.id, "admit", { ops, scope })) as {
      admitted?: boolean;
      ok?: boolean;
      minted?: unknown[];
      violations?: unknown[];
    } | null;
    if (raw === null || typeof raw !== "object") {
      throw new ChaosClientError("admit: empty result", "bad_result");
    }
    return {
      admitted: raw.admitted ?? raw.ok ?? false,
      minted: (raw.minted ?? []).map(String),
      violations: raw.violations ?? [],
    };
  }

  async findByName(kind: string, label: string): Promise<string[]> {
    this.id += 1;
    const raw = await rpc(this.chaos, this.id, "find_by_name", {
      kind,
      label,
    });
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map(String).filter((t) => HEX64.test(t));
  }

  async resolveNodes(tokens: string[]): Promise<Record<string, string>> {
    this.id += 1;
    const raw = await rpc(this.chaos, this.id, "resolve_nodes", {
      hashes: tokens,
    });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v),
      ]),
    );
  }

  async edges(token: string): Promise<NodeEdge[]> {
    this.id += 1;
    const raw = (await rpc(this.chaos, this.id, "materialize_edges", {
      node: token,
    })) as {
      edges?: { predicate?: unknown; value?: unknown; is_node?: unknown }[];
    } | null;
    if (raw === null || !Array.isArray(raw.edges)) {
      return [];
    }
    return raw.edges.map((e) => ({
      predicate: asStr(e.predicate),
      value: asStr(e.value),
      isNode: e.is_node === true,
    }));
  }
}

// ── the Notes root (C8's orphan-safety anchor) ────────────────────────────────

/** The root's identity: a distinct kind so a user note titled "Notes" can
 *  never BE the root (the by-name key is kind‖label). */
export const NOTE_ROOT_KIND = "NoteRoot";
export const NOTE_ROOT_LABEL = "Notes";
/** The GHOST anchor predicate (urania U9) — the fleet's one root marker. */
export const ANCHORS_ROLE = "anchorsRole";

/** Lowest-token-wins: the deterministic pick when a mint race twins a node. */
function lowest(tokens: string[]): string {
  const [first] = [...tokens].sort();
  if (first === undefined) {
    throw new ChaosClientError("lowest: empty token set", "bad_result");
  }
  return first;
}

/**
 * Find-or-mint the invisible "All Notes" anchor on *scope*, singleton-safe:
 * a re-find follows the mint, so two racing ensures converge on the lowest
 * token (the loser's twin is logged loudly, never silently adopted).
 */
export async function ensureNotesRoot(
  dial: ChaosDial,
  scope: string,
  log: (msg: string) => void = (m) => {
    console.error(m);
  },
): Promise<string> {
  const standing = await dial.findByName(NOTE_ROOT_KIND, NOTE_ROOT_LABEL);
  if (standing.length > 0) {
    if (standing.length > 1) {
      log(
        `ensureNotesRoot: ${String(standing.length)} root twins on the ` +
          `dictionary — using lowest ${lowest(standing)}`,
      );
    }
    return lowest(standing);
  }
  const mint = await dial.admit(
    [opCreate(NOTE_ROOT_KIND, NOTE_ROOT_LABEL)],
    scope,
  );
  if (!mint.admitted || mint.minted.length !== 1) {
    throw new ChaosClientError(
      "ensureNotesRoot: mint refused",
      "admit_refused",
      mint.violations,
    );
  }
  const [token] = mint.minted;
  if (token === undefined) {
    throw new ChaosClientError(
      "ensureNotesRoot: no minted token",
      "bad_result",
    );
  }
  const edges = await dial.admit(
    [
      opAdd(token, "hasName", { toLiteral: NOTE_ROOT_LABEL }),
      opAdd(token, ANCHORS_ROLE, { toLiteral: NOTE_ROOT_LABEL }),
    ],
    scope,
  );
  if (!edges.admitted) {
    throw new ChaosClientError(
      "ensureNotesRoot: edge admit refused",
      "admit_refused",
      edges.violations,
    );
  }
  // Re-find: a concurrent ensure may have won the race.
  const settled = await dial.findByName(NOTE_ROOT_KIND, NOTE_ROOT_LABEL);
  const winner = settled.length > 0 ? lowest(settled) : token;
  if (settled.length > 1) {
    log(
      `ensureNotesRoot: mint race — ${String(settled.length)} twins; ` +
        `winner ${winner}, this mint ${token}`,
    );
  }
  return winner;
}

/** True iff *token* is a well-formed 64-hex node token. */
export function isNodeToken(token: string): boolean {
  return HEX64.test(token);
}

/** The server facet: a dial bound to its notes scope. */
export interface ChaosFacet {
  dial: ChaosDial;
  scope: string;
}

/** The bare-scope convention (the chaos guard registers graphs bare). */
export function notesScope(env: NodeJS.ProcessEnv = process.env): string {
  return env.CALLIOPE_NOTES_SCOPE ?? "notes";
}

// ── the fixture dial (tests + the standalone fixture server) ─────────────────

/** In-memory ChaosDial: deterministic tokens, name-keyed reuse, no network. */
export class FixtureChaosDial implements ChaosDial {
  readonly admits: { ops: ChaosOp[]; scope: string }[] = [];
  private readonly byName = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  private readonly nodeEdges = new Map<string, NodeEdge[]>();
  private seq = 0;
  /** When set, every admit refuses with these violations. */
  refuseWith: unknown[] | null = null;

  private key(kind: string, label: string): string {
    return `${kind}${label.trim().toLowerCase()}`;
  }

  admit(ops: ChaosOp[], scope: string): Promise<AdmitResult> {
    this.admits.push({ ops, scope });
    if (this.refuseWith !== null) {
      return Promise.resolve({
        admitted: false,
        minted: [],
        violations: this.refuseWith,
      });
    }
    const minted: string[] = [];
    for (const op of ops) {
      if (op.op === "createNode") {
        this.seq += 1;
        const token = this.seq.toString(16).padStart(64, "0");
        const kind = asStr(op.kind);
        const label = asStr(op.label);
        this.byName.set(this.key(kind, label), token);
        this.labels.set(token, label);
        minted.push(token);
      } else if (op.op === "addEdge") {
        const from = asStr(op.from_id);
        const list = this.nodeEdges.get(from) ?? [];
        const toNode = op.to_node;
        list.push({
          predicate: asStr(op.predicate),
          value: asStr(toNode) || asStr(op.to_literal),
          isNode: toNode !== null && toNode !== undefined,
        });
        this.nodeEdges.set(from, list);
      }
    }
    return Promise.resolve({ admitted: true, minted, violations: [] });
  }

  findByName(kind: string, label: string): Promise<string[]> {
    const hit = this.byName.get(this.key(kind, label));
    return Promise.resolve(hit === undefined ? [] : [hit]);
  }

  resolveNodes(tokens: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of tokens) {
      const label = this.labels.get(t);
      if (label !== undefined) {
        out[t] = label;
      }
    }
    return Promise.resolve(out);
  }

  edges(token: string): Promise<NodeEdge[]> {
    return Promise.resolve(this.nodeEdges.get(token) ?? []);
  }

  /** Test helper: pre-register a node as if it existed on the dictionary. */
  seed(kind: string, label: string, token: string): void {
    this.byName.set(this.key(kind, label), token);
    this.labels.set(token, label);
  }
}
