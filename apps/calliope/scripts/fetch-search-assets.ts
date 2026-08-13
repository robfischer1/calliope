/**
 * Provision the semantic encoder's assets (Findability F2, plan Decision 4)
 * into `apps/calliope/models/` — the dev entry of the resolution order.
 * The model + tokenizer come from pinned upstream URLs with sha256
 * verification (a mismatch refuses loudly); the ORT wasm runtime files are
 * copied from the installed `onnxruntime-web` package, whose version the
 * lockfile already owns. Run: `bun run fetch-search-assets`.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// This script runs under Bun only; the repo typechecks with @types/node, so
// declare the one Bun surface it uses rather than adding bun-types globally.
declare const Bun: { resolveSync(spec: string, from: string): string };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODELS = path.join(HERE, "..", "models");
// The runtime files live wherever the package manager linked the package —
// resolve the module itself (its node entry sits inside dist/).
const ORT_DIST = path.dirname(
  Bun.resolveSync("onnxruntime-web", path.join(HERE, "..")),
);

const PINNED = [
  {
    name: "model_quantized.onnx",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  },
  {
    name: "tokenizer.json",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  },
] as const;

const ORT_FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function present(file: string, expected?: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(file);
    return expected === undefined || sha256(bytes) === expected;
  } catch {
    return false;
  }
}

await fs.mkdir(MODELS, { recursive: true });

for (const asset of PINNED) {
  const dest = path.join(MODELS, asset.name);
  if (await present(dest, asset.sha256)) {
    console.error(`✓ ${asset.name} already present, hash verified`);
    continue;
  }
  console.error(`… fetching ${asset.name}`);
  const res = await fetch(asset.url);
  if (!res.ok) {
    console.error(`✗ ${asset.name}: HTTP ${String(res.status)} from upstream`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== asset.sha256) {
    console.error(
      `✗ ${asset.name}: sha256 mismatch — got ${got}, pinned ${asset.sha256}. ` +
        "Refusing to install an unverified model.",
    );
    process.exit(1);
  }
  await fs.writeFile(dest, bytes);
  console.error(
    `✓ ${asset.name} (${String(bytes.length)} bytes, hash verified)`,
  );
}

for (const name of ORT_FILES) {
  const src = path.join(ORT_DIST, name);
  const dest = path.join(MODELS, name);
  await fs.copyFile(src, dest);
  console.error(`✓ ${name} (copied from onnxruntime-web)`);
}

console.error(`assets ready in ${MODELS}`);
