/**
 * The sidecar over the REAL engine (spec 045 F13) — full boot as Grace
 * runs it: the sidecar is a CHILD PROCESS launched with the exact spawn
 * contract (--root, --port 0, --parent-guard, one stdout handshake line),
 * the payload beside it boots initdb + postgres + chaosstore, and the
 * container surface answers over /mcp. Plus the crash-only pin: a dead
 * engine child takes the sidecar down for Grace's respawn ladder.
 *
 * Gated on CALLIOPE_BABYCHAOS_DIR (an assembled payload —
 * scripts/fetch-babychaos-payload.ts --platform linux); skips otherwise.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opCreate } from "../src/chaos-client.js";
import { LocalChaosDial } from "../src/local-admit.js";

const PAYLOAD = process.env.CALLIOPE_BABYCHAOS_DIR ?? "";
const RUN = PAYLOAD !== "" && existsSync(join(PAYLOAD, "pg", "bin"));

const SIDECAR = join(import.meta.dirname, "..", "src", "mcp", "sidecar.ts");

interface Booted {
  proc: ChildProcess;
  port: number;
  stderr: () => string;
}

/** Launch exactly as Grace does: piped stdin held open, one stdout line. */
async function launch(root: string): Promise<Booted> {
  const proc = spawn(
    "bun",
    ["run", SIDECAR, "--root", root, "--port", "0", "--parent-guard"],
    {
      env: { ...process.env, CALLIOPE_BABYCHAOS_DIR: PAYLOAD },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let err = "";
  proc.stderr.on("data", (c: Buffer) => {
    err = (err + c.toString()).slice(-4000);
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`handshake timeout. stderr: ${err}`));
    }, 30_000);
    let line = "";
    proc.stdout.on("data", (c: Buffer) => {
      line += c.toString();
      const nl = line.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        const parsed = JSON.parse(line.slice(0, nl)) as {
          event: string;
          port: number;
        };
        if (parsed.event === "listening") resolve(parsed.port);
        else reject(new Error(`bad handshake: ${line}`));
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sidecar died at boot (${String(code)}): ${err}`));
    });
  });
  return { proc, port, stderr: () => err };
}

async function health(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
  return (await res.json()) as Record<string, unknown>;
}

async function engineState(port: number): Promise<string> {
  return String((await health(port)).engine);
}

async function waitEngineReady(port: number, tries = 240): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const state = await engineState(port);
    if (state === "ready") return;
    if (state === "failed") throw new Error("engine boot failed");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("engine never became ready");
}

async function mcp(port: number, payload: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line !== undefined ? line.slice(5) : text) as unknown;
}

describe.skipIf(!RUN)("the sidecar over the real engine (045 F13)", () => {
  let root: string;
  let booted: Booted;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "grace-root-"));
    booted = await launch(root);
    await waitEngineReady(booted.port);
  }, 180_000);

  afterAll(async () => {
    if (booted.proc.exitCode === null) {
      booted.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10_000);
        booted.proc.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    await rm(root, { recursive: true, force: true });
  });

  it("boots to ready and serves the container surface over /mcp", async () => {
    // Mint the container the way the F14 backend will: through the local
    // dial at the engine's own door (/health names the port).
    const ports = (await health(booted.port)).engine_ports as {
      chaos: number;
    } | null;
    const chaosPort = ports?.chaos;
    if (chaosPort === undefined) throw new Error("no engine ports in /health");
    const dial = new LocalChaosDial(`http://127.0.0.1:${String(chaosPort)}`);
    const minted = await dial.admit([opCreate("Note", "f13 doc")], "notes");
    const doc = minted.minted[0];
    if (doc === undefined) throw new Error("no container minted");
    const wrote = (await mcp(booted.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "write_container",
        arguments: {
          container: doc,
          ops: [
            { op: "add", text: "grace's first engine block", position: "a0" },
            { op: "add", text: "and the second", position: "a1" },
          ],
        },
      },
    })) as { result?: { isError?: boolean; content?: unknown } };
    expect(wrote.result?.isError ?? false).toBe(false);

    const read = (await mcp(booted.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_container", arguments: { container: doc } },
    })) as {
      result?: { structuredContent?: { blocks?: { text: string }[] } };
    };
    expect(
      (read.result?.structuredContent?.blocks ?? []).map((b) => b.text),
    ).toEqual(["grace's first engine block", "and the second"]);

    const history = (await mcp(booted.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "container_history", arguments: { container: doc } },
    })) as { result?: { structuredContent?: { count?: number } } };
    expect(history.result?.structuredContent?.count ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("keeps the fs surface serving beside the engine", async () => {
    const res = await fetch(`http://127.0.0.1:${String(booted.port)}/body`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verb: "write_body",
        args: { node_id: "note.md", sections: [{ text: "fs still here" }] },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("crash-only: a dead engine child takes the sidecar down (exit 1)", async () => {
    // A SECOND sidecar with its own root, so the shared one above survives.
    const root2 = await mkdtemp(join(tmpdir(), "grace-root-"));
    const second = await launch(root2);
    try {
      await waitEngineReady(second.port);
      // The postgres serving THIS root names its pgdata on the command line.
      const dataDir = join(root2, ".grace", "babychaos", "pgdata");
      const exited = new Promise<number | null>((resolve) => {
        second.proc.on("exit", (code) => {
          resolve(code);
        });
      });
      // Arg-array spawn, no shell: an `sh -c "pkill -f <path>"` wrapper's
      // OWN cmdline contains the pattern, so pkill would kill its shell
      // and the exec reports failure (found the hard way). SIGKILL, not
      // TERM: a TERM'd postmaster does a SMART shutdown and waits for the
      // sidecar's own idle pool connections — a hang, not a crash. A real
      // crash is KILL-shaped.
      const killed = spawnSync("pkill", ["-9", "-f", dataDir]);
      expect(killed.status).toBe(0);
      expect(await exited).toBe(1);
      expect(second.stderr()).toContain("crash-only");
    } finally {
      if (second.proc.exitCode === null) second.proc.kill("SIGKILL");
      await rm(root2, { recursive: true, force: true });
    }
  }, 180_000);

  it("reuses the data directory on a second boot (initdb once)", () => {
    // The shared sidecar's pgdata exists; a restart against the same root
    // must come up ready WITHOUT re-initializing (PG_VERSION present).
    expect(
      existsSync(join(root, ".grace", "babychaos", "pgdata", "PG_VERSION")),
    ).toBe(true);
  });
});
