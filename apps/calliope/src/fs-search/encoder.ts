/**
 * The local semantic encoder (Findability F2) — the ruled int8 MiniLM-class
 * model on onnxruntime-web's wasm backend, proven under Bun 1.3.14
 * (specs/033-search-verb/research.md). Assets resolve from a directory
 * (env > beside-binary > repo models/); absence means the semantic arm is
 * honestly dark, never a crash in the query path.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { WordPieceTokenizer } from "./tokenizer.js";

/** The nominal model id recorded on every vector (the space seam's key). */
export const LOCAL_MODEL_ID = "all-MiniLM-L6-v2-int8";

/** The ruled dimensionality. */
export const DIMS = 384;

/** Anything that can turn texts into int8[384] vectors. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Int8Array[]>;
}

const ASSET_FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "model_quantized.onnx",
  "tokenizer.json",
] as const;

/** First directory carrying all four assets, or null (semantic stays dark). */
export async function resolveAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates: string[] = [];
  const fromEnv = env.CALLIOPE_SEARCH_ASSETS;
  if (fromEnv !== undefined && fromEnv !== "") candidates.push(fromEnv);
  candidates.push(path.join(path.dirname(process.execPath), "search-assets"));
  candidates.push(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "models",
    ),
  );
  for (const dir of candidates) {
    const checks = await Promise.all(
      ASSET_FILES.map(async (f) => {
        try {
          await fs.access(path.join(dir, f));
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (checks.every(Boolean)) return dir;
  }
  return null;
}

/** Mean-pool over the (unpadded) sequence, L2-normalize, quantize ×127. */
export function poolAndQuantize(
  hidden: Float32Array,
  seqLen: number,
): Int8Array {
  const pooled = new Float32Array(DIMS);
  for (let t = 0; t < seqLen; t++) {
    const base = t * DIMS;
    for (let d = 0; d < DIMS; d++)
      pooled[d] = (pooled[d] ?? 0) + (hidden[base + d] ?? 0);
  }
  let norm = 0;
  for (let d = 0; d < DIMS; d++) {
    const v = (pooled[d] ?? 0) / seqLen;
    pooled[d] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(DIMS);
  for (let d = 0; d < DIMS; d++) {
    out[d] = Math.max(
      -127,
      Math.min(127, Math.round(((pooled[d] ?? 0) / norm) * 127)),
    );
  }
  return out;
}

/** Cosine similarity surrogate for two ×127 int8 vectors: the raw dot. */
export function dotInt8(a: Int8Array, b: Int8Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += (a[i] ?? 0) * (b[i] ?? 0);
  return acc;
}

interface OrtSessionLike {
  run(
    feed: Record<string, unknown>,
  ): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
  outputNames: readonly string[];
}

type TensorCtor = new (
  type: string,
  data: BigInt64Array,
  dims: number[],
) => unknown;

/** The ORT-backed embedder. Construction is async and can fail loudly —
 *  callers treat failure as "semantic arm unavailable", not a crash. */
export class OrtEmbedder implements Embedder {
  readonly model = LOCAL_MODEL_ID;
  readonly #session: OrtSessionLike;
  readonly #tokenizer: WordPieceTokenizer;
  readonly #tensor: TensorCtor;

  private constructor(
    session: OrtSessionLike,
    tokenizer: WordPieceTokenizer,
    tensor: TensorCtor,
  ) {
    this.#session = session;
    this.#tokenizer = tokenizer;
    this.#tensor = tensor;
  }

  static async create(assetsDir: string): Promise<OrtEmbedder> {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      mjs: pathToFileURL(path.join(assetsDir, "ort-wasm-simd-threaded.mjs"))
        .href,
      wasm: pathToFileURL(path.join(assetsDir, "ort-wasm-simd-threaded.wasm"))
        .href,
    };
    const model = await fs.readFile(
      path.join(assetsDir, "model_quantized.onnx"),
    );
    const session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ["wasm"],
    });
    const tokenizerJson = await fs.readFile(
      path.join(assetsDir, "tokenizer.json"),
      "utf8",
    );
    const tokenizer = WordPieceTokenizer.fromTokenizerJson(tokenizerJson);
    return new OrtEmbedder(session, tokenizer, ort.Tensor);
  }

  /** One text at a time through the session (batch=1 keeps padding out of the
   *  pooling math; throughput is the background queue's concern, not ours). */
  async embed(texts: string[]): Promise<Int8Array[]> {
    const out: Int8Array[] = [];
    for (const text of texts) {
      const { ids, length } = this.#tokenizer.encode(text);
      const big = BigInt64Array.from(ids.map((i) => BigInt(i)));
      const ones = BigInt64Array.from(Array.from({ length }, () => 1n));
      const zeros = new BigInt64Array(length);
      const feed = {
        input_ids: new this.#tensor("int64", big, [1, length]),
        attention_mask: new this.#tensor("int64", ones, [1, length]),
        token_type_ids: new this.#tensor("int64", zeros, [1, length]),
      };
      const results = await this.#session.run(feed);
      const name = this.#session.outputNames[0];
      const first = name === undefined ? undefined : results[name];
      if (first === undefined)
        throw new Error("encoder: session returned no output");
      out.push(poolAndQuantize(first.data as Float32Array, length));
    }
    return out;
  }
}
