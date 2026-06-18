/**
 * Backend selection for Calliope-MCP: pick the {@link BodyClient} the tool
 * handlers run against, from the environment.
 *
 *  - default: a wired {@link UraniaBodyClient} over {@link LiveUraniaCapture},
 *    writing the SAME urania substrate clotho does (env: `URANIA_URL`). This is
 *    the production prose facet.
 *  - `CALLIOPE_MCP_BACKEND=fixture`: an in-memory {@link FixtureBodyClient} —
 *    for a safe standalone/dev server and for the tool tests.
 *
 * The live wire is gated by `CALLIOPE_URANIA_WIRED` inside
 * {@link UraniaBodyClient} (the lib's existing seam) — this factory sets it on
 * for the live backend so the injected transport is honored.
 */

import type { BodyClient } from "../types.js";
import { FixtureBodyClient } from "../fixture-client.js";
import { UraniaBodyClient } from "../urania-client.js";
import { LiveUraniaCapture } from "./live-capture.js";

/** How the MCP reaches the body model. */
export type BackendKind = "urania" | "fixture";

/** Read the configured backend kind (default: live urania). */
export function backendKind(): BackendKind {
  return process.env.CALLIOPE_MCP_BACKEND === "fixture" ? "fixture" : "urania";
}

/**
 * Build the {@link BodyClient} for the configured backend. For the live urania
 * backend, flip the lib's `CALLIOPE_URANIA_WIRED` seam on and inject a live
 * {@link LiveUraniaCapture} (env `URANIA_URL`).
 */
export function makeBodyClient(kind: BackendKind = backendKind()): BodyClient {
  if (kind === "fixture") {
    return new FixtureBodyClient();
  }
  // The UraniaBodyClient guards its transport behind CALLIOPE_URANIA_WIRED; the
  // live server opts in. (clotho-parity: the engine-service is the write path.)
  process.env.CALLIOPE_URANIA_WIRED = "1";
  return new UraniaBodyClient(new LiveUraniaCapture(process.env.URANIA_URL));
}
