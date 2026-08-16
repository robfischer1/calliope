/**
 * Baby chaos (spec 045, master-plan F13) — the desktop runs the REAL
 * engine: a bundled PostgreSQL plus the chaosstore door, supervised by the
 * sidecar, replacing nothing yet (the fs backend dies at F14, not here).
 *
 * One store, two deployments: the fleet's engine and this one differ only
 * in where they run. Markdown stays the working tree; this is `.git`.
 *
 * Supervision is CRASH-ONLY by design: Grace's Rust shell already carries
 * a generation-safe respawn ladder for the ONE process it spawns (the
 * sidecar), so the cheapest correct lifecycle is to let any engine child's
 * death take the whole sidecar down (exit 1) and let Grace bring the stack
 * back — one supervisor, not two. First-run `initdb` is idempotent-by-
 * presence (a data directory that exists is never re-initialized).
 *
 * Auth is `trust` on 127.0.0.1 ONLY: a single-user desktop store behind a
 * loopback bind; nothing listens beyond the machine (the sidecar's own
 * bind rule, inherited).
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Pool } from "pg";

const IS_WINDOWS = process.platform === "win32";

/** The engine payload layout beside the sidecar binary (or the override). */
export interface EnginePayload {
  /** pg binaries dir — initdb/postgres live here. */
  pgBin: string;
  /** the chaosstore binary. */
  chaosstore: string;
}

/** Resolve the bundled payload: env override for dev, else beside the exe.
 *  Null when absent — the sidecar then serves fs-only (the transition). */
export function resolvePayload(
  env: NodeJS.ProcessEnv = process.env,
  exeDir?: string,
): EnginePayload | null {
  const base =
    env.CALLIOPE_BABYCHAOS_DIR ??
    (exeDir !== undefined ? join(exeDir, "babychaos") : undefined);
  if (base === undefined) return null;
  const pgBin = join(base, "pg", "bin");
  const chaosstore = join(base, IS_WINDOWS ? "chaosstore.exe" : "chaosstore");
  const initdb = join(pgBin, IS_WINDOWS ? "initdb.exe" : "initdb");
  if (!existsSync(initdb) || !existsSync(chaosstore)) return null;
  return { pgBin, chaosstore };
}

/** A free loopback port, asked from the OS. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr !== "object") {
        srv.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

export interface Engine {
  pgPort: number;
  chaosPort: number;
  /** The local calliope database (blobs + the sovereign tables). */
  databaseUrl: string;
  /** The local chaosstore door. */
  chaosUrl: string;
  /** Stop everything, in reverse order. Idempotent. */
  stop(): Promise<void>;
}

const PG_USER = "grace";

function bin(dir: string, name: string): string {
  return join(dir, IS_WINDOWS ? `${name}.exe` : name);
}

/** Wait until a TCP-level pg connection answers a trivial query. */
async function waitForPg(url: string, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("babychaos: postgres never became ready");
}

/** Wait until the chaosstore door answers tools/list. */
async function waitForChaos(url: string, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("babychaos: chaosstore never became ready");
}

/**
 * Boot the engine under `root`: initdb on first run, postgres, databases,
 * chaosstore — readiness-gated at each step. `onExit` fires when any child
 * dies UNEXPECTEDLY (after boot, before stop): the crash-only signal the
 * sidecar turns into its own exit(1).
 */
export async function startEngine(
  payload: EnginePayload,
  root: string,
  onExit: (what: string) => void,
): Promise<Engine> {
  const home = join(root, ".grace", "babychaos");
  const dataDir = join(home, "pgdata");
  mkdirSync(home, { recursive: true });

  // First run — a data directory that exists is NEVER re-initialized.
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    const res = spawnSync(
      bin(payload.pgBin, "initdb"),
      ["-D", dataDir, "-U", PG_USER, "-E", "UTF8", "--auth=trust"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (res.status !== 0) {
      throw new Error(
        `babychaos: initdb failed (${String(res.status)}) — first run cannot proceed`,
      );
    }
  }

  const pgPort = await freePort();
  const children: { name: string; proc: ChildProcess }[] = [];
  let stopping = false;
  const watch = (name: string, proc: ChildProcess): void => {
    children.push({ name, proc });
    proc.on("exit", () => {
      if (!stopping) onExit(name);
    });
  };

  const pg = spawn(
    bin(payload.pgBin, "postgres"),
    [
      "-D",
      dataDir,
      "-p",
      String(pgPort),
      "-c",
      "listen_addresses=127.0.0.1",
      // No unix socket dir games — TCP loopback is the one path, same on
      // both platforms (windows postgres has no unix sockets anyway).
      ...(IS_WINDOWS ? [] : ["-k", ""]),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  watch("postgres", pg);

  const adminUrl = `postgresql://${PG_USER}@127.0.0.1:${String(pgPort)}/postgres`;
  await waitForPg(adminUrl);

  // Databases, idempotently (CREATE DATABASE has no IF NOT EXISTS).
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  for (const db of ["calliope", "chaos"]) {
    const exists = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [db],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${db}`);
    }
  }
  await admin.end();

  const chaosPort = await freePort();
  const chaosDb = `postgresql://${PG_USER}@127.0.0.1:${String(pgPort)}/chaos`;
  const store = spawn(payload.chaosstore, [], {
    env: {
      ...process.env,
      CHAOS_BIGINT_DATABASE_URL: chaosDb,
      // The real env contract (chaosstore main.go): addr strings carry
      // bind + port together; loopback only, ephemeral mTLS bind (its
      // SPIFFE source fail-softs on a desktop with no workload API).
      CHAOS_GO_MCP_ADDR: `127.0.0.1:${String(chaosPort)}`,
      CHAOS_GO_MCP_MTLS_ADDR: "127.0.0.1:0",
      // No kafka on a desktop: empty brokers leave the witness log on the
      // child's stdout, which this spawn discards (the sidecar's own
      // stdout stays the ONE handshake line).
      KAFKA_BOOTSTRAP: "",
      CHAOS_GO_KAFKA_BOOTSTRAP: "",
      OTEL_SDK_DISABLED: "true",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  watch("chaosstore", store);

  const chaosUrl = `http://127.0.0.1:${String(chaosPort)}`;
  await waitForChaos(chaosUrl);

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const { proc } of [...children].reverse()) {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            resolve();
          }, 5000);
          proc.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  };

  return {
    pgPort,
    chaosPort,
    databaseUrl: `postgresql://${PG_USER}@127.0.0.1:${String(pgPort)}/calliope`,
    chaosUrl,
    stop,
  };
}
