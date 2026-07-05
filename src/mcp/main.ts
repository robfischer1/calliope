#!/usr/bin/env node
/**
 * Calliope-MCP entry point — the prose facet, exposed to LLMs over stdio.
 *
 * Selects a {@link BodyClient} backend from the environment (live urania by
 * default; `CALLIOPE_MCP_BACKEND=fixture` for a safe standalone server), builds
 * the four-tool server, and serves it over stdio. This is the `calliope-mcp`
 * bin — a separate entry from the lib, so the lib build and the Tantalus-facing
 * `@forge/calliope` export are unaffected.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { backendKind, initBackend, makeBackend } from "./backend.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const kind = backendKind();
  const backend = makeBackend(kind);
  await initBackend(backend);
  const server = createServer(
    backend.client,
    backend.documents === undefined
      ? undefined
      : { documents: backend.documents },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport channel.
  process.stderr.write(`calliope-mcp: serving (backend=${kind}) over stdio\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `calliope-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
