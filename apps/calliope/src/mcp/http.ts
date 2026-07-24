#!/usr/bin/env node
/**
 * Calliope-MCP HTTP entry point — the prose facet, exposed as a constellation
 * "star" over streamable-HTTP so the Hades MCP gateway can front it east-west.
 *
 * This serves the SAME four-tool server the stdio bin does ({@link createServer}
 * over the env-selected {@link makeBodyClient} backend) — the tool definitions
 * are reused, never forked. The only difference from `main.ts` is the transport:
 * a {@link StreamableHTTPServerTransport} on `POST /mcp` instead of stdio.
 *
 * Transport mode: stateless. Hades reaches each star with independent
 * `tools/list` / `tools/call` JSON-RPC POSTs (mirroring how this repo's own
 * {@link LiveUraniaCapture} reaches urania) — there is no per-client session to
 * keep, so each request gets a fresh server+transport pair and `GET`/`DELETE`
 * (SSE / session teardown) are not offered. This matches Hades's contract:
 * stars are discovered via live `tools/list` and invoked statelessly.
 *
 * Port: `PORT` (the constellation-standard env every star reads), else
 * `CALLIOPE_MCP_PORT`, else 8204 (calliope's assigned star port).
 * Backend: the same selection as the stdio server — the chaos substrate over
 * `CHAOS_URL` by default (internal-net `http://chaos:8206/mcp`; legacy
 * `URANIA_URL` honored), or the in-memory fixture via
 * `CALLIOPE_MCP_BACKEND=fixture`.
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import type { RevisionStore } from "../revision-store.js";
import { backendKind, initBackend, makeBackend } from "./backend.js";
import { createServer } from "./server.js";
import type { ChaosFacet } from "../chaos-client.js";
import { startHeartbeat } from "./heartbeat.js";

/** The MCP route the gateway dials (Hades: `http://calliope-mcp:8204/mcp`). */
const MCP_PATH = "/mcp";
/** Calliope's assigned constellation star port (clotho 8200, urania 8202, …). */
const DEFAULT_PORT = 8204;

/** Resolve the listen port: PORT, else CALLIOPE_MCP_PORT, else the default. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT ?? env.CALLIOPE_MCP_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORT;
}

/** Read the whole request body (the gateway POSTs a single JSON-RPC envelope). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Serve one POST /mcp request statelessly: build a fresh server bound to the
 * SHARED backend client, attach a session-less transport, and hand the parsed
 * body off. The protocol is stateless (per-request server+transport), but the
 * backend is long-lived — the urania store persists across requests, and a
 * fixture's in-memory body must too — so the {@link BodyClient} is created once
 * and shared, never per-request.
 */
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  client: BodyClient,
  documents?: DocumentStore,
  revisions?: RevisionStore,
  chaos?: ChaosFacet,
): Promise<void> {
  const server = createServer(client, {
    ...(documents !== undefined ? { documents } : {}),
    ...(revisions !== undefined ? { revisions } : {}),
    ...(chaos !== undefined ? { chaos } : {}),
  });
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id, no server-initiated streams to keep alive.
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  const body = await readBody(req);
  await transport.handleRequest(req, res, body);
}

/** Build the bare Node HTTP server (exported for tests). */
export function createCalliopeHttpServer(
  kind: ReturnType<typeof backendKind> = backendKind(),
  prebuilt?: BodyClient,
  documents?: DocumentStore,
  revisions?: RevisionStore,
  chaos?: ChaosFacet,
): ReturnType<typeof createHttpServer> {
  // One backend for the server's lifetime: the store (or fixture memory)
  // is shared across every stateless request. A caller that needs async
  // initialization (the pg backend) builds + inits the client itself and
  // passes it in. When no prebuilt client is given, build the FULL backend
  // so the fixture path serves the document verbs too.
  let docStore = documents;
  let revStore = revisions;
  let chaosFacet = chaos;
  let client = prebuilt;
  if (client === undefined) {
    const backend = makeBackend(kind);
    client = backend.client;
    docStore ??= backend.documents;
    revStore ??= backend.revisions;
    chaosFacet ??= backend.chaos;
  }
  return createHttpServer((req, res) => {
    const url = req.url ?? "";
    const path = url.split("?", 1)[0];

    if (path !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless: only POST is served (no SSE GET / session DELETE).
      res.writeHead(405, {
        "Content-Type": "application/json",
        Allow: "POST",
      });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    handleMcp(req, res, client, docStore, revStore, chaosFacet).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`calliope-mcp-http: request error: ${message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        } else {
          res.end();
        }
      },
    );
  });
}

async function main(): Promise<void> {
  const kind = backendKind();
  const port = resolvePort();
  const host = process.env.HOST ?? "0.0.0.0";
  const backend = makeBackend(kind);
  await initBackend(backend);
  const httpServer = createCalliopeHttpServer(
    kind,
    backend.client,
    backend.documents,
    backend.revisions,
    backend.chaos,
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });
  // stderr only — keep stdout clean (parity with the stdio bin's convention).
  process.stderr.write(
    `calliope-mcp-http: serving (backend=${kind}) on http://${host}:${String(port)}${MCP_PATH}\n`,
  );

  // Publish liveness to Pontus (the op-contract heartbeat) now that we serve.
  const heartbeat = startHeartbeat();

  const shutdown = (): void => {
    void heartbeat.stop();
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run only when invoked as the bin, not when imported by a test — compare the
// resolved entry path (argv[1]) against this module's URL (ESM "is main").
const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `calliope-mcp-http: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
