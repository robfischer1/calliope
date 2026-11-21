#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { backendKind, initBackend, prepareBackend } from "./backend.js";
import { makeErosProvider } from "../eros-provider.js";
import { createServer } from "./server.js";
import { makeConsciousnessPublisher } from "./consciousness-emit.js";

async function main(): Promise<void> {
  const kind = backendKind();
  const backend = await prepareBackend(kind);
  await initBackend(backend);
  const consciousness = makeConsciousnessPublisher(process.env);
  const search = makeErosProvider();
  const server = createServer(backend.client, {
    ...(backend.revisions !== undefined
      ? { revisions: backend.revisions }
      : {}),
    ...(backend.chaos !== undefined ? { chaos: backend.chaos } : {}),
    ...(backend.tags !== undefined ? { tags: backend.tags } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(backend.containers !== undefined
      ? { containers: backend.containers }
      : {}),
    ...(consciousness !== undefined ? { consciousness } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`calliope-mcp: serving (backend=${kind}) over stdio\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `calliope-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
