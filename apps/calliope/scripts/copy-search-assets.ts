/**
 * Ship the encoder assets beside the compiled sidecar (plan Decision 4):
 * `models/` → `dist/search-assets/`. Absence warns rather than fails — a
 * sidecar without assets still serves FTS and states the dark arm.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODELS = path.join(HERE, "..", "models");
const DEST = path.join(HERE, "..", "dist", "search-assets");

try {
  const entries = await fs.readdir(MODELS);
  await fs.mkdir(DEST, { recursive: true });
  for (const name of entries) {
    await fs.copyFile(path.join(MODELS, name), path.join(DEST, name));
  }
  console.error(
    `✓ search assets shipped beside the binary (${String(entries.length)} files)`,
  );
} catch {
  console.error(
    "⚠ no models/ dir — sidecar ships without the semantic arm's assets " +
      "(run `bun run fetch-search-assets` first to include them)",
  );
}
