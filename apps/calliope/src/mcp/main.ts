#!/usr/bin/env bun
/**
 * Calliope-MCP entry point — the prose facet, exposed to LLMs over stdio.
 *
 * Selects a {@link BodyClient} backend from the environment (`pg` — the
 * sovereign store — is the default since F2, and a missing `DATABASE_URL`
 * fails the boot; `hades` when `CALLIOPE_WRITE_VIA_HADES`/`CHARON_URL` is
 * set; `CALLIOPE_MCP_BACKEND=urania` explicitly for the graph-substrate
 * hatch; `CALLIOPE_MCP_BACKEND=fixture` for a safe standalone server),
 * builds the server (four-to-nine tools, depending on which facet stores
 * the backend supplies), and serves it over stdio. This is the
 * `calliope-mcp` bin — a separate entry from the lib, so the lib build and
 * the Tantalus-facing `@forge/calliope` export are unaffected.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { backendKind, initBackend, makeBackend } from "./backend.js";
import { makeErosProvider } from "../eros-provider.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const kind = backendKind();
  const backend = makeBackend(kind);
  await initBackend(backend);
  // Findability F4: the eros-routed pg search arm (env-gated).
  const search = makeErosProvider();
  const server = createServer(backend.client, {
    ...(backend.revisions !== undefined
      ? { revisions: backend.revisions }
      : {}),
    ...(backend.chaos !== undefined ? { chaos: backend.chaos } : {}),
    ...(backend.tags !== undefined ? { tags: backend.tags } : {}),
    ...(search !== undefined ? { search } : {}),
    // F12 audit finding: the container surface (F4/F5) was wired in
    // the BACKEND but never passed to the server — the fleet entry
    // points served body verbs only. With the families retired, the
    // container verbs ARE the write path; they ship from here.
    ...(backend.containers !== undefined
      ? { containers: backend.containers }
      : {}),
  });
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
