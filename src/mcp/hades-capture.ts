/**
 * Gateway-auth {@link UraniaCapture} transport: Charon → Hades → calliope-mcp.
 *
 * This is the F2 write path — the intended long-term route for body writes that
 * carry human provenance. Instead of POSTing `tools/call`/`capture` JSON-RPC
 * directly to the urania engine-service at `URANIA_URL` (the clotho-parity
 * fallback in {@link LiveUraniaCapture}), this transport:
 *
 *  1. POSTs to Charon's `/api/body` HTTP endpoint (`CHARON_URL`).
 *  2. Charon authenticates as Rob and issues `SET ROLE human` (gateway auth
 *     seam), so the write is attributed `authored_by = human` in Mnemosyne.
 *  3. Charon forwards the request through Hades to calliope-mcp (`:8204`), which
 *     handles `read_body` / `write_body` verbs with `structuredContent` payloads.
 *
 * The transport is selectable via env flags (see {@link hadesEnabled}) and is
 * wired into the backend factory in `backend.ts`. The direct-urania path
 * ({@link LiveUraniaCapture}) remains as the clotho-parity fallback when the
 * flag is off.
 *
 * Wire shape (POST /api/body):
 * ```json
 * {
 *   "verb": "write_body" | "read_body",
 *   "node_id": "<urania node hex>",
 *   "sections": [{ "text": "…" }],     // write_body only
 *   "authored_by": "human" | "calliope"
 * }
 * ```
 *
 * Response (200 OK):
 * ```json
 * {
 *   "ok": true,
 *   "sections": [{ "id": "…", "text": "…", "orderKey": "…" }]  // read_body only
 * }
 * ```
 *
 * NOTE — Hades gate: this IS the Hades gate write path. The {@link LiveUraniaCapture}
 * deviation note ("the intended long-term write path is the Hades gate") is
 * resolved by THIS file for calliope ops that opt into `CALLIOPE_WRITE_VIA_HADES`.
 */

import { randomUUID } from "node:crypto";
import { nameHash } from "./live-capture.js";
import type {
  AuthoredBy,
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../urania-client.js";
import { HAS_PART, ORDER_KEY, TEXT } from "../urania-client.js";

const DEFAULT_CHARON_URL = "http://charon:8300";
const TIMEOUT_MS = 30_000;

/** The shape of the POST body sent to Charon /api/body. */
export interface CharonBodyRequest {
  verb: "write_body" | "read_body";
  node_id: string;
  sections?: { text: string }[];
  authored_by: AuthoredBy;
}

/** The shape of a successful Charon /api/body response. */
export interface CharonBodyResponse {
  ok: boolean;
  sections?: { id: string; text: string; orderKey: string }[];
  error?: string;
}

/** Error from a Charon /api/body POST. */
export class CharonError extends Error {
  constructor(
    public readonly verb: string,
    message: string,
  ) {
    super(`HadesCapture(${verb}): ${message}`);
    this.name = "CharonError";
  }
}

/**
 * Whether the Hades gateway write path is enabled. Reads `CALLIOPE_WRITE_VIA_HADES`
 * (truthy: `"1"` or `"true"`) — off by default so existing direct-urania
 * behaviour is preserved.
 */
export function hadesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.CALLIOPE_WRITE_VIA_HADES;
  return flag === "1" || flag === "true";
}

/** Resolve the Charon base URL from the environment. */
export function charonUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CHARON_URL ?? DEFAULT_CHARON_URL).replace(/\/+$/, "");
}

/**
 * {@link UraniaCapture} implementation over the Charon → Hades gateway.
 *
 * Reads ride the same path as writes (`read_body` verb to Charon `/api/body`).
 * The gateway serialises the calliope body-model ops into a Charon request body
 * rather than urania wire ops — Charon/Hades owns the translation to urania
 * internals on the other side.
 *
 * This transport is NOT a drop-in replacement for the urania wire format: it
 * speaks the higher-level calliope body-model verbs, delegating the
 * urania-capture translation to the calliope-mcp star (`:8204`) that Hades
 * routes to. The `capture` call is therefore a `write_body` POST; `resolve` is
 * a `read_body` POST.
 *
 * Because the gateway handles the body model, `capture` receives pre-translated
 * `UraniaOp[]` which are re-encoded here into the simpler Charon payload shape
 * (addEdge/createNode ops are collapsed back to sections). For the read path,
 * `resolve` returns the triples the body-model edges imply.
 */
