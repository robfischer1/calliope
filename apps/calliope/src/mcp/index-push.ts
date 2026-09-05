/**
 * The write-side body push (B): after any body write, the assembled prose is
 * pushed to urania's similarity index (`index_document`) so the embedded
 * document (name + body) reflects the write and body-topic queries retrieve the
 * node. calliope owns the body semantics; urania stores the prose and re-embeds
 * WITHOUT decoding the section model — the sovereignty boundary.
 *
 * {@link IndexingBodyClient} decorates ANY {@link BodyClient} — the pg sovereign
 * store, the substrate-direct urania client, the fixture — so the push fires
 * wherever the body itself persists. The push is best-effort: the index is
 * derived state that re-syncs on the next write or a rebuild, so a push failure
 * NEVER fails the body write.
 */

import { createHash } from "node:crypto";
import type {
  AuthoredBy,
  BodyClient,
  Section,
  SectionInput,
} from "../types.js";

const TIMEOUT_MS = 30_000;

/** SHA-256 name-hash of an IRI (the urania contract), hex-encoded. */
function nameHash(iri: string): string {
  return createHash("sha256").update(iri, "utf8").digest("hex");
}

/** The `moirae` named-graph — the scope calliope writes bodies into. */
const MOIRAE_GRAPH = nameHash("moirae");

/** The one push behaviour the decorator needs (real client or a test double). */
export interface IndexPusher {
  /** Push `node`'s assembled body prose into urania's similarity index. */
  indexDocument(node: string, body: string): Promise<void>;
}

/**
 * Direct client for urania's `index_document` verb over its MCP endpoint
 * (`tools/call` JSON-RPC), mirroring {@link LiveUraniaCapture}'s wire. The
 * `moirae` graph is the scope — the same `g` bodies are written into.
 */
export class UraniaIndexClient implements IndexPusher {
  private readonly endpoint: string;
  private id = 0;

  constructor(url: string) {
    this.endpoint = `${url.replace(/\/+$/, "")}/mcp`;
  }

  async indexDocument(node: string, body: string): Promise<void> {
    this.id += 1;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: this.id,
      method: "tools/call",
      params: {
        name: "index_document",
        arguments: { node, graph: MOIRAE_GRAPH, body },
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
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
      const parsed = (await resp.json()) as {
        error?: unknown;
        result?: { isError?: boolean; content?: unknown };
      };
      if (parsed.error !== undefined) {
        throw new Error(`index_document: ${JSON.stringify(parsed.error)}`);
      }
      if (parsed.result?.isError === true) {
        throw new Error(
          `index_document: ${JSON.stringify(parsed.result.content)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Decorate a {@link BodyClient} so every body write also pushes the assembled
 * prose to urania's similarity index. Reads pass through untouched; a write
 * (save / edit) is followed by a best-effort push of the WHOLE body, read back
 * through the inner client (the post-write source of truth). `editSection` is
 * exposed only when the inner client supports it, preserving the optional-method
 * contract that {@link BodyClient} and its MCP handler rely on.
 */
export class IndexingBodyClient implements BodyClient {
  readonly editSection: BodyClient["editSection"];
  /** A8: the revision reads pass straight through (no index push — they
   *  are reads). F14 collapsed the capability signal: every surviving
   *  BodyClient implements the full surface, so the passthrough is
   *  unconditional (the A8 "decorator hid the verbs" hazard is now a
   *  compile error instead of a runtime absence). */
  readonly readRevisions: BodyClient["readRevisions"];
  readonly readRevisionAt: BodyClient["readRevisionAt"];
  /** F10: bulk prose-presence passes straight through (a read, no push). */
  readonly hasBody: BodyClient["hasBody"];
  /** A11: the block-grain apply is a write — push after, same as save/edit. */
  readonly applySectionOps: BodyClient["applySectionOps"];

  constructor(
    /** The wrapped client — PUBLIC so boot-time init (ensureSchema) can
     *  unwrap the decorator (found live 2026-07-12: the pg client is ALWAYS
     *  wrapped in production, so an instanceof check on the wrapper never
     *  saw PgBodyClient and ensureSchema silently never ran). */
    readonly inner: BodyClient,
    private readonly index: IndexPusher,
  ) {
    // Bind to `inner` so the extracted method keeps its receiver. Every
    // write forwards its FULL parameter list — the decorator dropping the
    // trailing provenance pair (authoredBy, kafkaOffset) is how every
    // production write stored 'human' while the bare-client tests passed
    // (found live 2026-08-14: the deployed pg client is ALWAYS wrapped).
    const edit = inner.editSection.bind(inner);
    this.editSection = async (
      nodeId,
      sectionId,
      text,
      authoredBy,
      kafkaOffset,
    ) => {
      const section = await edit(
        nodeId,
        sectionId,
        text,
        authoredBy,
        kafkaOffset,
      );
      await this.push(nodeId);
      return section;
    };
    const apply = inner.applySectionOps.bind(inner);
    this.applySectionOps = async (nodeId, ops, authoredBy, kafkaOffset) => {
      const result = await apply(nodeId, ops, authoredBy, kafkaOffset);
      await this.push(nodeId);
      return result;
    };
    this.readRevisions = inner.readRevisions.bind(inner);
    this.readRevisionAt = inner.readRevisionAt.bind(inner);
    this.hasBody = inner.hasBody.bind(inner);
  }

  readBody(nodeId: string): Promise<Section[]> {
    return this.inner.readBody(nodeId);
  }

  async saveBody(
    nodeId: string,
    sections: SectionInput[],
    authoredBy?: AuthoredBy,
    kafkaOffset?: number,
  ): Promise<void> {
    await this.inner.saveBody(nodeId, sections, authoredBy, kafkaOffset);
    await this.push(nodeId);
  }

  private async push(nodeId: string): Promise<void> {
    try {
      const sections = await this.inner.readBody(nodeId);
      const body = sections.map((s) => s.text).join("\n\n");
      await this.index.indexDocument(nodeId, body);
    } catch {
      // Projection push failed; the write stands and the index re-syncs later.
    }
  }
}

/** Fan a push out to every configured index — one failing never stops the
 *  others (each is independently best-effort; the decorator already
 *  swallows a total failure). */
export function fanOutPushers(pushers: readonly IndexPusher[]): IndexPusher {
  return {
    async indexDocument(node: string, body: string): Promise<void> {
      const results = await Promise.allSettled(
        pushers.map((p) => p.indexDocument(node, body)),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length === pushers.length && pushers.length > 0) {
        // Every projection failed — let the decorator log/swallow it.
        throw new Error("all index pushes failed");
      }
    },
  };
}
