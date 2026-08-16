#!/usr/bin/env node
/**
 * The Grace sidecar entry — the desktop serves the REAL engine (045 F13),
 * and ONLY the engine (046 F14: the fs backend and its companions are
 * deleted; there is no second implementation left to fall back to).
 *
 * The ferry wire (`/body`) and the MCP endpoint (`/mcp`) both ride ONE
 * {@link LocalEngineStore}: sections are the graph's tree, history is the
 * graph as-of a transaction, search is the engine's postgres, and the
 * markdown directory is the WORKING TREE the store projects and ingests.
 *
 * Boot contract (the Rust shell parses it — UNCHANGED since G2):
 *  - argv: `--root <directory>` (required) `--port <n>` (default 0 = ephemeral)
 *  - binds 127.0.0.1 ONLY; nothing listens beyond the machine
 *  - exactly ONE stdout line: `{"event":"listening","port":<N>}` — stdout is
 *    otherwise silent (the stdio-bin convention); logs go to stderr
 *  - exits 0 on SIGTERM/SIGINT and on stdin close (the orphan guard: a parent
 *    that crashed without killing us closes our piped stdin)
 *  - exits 1 on a bad root, a bind failure, or a MISSING ENGINE PAYLOAD —
 *    without the engine there is no store to serve
 *
 * The handshake never waits on the engine: the listener answers first and
 * `/body` + `/mcp` requests WAIT (bounded by the boot itself) until the
 * engine is ready. Supervision stays crash-only: an engine child dying
 * after boot exits the sidecar; Grace's respawn ladder brings it back.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { argv, execPath, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { BlobStore } from "../blob-store.js";
import { tenantScope } from "../chaos-client.js";
import type { ContainerFacet } from "../container-write.js";
import { FocusRegister } from "../focus-register.js";
import { LocalChaosDial } from "../local-admit.js";
import { LocalEngineStore } from "../local-store.js";
import { PgBodyClient } from "../pg-client.js";
import { type Engine, resolvePayload, startEngine } from "./babychaos.js";
import { createServer as createMcpServer } from "./server.js";
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
 *  its JSON POSTs preflight. Loopback-only + no credentials ⇒ `*` is safe. */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
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
    // F14: block-grain applies went LIVE locally — engine slots carry the
    // durable identity the fs grain never had.
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
    // 024/F1 — the compound reference, path form: the path IS the node
    // identity on the desktop. A missing file still gets a reference (the
    // path is a valid address before its first write); a malformed or
    // escaping path refuses exactly as every other verb.
    case "copy_reference": {
      await readBody(store, nodeId); // path validation, same refusals
      const base = nodeId.split("/").pop() ?? nodeId;
      const title = base.replace(/\.(md|markdown)$/i, "");
      return {
        ...formatCompoundReference(title, nodeId),
        address_form: "path",
      };
    }
    // Tags stay a computed walk of the working tree (the desktop mints no
    // hasTag facts; extraction reads file text only — no sections derived).
    case "list_tags":
      return store.listTags();
    case "list_by_tag":
      return store.listByTag(typeof args.tag === "string" ? args.tag : "");
    // Findability F11 — mentions(id) over the engine's own index.
    case "mentions": {
      const id = typeof args.id === "string" ? args.id : "";
      if (id.trim() === "") {
        throw new Error("bad_request: mentions needs a node id.");
      }
      return store.mentions(id);
    }
    // Findability F2 — search on the engine's postgres; dark arms NAMED.
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
  containers: () => ContainerFacet | undefined;
  root: string;
}

export function createSidecarServer(
  backend: SidecarBackend,
): ReturnType<typeof createServer> {
  // 031 ("Look At This" F12): one register for the sidecar's lifetime.
  const focus = new FocusRegister();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?", 1)[0];
    const cors = corsHeaders();
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
    if (path === "/mcp" && req.method === "POST") {
      void (async () => {
        const store = await backend.ready();
        const server = createMcpServer(store, {
          focus,
          search: store,
          containers: backend.containers(),
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        const body = await readJson(req);
        await transport.handleRequest(req, res, body);
      })().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json", ...cors });
        }
        res.end(JSON.stringify({ error: message }));
      });
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

  // The engine payload is REQUIRED (F14: no fs backend left to serve).
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
  readyGate.catch(() => undefined); // observed per request; never unhandled

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
    for (const tenant of [
      "notes",
      "documents",
      "comments",
      "governance",
    ] as const) {
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
    // Catch-up AFTER ready: the working tree seeds/reconciles the store in
    // the background; reads ingest lazily meanwhile.
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
    containers: () => {
      const store = state.store;
      return store === undefined ? undefined : storeFacet(store);
    },
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
    // The ONE stdout line — the Rust shell's handshake. writeSync(1): the
    // compiled bun binary buffers async stdout writes to a redirected file,
    // which starves the parent's handshake read — flush synchronously.
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
  // Orphan guard — OPT-IN (--parent-guard): the spawning parent pipes our
  // stdin and holds it open; if the parent dies, the pipe closes and we exit.
  // Never armed by default: a /dev/null stdin EOFs instantly and would kill
  // a hand-launched sidecar at boot.
  if (parentGuard) {
    process.stdin.resume();
    process.stdin.on("close", shutdown);
    process.stdin.on("end", shutdown);
  }
}

/** The store's facet, re-exposed for the /mcp container verbs. */
function storeFacet(store: LocalEngineStore): ContainerFacet {
  return store.facet;
}

const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
