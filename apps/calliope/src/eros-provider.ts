/**
 * The pg backend's search arm (Findability F4) — Eros as a shape, routed,
 * never rebuilt: `search(query, scope)` on a store-backed server calls
 * eros's `search` verb over its openapi-http face (POST /v1/search on the
 * plaintext REST door, `CALLIOPE_EROS_URL` e.g. `http://eros:8203`; the mesh
 * proxy stamps `X-Forge-Peer: calliope` and grants-eros admits /v1/<verb>
 * only — eros's /mcp is not reachable in the mesh) with a source filter
 * pinning the dissolved-notes source, and maps the answer into the ruled
 * envelope. The envelope names the arm that was dialled — `eros` — not the
 * fts/semantic arms eros fuses inside itself.
 * The pg backend's architecture has ONE arm; unreachable degrades to
 * `armsDark: ["eros"]` — named, never thrown (docs/search-architecture.md).
 *
 * No FTS index, no embedding, no vectors anywhere in this file — routing
 * only. Eros's decay + engagement ranking rides through untouched.
 */

import { RestClient } from "@forge/stellar-core-ts/rest";
import type { SearchProvider, SearchResponse } from "./search-types.js";

/** The dissolved-notes source eros reports (verified live: 36,432 chunks). */
export const EROS_NOTES_SOURCE = "calliope_documents";

/** Disable eros's 2018 hybrid date-skew default — notes are not skewed. */
const SINCE_ALL = "1900";

const TIMEOUT_MS = 5_000;
const DEFAULT_K = 20;

interface ErosHit {
  source_id?: unknown;
  doc_id?: unknown;
  title?: unknown;
  snippet?: unknown;
  score?: unknown;
}

interface ErosSearchResult {
  results?: ErosHit[];
}

/** Chunk identities arrive as numbers or strings; anything else is no id. */
function idOf(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** Read the arm's configuration; unset = the arm does not exist (dark). */
export function erosUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.CALLIOPE_EROS_URL;
  if (url === undefined || url === "") return null;
  return url.replace(/\/+$/, "");
}

export class ErosSearchProvider implements SearchProvider {
  readonly #client: RestClient;

  constructor(url: string, fetchFn?: typeof fetch) {
    this.#client = new RestClient(
      fetchFn === undefined ? { base: url } : { base: url, fetch: fetchFn },
    );
  }

  async search(
    query: string,
    scope?: string,
    k?: number,
  ): Promise<SearchResponse> {
    // Remote hits carry no subtree paths — scope narrows nothing here (the
    // note-path scoping question belongs to F8's note indexing).
    void scope;
    try {
      const raw = await this.#call(query, k ?? DEFAULT_K);
      const hits = (raw.results ?? []).map((hit) => {
        const title = typeof hit.title === "string" ? hit.title : "";
        const snippet = typeof hit.snippet === "string" ? hit.snippet : "";
        const id = idOf(hit.source_id) ?? idOf(hit.doc_id) ?? "";
        return {
          id,
          snippet: title !== "" ? `${title} — ${snippet}` : snippet,
          score: typeof hit.score === "number" ? hit.score : 0,
          arms: ["eros" as const],
        };
      });
      return { hits, armsQueried: ["eros"], armsDark: [] };
    } catch {
      return { hits: [], armsQueried: [], armsDark: ["eros"] };
    }
  }

  /** One REST round-trip per query, bounded by TIMEOUT_MS. */
  async #call(query: string, k: number): Promise<ErosSearchResult> {
    const reply = await this.#client.call(
      "search",
      { query, k, source: EROS_NOTES_SOURCE, since: SINCE_ALL },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // eros's `search` text IS the JSON of its structured content, so the
    // door serves a plain application/json body, not the result envelope:
    // the client then leaves `structured` unset and the body in texts[0].
    // Falling back to `{}` here answered zero hits for a live arm; an absent
    // or unparsable body throws instead, which `search` reports as dark.
    if (reply.structured !== undefined && reply.structured !== null) {
      return reply.structured;
    }
    const text = reply.texts[0];
    if (text === undefined) throw new Error("eros answered no content");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("eros answered a non-object body");
    }
    return parsed;
  }
}

/** Build the arm from the environment, or nothing (honest darkness). */
export function makeErosProvider(
  env: NodeJS.ProcessEnv = process.env,
): ErosSearchProvider | undefined {
  const url = erosUrl(env);
  return url === null ? undefined : new ErosSearchProvider(url);
}
