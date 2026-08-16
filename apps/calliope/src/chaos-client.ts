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

import { createHash } from "node:crypto";

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

/** An edge target — exactly one of the three object domains (F2/F3):
 *  a literal (scalar), a node token or batch-local label, or a blob id
 *  (decimal string — bigint-safe; themis translates to {"$blob": id}). */
export interface EdgeTarget {
  toLiteral?: string;
  toNode?: string;
  toBlob?: string;
}

function edgeFields(target: EdgeTarget): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    to_literal: target.toLiteral ?? null,
    to_node: target.toNode ?? null,
  };
  // Only when present: pre-F3 consumers (and themis validators) treat an
  // explicit null third target as a schema surprise; absence is the
  // compatible spelling of "not a blob edge".
  if (target.toBlob !== undefined) {
    fields.to_blob = target.toBlob;
  }
  return fields;
}

/** Assert one edge; exactly one of toLiteral/toNode/toBlob. */
export function opAdd(
  fromId: string,
  predicate: string,
  target: EdgeTarget,
): ChaosOp {
  return {
    op: "addEdge",
    from_id: fromId,
    predicate,
    ...edgeFields(target),
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
  /** The object's recorded domain (F2). The wire carries `domain` ONLY on
   *  blob edges (tape-pinned node/scalar shapes); absent + is_node decides
   *  the other two. For a blob edge, `value` is the decimal blob id. */
  domain: "node" | "scalar" | "blob";
}

/** The dial surface `create_note` needs — fixture-implementable. */
export interface ChaosDial {
  admit(ops: ChaosOp[], scope: string): Promise<AdmitResult>;
  findByName(kind: string, label: string): Promise<string[]>;
  resolveNodes(tokens: string[]): Promise<Record<string, string>>;
  /** The node's outbound edges — the heal-on-reuse read. */
  edges(token: string): Promise<NodeEdge[]>;
  /** Idempotent graph ensure (chaos `register_graph` — an identity op on
   *  the chaos door, like the reads; themis's wire has no registerGraph). */
  registerGraph(name: string): Promise<void>;
  /** The indexed literal point lookup — `find_by_value(graph, p, v)` (C9). */
  findByValue(
    scope: string,
    predicate: string,
    value: string,
  ): Promise<string[]>;
}

/** SHA-256 name-hash of a bare graph/scope name (the chaos identity form). */
export function scopeHash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

/** Retract one edge; the mirror of {@link opAdd}. */
export function opRemove(
  fromId: string,
  predicate: string,
  target: EdgeTarget,
): ChaosOp {
  return {
    op: "removeEdge",
    from_id: fromId,
    predicate,
    ...edgeFields(target),
  };
}

/**
 * Decode one JSON-RPC response body, in EITHER framing the spec allows.
 *
 * Streamable-HTTP lets a server answer a `tools/call` as plain
 * `application/json` OR as a `text/event-stream` carrying the same JSON-RPC
 * object in a `data:` field, and the client does not get to choose: the
 * protocol REQUIRES the request to advertise both, so a conformant server may
 * legitimately pick either. Bare `resp.json()` therefore only ever worked by
 * luck — the luck being that the Python chaos door always chose JSON.
 *
 * MEASURED 2026-08-14: chaos flipped to the Go door, which answers
 * `text/event-stream`. Bun's `Response.json()` on that body throws
 * `Failed to parse JSON` (the `event: ` prefix at char 0), so every calliope
 * read that traverses chaos died — `read_documents`, `read_plan`,
 * `list_blocks`, `list_by_tag` — while the PG-only reads stayed up, which is
 * what made it look like a store fault rather than a transport one. Narrowing
 * the Accept header was tried first and is NOT available: the door answers
 * `400 Accept must contain both 'application/json' and 'text/event-stream'`.
 * Reading both framings is the only conformant fix, and it belongs here.
 *
 * The Python fleet fixed this in `chaos.client` (shipped as chaos 0.26.3) and
 * athena/urania/mnemosyne were swept with it. Calliope consumes no shared
 * client, so it was missed; this is that same fix, ported verbatim in rule.
 *
 * SSE field rules are followed rather than approximated: an event may carry
 * several `data:` lines which join with newlines, and events are separated by
 * blank lines. The LAST complete event is the response — a server is permitted
 * to emit progress notifications ahead of the result, and taking the first
 * would hand the caller a notification shaped like an answer.
 */
export function decodeRpcBody(
  text: string,
  contentType: string,
  verb: string,
): unknown {
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return JSON.parse(text);
  }

  const events: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.replace(/\r+$/, "");
    if (!stripped) {
      if (current.length > 0) {
        events.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (stripped.startsWith("data:")) {
      current.push(stripped.slice(5).replace(/^[ \t]+/, ""));
    }
  }
  if (current.length > 0) events.push(current.join("\n"));

  // pop() rather than [length - 1]: it narrows to `string | undefined` on its
  // own, so the emptiness check below is the type guard too — no assertion,
  // which the lint config forbids in both spellings.
  const last = events.pop();
  if (last === undefined) {
    throw new ChaosClientError(
      `chaos wire call ${JSON.stringify(verb)}: event-stream body carried ` +
        `no data: field: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
  return JSON.parse(last);
}

/**
 * Shape a `tools/call` result from its TEXT blocks, for a server that sends no
 * `structuredContent` at all.
 *
 * The Python (FastMCP) chaos door always emitted `structuredContent`, so this
 * client read only that field and treated its absence as "no payload". The Go
 * door emits the payload in `content[].text` and NO structured field, so every
 * verb came back `undefined` — and because the call sites coerce a non-array to
 * `[]` (`findByValue`, `resolveNodes`), that surfaced as an EMPTY RESULT rather
 * than an error. `read_plan` answered `document_not_found` for plans that exist,
 * which is a far worse failure than a throw: it looks like absent data.
 *
 * Measured 2026-08-14 against the live Go door — the node is really there:
 *
 *     find_by_value(notes, source_path, "…/Dionysus…Master-plan.md")
 *       wire: {"result":{"content":[{"type":"text","text":"[\"019ff961…\"]"}]}}
 *       was:  undefined -> []        -> document_not_found
 *       now:  ["019ff961…"]
 *
 * Block rules follow the Python client's `shape_tool_payload`: ONE text block is
 * the payload; SEVERAL are one JSON document each, because the server SDK emits
 * one block per item and concatenating them is not valid JSON.
 */
export function shapeFromTextBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text);
  // Destructure rather than index: `first` narrows to `string | undefined` on
  // its own, so the emptiness check is the type guard too — no assertion, which
  // the lint config forbids in both spellings. `as unknown` because JSON.parse
  // is typed `any` and returning it bare trips no-unsafe-return.
  const [first, ...rest] = texts;
  if (first === undefined) return undefined;
  if (rest.length === 0) return JSON.parse(first) as unknown;
  return texts.map((t) => JSON.parse(t) as unknown);
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
    body = decodeRpcBody(
      await resp.text(),
      resp.headers.get("content-type") ?? "",
      verb,
    ) as typeof body;
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
  if (result?.structuredContent === undefined) {
    return shapeFromTextBlocks(result?.content);
  }
  const structured = result.structuredContent;
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

  async findByValue(
    scope: string,
    predicate: string,
    value: string,
  ): Promise<string[]> {
    this.id += 1;
    const raw = await rpc(this.chaos, this.id, "find_by_value", {
      graph: scopeHash(scope),
      predicate,
      value,
    });
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map(asStr).filter((t) => HEX64.test(t));
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
    return raw.edges.map((e) => {
      const isNode = e.is_node === true;
      const domain =
        (e as { domain?: unknown }).domain === "blob"
          ? ("blob" as const)
          : isNode
            ? ("node" as const)
            : ("scalar" as const);
      return {
        predicate: asStr(e.predicate),
        value: asStr(e.value),
        isNode,
        domain,
      };
    });
  }

  async registerGraph(name: string): Promise<void> {
    this.id += 1;
    await rpc(this.chaos, this.id, "register_graph", {
      graph: scopeHash(name),
      name,
    });
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

/** The tenant set — five tenants, five graphs (Git for Ideas F3). Notes
 *  predates F3; the others are registered idempotently at first use.
 *  Mnemosyne stays graph-native on its own and joins only if it adopts
 *  the shared store. */
export type Tenant = "notes" | "documents" | "comments" | "governance";

/** The bare-scope convention (the chaos guard registers graphs bare),
 *  generalized per tenant. Env overrides keep the notes compat knob and
 *  give each tenant its own. */
export function tenantScope(
  tenant: Tenant,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const overrides: Record<Tenant, string | undefined> = {
    notes: env.CALLIOPE_NOTES_SCOPE,
    documents: env.CALLIOPE_DOCUMENTS_SCOPE,
    comments: env.CALLIOPE_COMMENTS_SCOPE,
    governance: env.CALLIOPE_GOVERNANCE_SCOPE,
  };
  return overrides[tenant] ?? tenant;
}

/** The notes tenant's scope — the pre-F3 name, now a view over tenantScope. */
export function notesScope(env: NodeJS.ProcessEnv = process.env): string {
  return tenantScope("notes", env);
}

// ── the fixture dial (tests + the standalone fixture server) ─────────────────

/** In-memory ChaosDial: deterministic tokens, name-keyed reuse, no network. */
export class FixtureChaosDial implements ChaosDial {
  readonly admits: { ops: ChaosOp[]; scope: string }[] = [];
  readonly graphs = new Set<string>();
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
    // Batch-local label -> minted token, themis's exact rule: a NON-EMPTY
    // createNode label names its mint for later ops in the SAME batch;
    // first create wins a duplicate. Without this, a one-transaction slot
    // birth (create + three edges) is untestable offline. Two passes,
    // because themis pre-indexes creates before translating edges.
    const batchLabels = new Map<string, string>();
    const minted: string[] = [];
    for (const op of ops) {
      if (op.op !== "createNode") continue;
      this.seq += 1;
      const token = this.seq.toString(16).padStart(64, "0");
      const kind = asStr(op.kind);
      const label = asStr(op.label);
      this.byName.set(this.key(kind, label), token);
      this.labels.set(token, label);
      if (label !== "" && !batchLabels.has(label)) {
        batchLabels.set(label, token);
      }
      minted.push(token);
    }
    const resolveRef = (v: unknown): string => {
      const raw = asStr(v);
      return batchLabels.get(raw) ?? raw;
    };
    for (const op of ops) {
      if (op.op === "addEdge") {
        const from = resolveRef(op.from_id);
        const list = this.nodeEdges.get(from) ?? [];
        const toNode = op.to_node;
        const toBlob = op.to_blob;
        const hasBlob = toBlob !== null && toBlob !== undefined;
        const isNode = !hasBlob && toNode !== null && toNode !== undefined;
        list.push({
          predicate: asStr(op.predicate),
          value: hasBlob
            ? asStr(toBlob)
            : isNode
              ? resolveRef(toNode)
              : asStr(op.to_literal),
          isNode,
          domain: hasBlob ? "blob" : isNode ? "node" : "scalar",
        });
        this.nodeEdges.set(from, list);
      } else if (op.op === "removeEdge") {
        const from = resolveRef(op.from_id);
        const toBlob = op.to_blob;
        const hasBlob = toBlob !== null && toBlob !== undefined;
        const value = hasBlob
          ? asStr(toBlob)
          : resolveRef(op.to_node) || asStr(op.to_literal);
        const list = (this.nodeEdges.get(from) ?? []).filter(
          (e) => !(e.predicate === asStr(op.predicate) && e.value === value),
        );
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

  registerGraph(name: string): Promise<void> {
    this.graphs.add(name);
    return Promise.resolve();
  }

  findByValue(
    _scope: string,
    predicate: string,
    value: string,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const [token, list] of this.nodeEdges) {
      if (list.some((e) => e.predicate === predicate && e.value === value)) {
        out.push(token);
      }
    }
    return Promise.resolve(out.sort());
  }

  /** Test helper: pre-register a node as if it existed on the dictionary. */
  seed(kind: string, label: string, token: string): void {
    this.byName.set(this.key(kind, label), token);
    this.labels.set(token, label);
  }
}
