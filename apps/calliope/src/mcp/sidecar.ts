#!/usr/bin/env node

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { argv, execPath, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { BlobStore } from "../blob-store.js";
import { TENANTS, tenantScope } from "../chaos-client.js";
import type { ContainerFacet } from "../container-write.js";
import { LocalChaosDial } from "../local-admit.js";
import { LocalEngineStore } from "../local-store.js";
import { PgBodyClient } from "../pg-client.js";
import { type Engine, resolvePayload, startEngine } from "./babychaos.js";
import type { SectionInput } from "../types.js";
import {
  applySectionOps,
  formatCompoundReference,
  readBody,
  readBodyAt,
  readBodyRevisions,
  writeBody,
} from "./tools.js";
import type { WireSectionOp } from "./tools.js";

/** Parse `--root` / `--port` from an argv slice. */
export function parseArgs(args: readonly string[]): {
  root: string | undefined;
  port: number;
  parentGuard: boolean;
} {
  let root: string | undefined;
  let port = 0;
  let parentGuard = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--parent-guard") parentGuard = true;
    else if (args[i] === "--port") {
      const raw = args[++i];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed < 65536)
        port = parsed;
    }
  }
  return { root, port, parentGuard };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() === "" ? undefined : (JSON.parse(raw) as unknown);
}

function statusFor(message: string): number {
  if (message.startsWith("stale_section:")) return 409;
  if (
    message.startsWith("invalid_path:") ||
    message.startsWith("unsupported_file:") ||
    message.startsWith("unsupported_verb:") ||
    message.startsWith("bad_request:")
  )
    return 400;
  return 500;
}

/** CORS: the Tauri webview is a foreign origin to this loopback server, and
 *  its JSON POSTs preflight. The requesting origin is echoed rather than `*`:
 *  WebView2 156's local-network-access check refuses a wildcard preflight to
 *  127.0.0.1 (PreflightWildcardOriginNotAllowed), and it asks for
 *  Access-Control-Allow-Private-Network on the same preflight. Loopback-only
 *  and no credentials, so echoing any origin grants nothing `*` did not. */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin":
      typeof origin === "string" && origin !== "" ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
  if (typeof origin === "string" && origin !== "") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (req.headers["access-control-request-private-network"] === "true") {
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  return headers;
}

async function dispatch(
  store: LocalEngineStore,
  body: unknown,
): Promise<unknown> {
  const envelope = body as { verb?: unknown; args?: unknown } | undefined;
  if (envelope === undefined || typeof envelope.verb !== "string") {
    throw new Error("bad_request: expected {verb, args}.");
  }
  const args = (envelope.args ?? {}) as Record<string, unknown>;
  const nodeId = typeof args.node_id === "string" ? args.node_id : "";
  switch (envelope.verb) {
    case "read_body":
      return readBody(store, nodeId);
    case "write_body":
      return writeBody(store, nodeId, (args.sections ?? []) as SectionInput[]);
    case "apply_section_ops":
      return applySectionOps(
        store,
        nodeId,
        (args.ops ?? []) as WireSectionOp[],
      );
    case "read_body_revisions":
      return readBodyRevisions(
        store,
        nodeId,
        typeof args.limit === "number" ? args.limit : undefined,
      );
    case "read_body_at":
      return readBodyAt(
        store,
        nodeId,
        typeof args.revision === "string" ? args.revision : "",
      );
    case "copy_reference": {
      await readBody(store, nodeId);
      const base = nodeId.split("/").pop() ?? nodeId;
      const title = base.replace(/\.(md|markdown)$/i, "");
      return {
        ...formatCompoundReference(title, nodeId),
        address_form: "path",
      };
    }
    case "list_tags":
      return store.listTags();
    case "list_by_tag":
      return store.listByTag(typeof args.tag === "string" ? args.tag : "");
    case "mentions": {
      const id = typeof args.id === "string" ? args.id : "";
      if (id.trim() === "") {
        throw new Error("bad_request: mentions needs a node id.");
      }
      return store.mentions(id);
    }
    case "search": {
      const query = typeof args.query === "string" ? args.query : "";
      if (query.trim() === "") {
        throw new Error("bad_request: search needs a non-empty query.");
      }
      return store.search(
        query,
        typeof args.scope === "string" ? args.scope : undefined,
        typeof args.k === "number" ? args.k : undefined,
      );
    }
    default:
      throw new Error(`unsupported_verb: ${envelope.verb}`);
  }
}