export class HadesCapture implements UraniaCapture {
  private readonly base: string;

  constructor(url?: string, env: NodeJS.ProcessEnv = process.env) {
    this.base = (url ?? charonUrl(env)).replace(/\/+$/, "");
  }

  /** POST to Charon /api/body; return the parsed response. */
  private async post(req: CharonBodyRequest): Promise<CharonBodyResponse> {
    const endpoint = `${this.base}/api/body`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "(unreadable)");
      throw new CharonError(req.verb, `HTTP ${String(resp.status)}: ${body}`);
    }
    const data = (await resp.json()) as CharonBodyResponse;
    if (!data.ok) {
      throw new CharonError(req.verb, data.error ?? "unknown error");
    }
    return data;
  }

  /**
   * Resolve one node's body triples via Charon `read_body`.
   *
   * The Charon `/api/body` response returns sections as
   * `[{ id, text, orderKey }]`; we re-expand them to the `UraniaTriple[]`
   * the body-model client expects (`hasPart` + `text` + `order_key` triples per
   * section), so the {@link UraniaBodyClient} mapping stays unchanged.
   */
  async resolve(subject: string): Promise<UraniaTriple[]> {
    const data = await this.post({
      verb: "read_body",
      node_id: subject,
      authored_by: "human",
    });
    const sections = data.sections ?? [];
    const triples: UraniaTriple[] = [];
    for (const sec of sections) {
      triples.push({ from: subject, predicate: HAS_PART, to: sec.id });
      triples.push({ from: sec.id, predicate: TEXT, to: sec.text });
      triples.push({ from: sec.id, predicate: ORDER_KEY, to: sec.orderKey });
    }
    return triples;
  }

  /**
   * Apply a batch of ops via Charon `write_body`.
   *
   * The ops are re-collapsed to a section list (addEdge `text` ops per section
   * node) for the Charon payload. Only `addEdge text` ops are surfaced — the
   * full body diff is owned by {@link UraniaBodyClient.saveBody}; this transport
   * serialises the net-new section texts into the Charon `write_body` verb.
   *
   * The `authored_by` field is forwarded as-is; Charon enforces `SET ROLE human`
   * on the gateway when it is `"human"`.
   */
  async capture(
    ops: UraniaOp[],
    authoredBy: AuthoredBy = "human",
  ): Promise<void> {
    // Extract the section texts from addEdge text ops (the net-new sections).
    // createNode ops and removeEdge ops are advisory for the local body-model
    // client; the Charon write_body verb owns the full reconcile on the server.
    const sections: { text: string }[] = [];
    for (const op of ops) {
      if (op.op === "addEdge" && op.predicate === TEXT) {
        sections.push({ text: op.to });
      }
    }
    if (sections.length === 0 && ops.length > 0) {
      // Only removeEdge / order_key ops — no content write needed via Charon.
      return;
    }
    // Derive node_id from the first hasPart addEdge (note -> section).
    const hasPart = ops.find(
      (op) => op.op === "addEdge" && op.predicate === HAS_PART,
    );
    const nodeId = hasPart?.op === "addEdge" ? hasPart.from : "";
    await this.post({
      verb: "write_body",
      node_id: nodeId,
      sections,
      authored_by: authoredBy,
    });
  }

  /**
   * Mint a fresh section placement id. Matches {@link LiveUraniaCapture}'s
   * strategy (SHA-256 of a UUID-based URI) so ids round-trip through the
   * substrate correctly.
   */
  mintSectionId(): string {
    return nameHash(`calliope:${randomUUID()}`);
  }
}
