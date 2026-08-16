#!/usr/bin/env node
/**
 * The Grace sidecar entry (G2) — Calliope over a DIRECTORY, for the desktop
 * surface: an {@link FsBodyClient} behind the same `{verb, args}` ferry wire
 * Charon's `/body` route speaks (read_body / write_body / apply_section_ops),
 * so the desktop app uses ONE client class for the local and remote windows.
 *
 * Boot contract (the Rust shell parses it):
 *  - argv: `--root <directory>` (required) `--port <n>` (default 0 = ephemeral)
 *  - binds 127.0.0.1 ONLY; nothing listens beyond the machine
 *  - exactly ONE stdout line: `{"event":"listening","port":<N>}` — stdout is
 *    otherwise silent (the stdio-bin convention); logs go to stderr
 *  - exits 0 on SIGTERM/SIGINT and on stdin close (the orphan guard: a parent
 *    that crashed without killing us closes our piped stdin)
 *  - exits 1 on a bad root or bind failure
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
import { FsBodyClient } from "../fs-client.js";
import { FocusRegister } from "../focus-register.js";
import { fsListByTag, fsListTags } from "../fs-tags.js";
import { LocalSearchIndex } from "../fs-search/index.js";
import type { SearchResponse } from "../fs-search/index.js";
import { LocalChaosDial } from "../local-admit.js";
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

/** Honest darkness when no index is wired (mirrors the MCP no-provider path). */
const NO_PROVIDER: SearchResponse = {
  hits: [],
  armsQueried: [],
  armsDark: ["fts", "semantic"],
};

async function dispatch(
  client: FsBodyClient,
  body: unknown,
  search?: LocalSearchIndex,
): Promise<unknown> {
  const envelope = body as { verb?: unknown; args?: unknown } | undefined;
  if (envelope === undefined || typeof envelope.verb !== "string") {
    throw new Error("bad_request: expected {verb, args}.");
  }
  const args = (envelope.args ?? {}) as Record<string, unknown>;
  const nodeId = typeof args.node_id === "string" ? args.node_id : "";
  switch (envelope.verb) {
    case "read_body":
      return readBody(client, nodeId);
    case "write_body":
      return writeBody(client, nodeId, (args.sections ?? []) as SectionInput[]);
    case "apply_section_ops":
      return applySectionOps(
        client,
        nodeId,
        (args.ops ?? []) as WireSectionOp[],
      );
    case "read_body_revisions":
      return readBodyRevisions(
        client,
        nodeId,
        typeof args.limit === "number" ? args.limit : undefined,
      );
    case "read_body_at":
      return readBodyAt(
        client,
        nodeId,
        typeof args.revision === "string" ? args.revision : "",
      );
    // 024/F1 — the compound reference, path form: on the fs backend the
    // path IS the node identity, so the id half is the path itself and the
    // title is the basename. A missing file still gets a reference (the
    // path is a valid address before its first write), but a malformed or
    // escaping path refuses exactly as every other verb.
    case "copy_reference": {
      await readBody(client, nodeId); // path validation, same refusals
      const base = nodeId.split("/").pop() ?? nodeId;
      const title = base.replace(/\.(md|markdown)$/i, "");
      return {
        ...formatCompoundReference(title, nodeId),
        address_form: "path",
      };
    }
    // F12 — tags offline: a COMPUTED index over the served directory, no
    // graph call anywhere (the sidecar carries no dial, so "no hasTag edge
    // offline" holds by construction).
    case "list_tags":
      return fsListTags(client.root);
    case "list_by_tag":
      return fsListByTag(
        client.root,
        typeof args.tag === "string" ? args.tag : "",
      );
    // Findability F11 — mentions(id): true linked mentions + unlinked
    // candidates over the same index; never extent-bounded.
    case "mentions": {
      const id = typeof args.id === "string" ? args.id : "";
      if (id.trim() === "") {
        throw new Error("bad_request: mentions needs a node id.");
      }
      if (search === undefined) return { linked: [], unlinked: [] };
      return search.mentions(id);
    }
    // Findability F2 — search(query, scope): the fs backend's two local arms
    // (FTS5 + semantic) RRF-fused; degraded arms are NAMED in the envelope.
    case "search": {
      const query = typeof args.query === "string" ? args.query : "";
      if (query.trim() === "") {
        throw new Error("bad_request: search needs a non-empty query.");
      }
      if (search === undefined) return NO_PROVIDER;
      return search.search(
        query,
        typeof args.scope === "string" ? args.scope : undefined,
        typeof args.k === "number" ? args.k : undefined,
      );
    }
    default:
      throw new Error(`unsupported_verb: ${envelope.verb}`);
  }
}

/** The engine's boot lifecycle, as /health reports it. `absent` = no
 *  payload beside the exe (fs-only deployment, the transition posture). */
