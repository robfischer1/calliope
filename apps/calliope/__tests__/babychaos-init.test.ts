import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initCluster } from "../src/mcp/babychaos.js";

/** A stand-in initdb: `-D <dir>` arrives as $2; writes PG_VERSION at once. */
function fakeInitdb(dir: string, body: string): string {
  const path = join(dir, "initdb");
  writeFileSync(
    path,
    `#!/bin/sh\nmkdir -p "$2"\necho 17 > "$2/PG_VERSION"\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("initCluster", () => {
  let dir: string;
  let dataDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "babychaos-init-"));
    dataDir = join(dir, "pgdata");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the event loop turning while initdb runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    await initCluster(fakeInitdb(dir, "sleep 0.4"), dataDir);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5);
  });

  it("shows no PG_VERSION at the real path until initdb finishes", async () => {
    const running = initCluster(fakeInitdb(dir, "sleep 0.4"), dataDir);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(false);
    await running;
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(true);
    expect(existsSync(`${dataDir}.init`)).toBe(false);
  });

  it("leaves nothing a retry would read as finished when initdb fails", async () => {
    await expect(
      initCluster(fakeInitdb(dir, "exit 3"), dataDir),
    ).rejects.toThrow("initdb failed (3)");
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(`${dataDir}.init`)).toBe(false);
  });

  it("clears a build a killed run left behind", async () => {
    mkdirSync(`${dataDir}.init`);
    writeFileSync(join(`${dataDir}.init`, "stale"), "x");
    await initCluster(fakeInitdb(dir, ":"), dataDir);
    expect(existsSync(join(dataDir, "stale"))).toBe(false);
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(true);
  });
});
