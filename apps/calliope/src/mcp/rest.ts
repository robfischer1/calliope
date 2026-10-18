/**
 * The REST face of calliope: the same verbs the MCP door serves, as OpenAPI 3.1
 * under `/openapi.json` and `/v1/...`, behind `STELLAR_REST=1`.
 *
 * Mounted AFTER the MCP door is armed: the server REST dials in process is
 * built by the same `createServer` with the same witness and PEP, so a REST call
 * is witnessed and held to the PEP exactly as an MCP call is. Mounted before
 * that, `mountWitnessed` refuses (the server has no door). Off, nothing is
 * mounted and nothing registered.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoopbackPeers } from "@forge/stellar-core-ts/mtlsdoor";
import { mountWitnessed, restEnabled } from "@forge/stellar-core-ts/rest";
import type { Mux, RestMount } from "@forge/stellar-core-ts/rest";
import { SOURCE_STAR } from "./consciousness-emit.js";
import type { Witness } from "./witness.js";

/** What {@link mountRestFace} needs of the process. */
export interface RestFaceOptions {
  /** Builds a server for REST alone: a server serves one transport at a time. */
  readonly build: () => McpServer;
  readonly witness: Witness;
  readonly peers: LoopbackPeers;
  readonly mux: Mux;
  /** Reads the environment. Default: `process.env`. */
  readonly getenv?: (name: string) => string | undefined;
}

/**
 * Mount REST when `STELLAR_REST=1`; resolves undefined when it is off. Rejects
 * (never half-mounts) when the mount is refused, so the boot fails before the
 * star serves a REST face the witness cannot see.
 */
export async function mountRestFace(
  o: RestFaceOptions,
): Promise<RestMount | undefined> {
  const getenv = o.getenv ?? ((k: string) => process.env[k]);
  if (!restEnabled(getenv)) return undefined;
  return mountWitnessed(o.build, {
    star: SOURCE_STAR,
    log: o.witness.log,
    peers: o.peers,
    mux: o.mux,
    getenv,
  });
}
