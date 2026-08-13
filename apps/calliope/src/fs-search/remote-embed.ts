/**
 * The optional bulk-embed accelerator (Findability F2, plan Decision 5) —
 * an ollama-shaped `/api/embed` endpoint that speeds the initial backfill
 * when configured and reachable. STRICTLY the same nominal 384-dim space:
 * a wrong-dimensioned endpoint (bge-m3's 1024, say) is refused for the
 * process lifetime rather than silently poisoning the local index
 * (docs/search-architecture.md — vector spaces never cross the seam).
 * Queries never come here; the local encoder owns them.
 */

import { DIMS, type Embedder } from "./encoder.js";

export interface RemoteConfig {
  url: string;
  model: string;
}

/** Read the accelerator config from the environment, if any. */
export function remoteConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteConfig | null {
  const url = env.CALLIOPE_EMBED_URL;
  if (url === undefined || url === "") return null;
  const model = env.CALLIOPE_EMBED_MODEL;
  if (model === undefined || model === "") return null;
  return { url: url.replace(/\/$/, ""), model };
}

interface EmbedResponse {
  embeddings?: number[][];
}

export class RemoteEmbedder implements Embedder {
  readonly model: string;
  readonly #url: string;
  #refused = false;

  constructor(config: RemoteConfig, nominalModel: string) {
    this.#url = config.url;
    this.model = nominalModel;
    this.#remoteModel = config.model;
  }

  readonly #remoteModel: string;

  /** Refused endpoints stay refused (wrong space) — the caller falls back. */
  get refused(): boolean {
    return this.#refused;
  }

  async embed(texts: string[]): Promise<Int8Array[]> {
    if (this.#refused)
      throw new Error("remote_embed: endpoint refused (wrong dims)");
    const res = await fetch(`${this.#url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.#remoteModel, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`remote_embed: HTTP ${String(res.status)}`);
    }
    const body = (await res.json()) as EmbedResponse;
    const rows = body.embeddings;
    if (rows?.length !== texts.length) {
      throw new Error("remote_embed: malformed response");
    }
    const first = rows[0];
    if (first !== undefined && first.length !== DIMS) {
      this.#refused = true;
      throw new Error(
        `remote_embed: endpoint serves ${String(first.length)}-dim vectors, ` +
          `need ${String(DIMS)} — refused for the process lifetime (space seam)`,
      );
    }
    return rows.map((row) => {
      let norm = 0;
      for (const v of row) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      const out = new Int8Array(DIMS);
      for (let d = 0; d < DIMS; d++) {
        out[d] = Math.max(
          -127,
          Math.min(127, Math.round(((row[d] ?? 0) / norm) * 127)),
        );
      }
      return out;
    });
  }
}
