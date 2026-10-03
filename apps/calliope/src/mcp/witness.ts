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
 * It records and refuses nothing. Calliope has no mTLS listener, so every
 * caller reads `unidentified` with path `unknown` — correct, and expected until
 * the star grows one; the stamp is already in the path and will name them then.
 */

import { RequestLog, witnessSink } from "@forge/stellar-core-ts";
import type { WitnessSink } from "@forge/stellar-core-ts";
import { SOURCE_STAR } from "./consciousness-emit.js";

/**
 * The verb prefix the gateway namespaces this star under — its fleet record's
 * `verb_prefix` (foundry-dies `fleet/stars/calliope/data.json`), NOT the star's
 * name. The two agree today; the record is the authority, and the wire form of
 * every verb is derived from it, so a rename of one must not drag the other.
 */
export const VERB_PREFIX = "calliope";

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
      verbPrefix: VERB_PREFIX,
      sink: sink.sink,
    }),
    close: () => sink.close(),
  };
}
