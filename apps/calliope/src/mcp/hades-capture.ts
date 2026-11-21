import { randomUUID } from "node:crypto";
import { nameHash } from "./live-capture.js";
import type {
  AuthoredBy,
  UraniaCapture,
  UraniaOp,
  UraniaTriple,
} from "../urania-client.js";
import { HAS_PART, ORDER_KEY, TEXT } from "../urania-client.js";

const DEFAULT_CHARON_URL = "http://charon";
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

/** {@link UraniaCapture} implementation over the Charon → Hades gateway. */
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

  /** Resolve one node's body triples via Charon `read_body`. */
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

  /** Apply a batch of ops via Charon `write_body`. */
  async capture(
    ops: UraniaOp[],
    authoredBy: AuthoredBy = "human",
  ): Promise<void> {
    const sections: { text: string }[] = [];
    for (const op of ops) {
      if (op.op === "addEdge" && op.predicate === TEXT) {
        sections.push({ text: op.to });
      }
    }
    if (sections.length === 0 && ops.length > 0) {
      return;
    }
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
