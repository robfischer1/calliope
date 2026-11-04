/**
 * Smoke the compiled sidecar: run the host-platform binary and wait for the
 * handshake line `{"event":"listening","port":N}` on a redirected stdout —
 * the exact read Grace's Rust shell does. A binary that dies at import
 * (calliope#26571: ENOENT for an unembedded native.wasm) or buffers the
 * handshake fails here instead of on a desktop.
 *
 * The engine payload is a stub (empty `initdb` + `chaosstore` files):
 * the listener answers before the engine boots, so the handshake proves the
 * binary, not the payload.
 *
 *   bun run scripts/smoke-sidecar.ts [path/to/calliope-sidecar]
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const IS_WINDOWS = process.platform === "win32";
const binary =
  process.argv[2] ??
  path.join(
    HERE,
    "..",
    "dist",
    IS_WINDOWS ? "calliope-sidecar.exe" : "calliope-sidecar",
  );
const TIMEOUT_MS = 30_000;

const scratch = mkdtempSync(path.join(tmpdir(), "sidecar-smoke-"));
const root = path.join(scratch, "root");
const payload = path.join(scratch, "babychaos");
const pgBin = path.join(payload, "pg", "bin");
mkdirSync(root);
mkdirSync(pgBin, { recursive: true });
for (const stub of [
  path.join(pgBin, IS_WINDOWS ? "initdb.exe" : "initdb"),
  path.join(payload, IS_WINDOWS ? "chaosstore.exe" : "chaosstore"),
]) {
  writeFileSync(stub, "");
  chmodSync(stub, 0o755);
}

const child = spawn(binary, ["--root", root, "--port", "0"], {
  env: { ...process.env, CALLIOPE_BABYCHAOS_DIR: payload },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});

const verdict = await new Promise<string | null>((resolve) => {
  const timer = setTimeout(() => {
    resolve(null);
  }, TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const line = stdout.split("\n")[0];
    if (stdout.includes("\n") && line !== undefined) {
      clearTimeout(timer);
      resolve(line);
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(null);
    stderr += `\n(exited ${String(code)} before the handshake)`;
  });
});

child.kill();
rmSync(scratch, { recursive: true, force: true });

let port: unknown;
try {
  const parsed = verdict === null ? null : (JSON.parse(verdict) as unknown);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { event?: unknown }).event === "listening"
  ) {
    port = (parsed as { port?: unknown }).port;
  }
} catch {
  port = undefined;
}

if (typeof port !== "number" || port <= 0) {
  console.error(`✗ ${binary}: no handshake within ${String(TIMEOUT_MS)}ms`);
  console.error(`stdout: ${stdout || "(empty)"}`);
  console.error(`stderr: ${stderr.trim() || "(empty)"}`);
  process.exit(1);
}
console.error(
  `✓ ${path.basename(binary)} handshake: listening on ${String(port)}`,
);
