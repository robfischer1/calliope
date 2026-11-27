import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withSpan } from "@forge/stellar-core-ts";
import {
  ROB_CLASS_HUMAN,
  ROB_TIER_ATTRIBUTED,
  declareRobTier,
  mountRest,
} from "@forge/stellar-core-ts/rest";
import type {
  RestHandler,
  RestMount,
  RobTierRow,
} from "@forge/stellar-core-ts/rest";
import { actGate } from "../act-gate.js";
import type { ActGateOptions } from "../act-gate.js";

/** The star's roster key: its X-Star, and its name on a staircase. */
export const STAR = "calliope";

// Rob's own note writes carry his act assertion (Charon mints it): each is an
// attributed rob-tier act, class human. Declared here, the served and the
// committed openapi.json publish the rows as x-mcp-tools[verb]["x-rob-tier"],
// and the door refuses a landing that removes or loosens one without Rob.
const attributed: readonly RobTierRow[] = [
  { tier: ROB_TIER_ATTRIBUTED, class: ROB_CLASS_HUMAN },
];
declareRobTier(STAR, {
  create_note: attributed,
  delete_note: attributed,
  move_blocks: attributed,
  restore_note: attributed,
  set_properties: attributed,
  write_container: attributed,
});

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
    star: STAR,
    getenv,
    soleListener: true,
    wrap: (next) => spanned(o.act === undefined ? next : actGate(o.act)(next)),
  });
}
