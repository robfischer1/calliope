/**
 * The REST face of calliope: its verbs as OpenAPI 3.1 under `/openapi.json`
 * and `/v1/...`, on the REST door, the star's ONLY listener (REST mesh P7,
 * wonka68-rm39: `soleListener`, no `/mcp`).
 *
 * The server REST dials in process is built by `createServer` with the witness
 * and the PEP armed (the door), so every REST call is witnessed and held to the
 * PEP. A server with no door is refused (`mountWitnessed`), as is a missing or
 * unbindable `STELLAR_REST_PLAINTEXT_PORT`: the star never serves half a door.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withSpan } from "@forge/stellar-core-ts";
import { mountWitnessed } from "@forge/stellar-core-ts/rest";
import type { RestHandler, RestMount } from "@forge/stellar-core-ts/rest";
import { SOURCE_STAR } from "./consciousness-emit.js";
import type { Witness } from "./witness.js";

/** What {@link mountRestFace} needs of the process. */
export interface RestFaceOptions {
  /** Builds a server for REST alone: a server serves one transport at a time. */
  readonly build: () => McpServer;
  readonly witness: Witness;
  /** Reads the environment. Default: `process.env`. */
  readonly getenv?: ((name: string) => string | undefined) | undefined;
}

/**
 * One span per served request, named by method and face, never the raw path
 * (a path carries whatever a caller typed: unbounded span names). stellar-core-ts
 * wires the provider and exporter but installs no instrumentation, so without
 * this the star is configured and silent in Tempo.
 */
export function spanned(next: RestHandler): RestHandler {
  return (req) => withSpan(`${req.method} /v1`, () => next(req));
}

/** Mount the REST door; rejects (never half-mounts) when the mount is refused. */
export async function mountRestFace(o: RestFaceOptions): Promise<RestMount> {
  const getenv = o.getenv ?? ((k: string) => process.env[k]);
  return mountWitnessed(o.build, {
    star: SOURCE_STAR,
    log: o.witness.log,
    getenv,
    soleListener: true,
    wrap: spanned,
  });
}
