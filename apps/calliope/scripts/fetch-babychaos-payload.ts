#!/usr/bin/env bun
/**
 * Assemble the baby-chaos engine payload (spec 045 F13) — the directory
 * that ships beside the sidecar binary:
 *
 *   <out>/pg/{bin,lib,share}   relocatable PostgreSQL (zonky embedded
 *                              binaries: self-contained, rpath'd libs,
 *                              the same artifacts the embedded-postgres
 *                              ecosystem boots in tests)
 *   <out>/chaosstore[.exe]     the REAL engine door, built from the chaos
 *                              repo (cmd/chaos — the store took its canonical
 *                              name and moved to the repo root, 2026-08-22; the
 *                              payload keeps its own file name)
 *
 * An operator script, not CI: it needs network (maven central), docker is
 * NOT needed, and a Go toolchain + a chaos checkout for the store build.
 *
 *   bun run scripts/fetch-babychaos-payload.ts --platform linux
 *   bun run scripts/fetch-babychaos-payload.ts --platform windows \
 *     --chaos /path/to/chaos --out dist/babychaos-windows
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const PG_VERSION = "17.5.0";

function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  return v ?? fallback;
}

function run(cmd: string[], cwd?: string, env?: Record<string, string>): void {
  const [head, ...rest] = cmd;
  if (head === undefined) throw new Error("empty command");
  const res = spawnSync(head, rest, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${String(res.status)})`);
  }
}

async function main(): Promise<void> {
  const platform = arg("--platform");
  if (platform !== "linux" && platform !== "windows") {
    console.error("--platform linux|windows is required");
    exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(
    arg("--out", join(here, "..", "dist", `babychaos-${platform}`)) ?? "",
  );
  const chaosRepo = resolve(
    arg(
      "--chaos",
      process.env.CHAOS_REPO ?? join(here, "..", "..", "..", "..", "chaos"),
    ) ?? "",
  );

  // ── PostgreSQL: the zonky embedded binaries jar (a zip holding one txz).
  const flavor = platform === "linux" ? "linux-amd64" : "windows-amd64";
  const jarUrl =
    `https://repo1.maven.org/maven2/io/zonky/test/postgres/` +
    `embedded-postgres-binaries-${flavor}/${PG_VERSION}/` +
    `embedded-postgres-binaries-${flavor}-${PG_VERSION}.jar`;
  const pgDir = join(out, "pg");
  rmSync(pgDir, { recursive: true, force: true });
  mkdirSync(pgDir, { recursive: true });
  const work = join(out, ".work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  console.error(`fetching ${jarUrl}`);
  const jar = join(work, "pg.jar");
  const res = await fetch(jarUrl);
  if (!res.ok) throw new Error(`pg fetch: HTTP ${String(res.status)}`);
  writeFileSync(jar, Buffer.from(await res.arrayBuffer()));
  run(["unzip", "-q", "-o", jar, "-d", work]);
  const txz = readdirSync(work).find((f) => f.endsWith(".txz"));
  if (txz === undefined) throw new Error("no .txz inside the zonky jar");
  run(["tar", "-xJf", join(work, txz), "-C", pgDir]);
  rmSync(work, { recursive: true, force: true });
  const initdb = join(
    pgDir,
    "bin",
    platform === "windows" ? "initdb.exe" : "initdb",
  );
  if (!existsSync(initdb))
    throw new Error(`payload malformed: ${initdb} missing`);

  // ── chaosstore: the engine door, built from source — one store, two
  //    deployments; the desktop runs the exact fleet code.
  if (!existsSync(join(chaosRepo, "cmd", "chaos"))) {
    throw new Error(
      `chaos repo not found at ${chaosRepo} (--chaos / CHAOS_REPO)`,
    );
  }
  const storeOut = join(
    out,
    platform === "windows" ? "chaosstore.exe" : "chaosstore",
  );
  console.error(`building chaosstore (${platform}) from ${chaosRepo}`);
  run(
    ["go", "build", "-mod=vendor", "-o", storeOut, "./cmd/chaos"],
    chaosRepo,
    platform === "windows" ? { GOOS: "windows", GOARCH: "amd64" } : {},
  );

  console.error(`payload ready: ${out}`);
}

await main();