export type EngineState = "absent" | "booting" | "ready" | "failed";

/** The sidecar's live view of the baby-chaos engine — read PER REQUEST,
 *  so /mcp grows the container verbs the moment the engine turns ready
 *  without a listener restart. */
export interface EngineView {
  state: () => EngineState;
  containers: () => ContainerFacet | undefined;
  /** Loopback service ports once ready — /health diagnostics. */
  ports: () => { pg: number; chaos: number } | null;
}

const NO_ENGINE: EngineView = {
  state: () => "absent",
  containers: () => undefined,
  ports: () => null,
};

export function createSidecarServer(
  client: FsBodyClient,
  extras?: { search?: LocalSearchIndex; engine?: EngineView },
): ReturnType<typeof createServer> {
  // 031 ("Look At This" F12): one register for the sidecar's lifetime —
  // honestly empty until something local feeds it; `look` answers
  // { focus: null, pins: [] } rather than pretending.
  const focus = new FocusRegister();
  const search = extras?.search;
  const engine = extras?.engine ?? NO_ENGINE;
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
          ok: true,
          root: client.root,
          backend: "fs",
          engine: engine.state(),
          engine_ports: engine.ports(),
        }),
      );
      return;
    }
    // 031 ("Look At This" F12, Fable Wave 6.3 pulled forward): the sidecar's
    // verbs over MCP — the same contract agents already speak to calliope
    // fleet-side, on the same loopback-only listener the ferry rides
    // (off-host refusal is connection-level; the bind never widens). The
    // proven calliope-mcp-http pattern: a stateless per-request server +
    // transport over the SHARED FsBodyClient.
    if (path === "/mcp" && req.method === "POST") {
      void (async () => {
        const server = createMcpServer(client, {
          focus,
          search,
          containers: engine.containers(),
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
    readJson(req)
      .then((body) => dispatch(client, body, search))
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(result));
      })
      .catch((err: unknown) => {
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

  // Findability F2 — the local search index over the served root. Opens
  // instantly; catch-up scan, watcher, and encoder init run in the
  // background, so the boot handshake below never waits on them.
  const index = LocalSearchIndex.open(root);
  const client = new FsBodyClient(root, {
    onWrite: (nodeId) => {
      index.noteWritten(nodeId);
    },
  });

  // Baby chaos (045 F13) — the REAL engine beside the fs surface. The
  // payload rides beside the exe (or CALLIOPE_BABYCHAOS_DIR in dev); a
  // deployment without one keeps the fs-only posture. Boot runs in the
  // BACKGROUND: the handshake below never waits on initdb, and /mcp grows
  // the container verbs the moment the facet lands (per-request read).
  // Supervision is crash-only: a child dying AFTER boot exits the whole
  // sidecar and Grace's respawn ladder brings the stack back. A boot
  // FAILURE does not exit — respawn would loop into the same failure, and
  // the fs surface is still worth serving; /health says `failed`.
  const engineRef: {
    state: EngineState;
    facet?: ContainerFacet;
    engine?: Engine;
  } = { state: "absent" };
  const engineView: EngineView = {
    state: () => engineRef.state,
    containers: () => engineRef.facet,
    ports: () => {
      const engine = engineRef.engine;
      return engine === undefined
        ? null
        : { pg: engine.pgPort, chaos: engine.chaosPort };
    },
  };
  const payload = resolvePayload(process.env, dirname(execPath));
  if (payload !== null) {
    engineRef.state = "booting";
    void (async () => {
      const engine = await startEngine(payload, root, (what) => {
        process.stderr.write(
          `calliope-sidecar: engine child died (${what}) — crash-only exit\n`,
        );
        exit(1);
      });
      engineRef.engine = engine;
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
      engineRef.facet = { blobs: new BlobStore(pool), dial };
      engineRef.state = "ready";
      process.stderr.write(
        `calliope-sidecar: engine ready (pg 127.0.0.1:${String(engine.pgPort)}, ` +
          `chaos 127.0.0.1:${String(engine.chaosPort)})\n`,
      );
    })().catch((err: unknown) => {
      engineRef.state = "failed";
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `calliope-sidecar: engine boot failed — serving fs-only: ${message}\n`,
      );
    });
  }

  const server = createSidecarServer(client, {
    search: index,
    engine: engineView,
  });
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
      `calliope-sidecar: serving ${client.root} on http://127.0.0.1:${String(actual)}\n`,
    );
  });

  const shutdown = (): void => {
    index.close();
    const finish = (): void => {
      server.close(() => {
        exit(0);
      });
    };
    // Engine children stop in reverse order (startEngine's own stop); its
    // stopping flag suppresses the crash-only onExit during a clean stop.
    const engine = engineRef.engine;
    engineRef.engine = undefined;
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

const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