/** The engine's boot lifecycle, as /health reports it. */
export type EngineState = "booting" | "ready" | "failed";

/** The sidecar's live view of the engine — read PER REQUEST. */
export interface SidecarBackend {
  state: () => EngineState;
  ports: () => { pg: number; chaos: number } | null;
  /** Resolves when the store is servable; rejects if the boot failed. */
  ready: () => Promise<LocalEngineStore>;
  root: string;
}

export function createSidecarServer(
  backend: SidecarBackend,
): ReturnType<typeof createServer> {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?", 1)[0];
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(
        JSON.stringify({
          ok: backend.state() !== "failed",
          root: backend.root,
          backend: "engine",
          engine: backend.state(),
          engine_ports: backend.ports(),
        }),
      );
      return;
    }
    if (path !== "/body" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void (async () => {
      const store = await backend.ready();
      const body = await readJson(req);
      const result = await dispatch(store, body);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(result));
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(statusFor(message), {
        "Content-Type": "application/json",
        ...cors,
      });
      res.end(JSON.stringify({ error: message }));
    });
  });
}

function main(): void {
  const { root, port, parentGuard } = parseArgs(argv.slice(2));
  if (root === undefined) {
    process.stderr.write("calliope-sidecar: --root <directory> is required\n");
    exit(1);
  }
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(`calliope-sidecar: bad root: ${root}\n`);
    exit(1);
  }

  const payload = resolvePayload(process.env, dirname(execPath));
  if (payload === null) {
    process.stderr.write(
      "calliope-sidecar: no engine payload (babychaos/ beside the binary " +
        "or CALLIOPE_BABYCHAOS_DIR) — nothing to serve\n",
    );
    exit(1);
  }

  const state: {
    engine?: Engine;
    store?: LocalEngineStore;
    status: EngineState;
  } = { status: "booting" };
  let resolveReady!: (store: LocalEngineStore) => void;
  let rejectReady!: (err: Error) => void;
  const readyGate = new Promise<LocalEngineStore>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  readyGate.catch(() => undefined);

  void (async () => {
    const engine = await startEngine(payload, root, (what) => {
      process.stderr.write(
        `calliope-sidecar: engine child died (${what}) — crash-only exit\n`,
      );
      exit(1);
    });
    state.engine = engine;
    const pool = new Pool({ connectionString: engine.databaseUrl });
    await new PgBodyClient(pool).ensureSchema();
    const dial = new LocalChaosDial(engine.chaosUrl);
    for (const tenant of TENANTS) {
      await dial.registerGraph(tenantScope(tenant));
    }
    const facet: ContainerFacet = { blobs: new BlobStore(pool), dial };
    const store = new LocalEngineStore(root, facet, { pool });
    state.store = store;
    state.status = "ready";
    resolveReady(store);
    process.stderr.write(
      `calliope-sidecar: engine ready (pg 127.0.0.1:${String(engine.pgPort)}, ` +
        `chaos 127.0.0.1:${String(engine.chaosPort)})\n`,
    );
    void store.scan();
  })().catch((err: unknown) => {
    state.status = "failed";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`calliope-sidecar: engine boot failed: ${message}\n`);
    rejectReady(
      new Error(`store_error: the engine failed to boot: ${message}`),
    );
  });

  const backend: SidecarBackend = {
    state: () => state.status,
    ports: () => {
      const engine = state.engine;
      return engine === undefined
        ? null
        : { pg: engine.pgPort, chaos: engine.chaosPort };
    },
    ready: () => readyGate,
    root,
  };

  const server = createSidecarServer(backend);
  server.on("error", (err) => {
    process.stderr.write(`calliope-sidecar: ${err.message}\n`);
    exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actual =
      address !== null && typeof address === "object" ? address.port : port;
    writeSync(1, `${JSON.stringify({ event: "listening", port: actual })}\n`);
    process.stderr.write(
      `calliope-sidecar: serving ${root} on http://127.0.0.1:${String(actual)}\n`,
    );
  });

  const shutdown = (): void => {
    state.store?.close();
    const finish = (): void => {
      server.close(() => {
        exit(0);
      });
    };
    const engine = state.engine;
    state.engine = undefined;
    if (engine !== undefined) void engine.stop().then(finish, finish);
    else finish();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (parentGuard) {
    process.stdin.resume();
    process.stdin.on("close", shutdown);
    process.stdin.on("end", shutdown);
  }
}

const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
