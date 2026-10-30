/**
 * The witness — calliope's inbound request log (Constellation Mesh wave 2).
 *
 * Every Go star records one request record per inbound `tools/call` to its log
 * stream and to `<star>._ops.calls`, and nyx builds the witnessed call graph
 * from those topics. Calliope recorded nothing, so every edge into it was
 * invisible. This wires `@forge/stellar-core-ts`'s witness: the record, the
 * peer stamp (http.ts wraps the listener with it), the dispatcher interceptor
 * (server.ts installs it) and the sink (built here from `KAFKA_BOOTSTRAP`).
 *
 * It records and refuses nothing (the PEP, `@forge/stellar-core-ts/pep`, decides on the same record).
 * Callers reach calliope on its REST door (openapi-http), where the Cilium
 * X-Forge-Peer stamp names them; the mTLS door is gone (REST mesh P7). A call
 * on the loopback MCP port reads `unidentified` with path `unknown`.
 */

import { RequestLog, witnessSink } from "@forge/stellar-core-ts";
import type { WitnessSink } from "@forge/stellar-core-ts";
import { SOURCE_STAR } from "./consciousness-emit.js";
import { withDenyDecision } from "@forge/stellar-core-ts/pep";

/** A request log and what to release when the process ends. */
export interface Witness {
  readonly log: RequestLog;
  /** Close the sink's producer. Never throws. */
  close(): Promise<void>;
}

/**
 * Build this star's witness from the environment: records go to the log
 * stream, and to `<star>._ops.calls` when `KAFKA_BOOTSTRAP` names a broker.
 * No broker leaves it on the log stream, warned once. Never throws.
 */
export function makeWitness(
  env: NodeJS.ProcessEnv = process.env,
  build: typeof witnessSink = witnessSink,
): Witness {
  const sink: WitnessSink = build({
    star: SOURCE_STAR,
    bootstrap: env.KAFKA_BOOTSTRAP,
  });
  return {
    log: new RequestLog(SOURCE_STAR, {
      sink: withDenyDecision(sink.sink),
    }),
    close: () => sink.close(),
  };
}
