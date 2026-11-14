/**
 * The REST face of calliope: its verbs as OpenAPI 3.1 under `/openapi.json`
 * and `/v1/...`, served plain on `STELLAR_REST_PLAINTEXT_PORT`, the star's
 * only listener. A missing or unbindable port refuses the mount.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withSpan } from "@forge/stellar-core-ts";
import { mountRest } from "@forge/stellar-core-ts/rest";
import type { RestHandler, RestMount } from "@forge/stellar-core-ts/rest";
import { actGate } from "../act-gate.js";
import type { ActGateOptions } from "../act-gate.js";

/** What {@link mountRestFace} needs of the process. */
export interface RestFaceOptions {
  /** Builds a server for REST alone: a server serves one transport at a time. */
  readonly build: () => McpServer;
  /** Reads the environment. Default: `process.env`. */
  readonly getenv?: ((name: string) => string | undefined) | undefined;
  /** The authorship gate (act-gate.ts): charon's act assertion, else the
   *  waypoint-verified human caller. Absent mounts the door without it. */
  readonly act?: ActGateOptions | undefined;
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
  return mountRest(o.build, {
    getenv,
    soleListener: true,
    wrap: (next) => spanned(o.act === undefined ? next : actGate(o.act)(next)),
  });
}
