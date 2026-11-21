import { RequestLog, witnessSink } from "@forge/stellar-core-ts";
import type { WitnessSink } from "@forge/stellar-core-ts";
import { SOURCE_STAR } from "./consciousness-emit.js";

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
      sink: sink.sink,
    }),
    close: () => sink.close(),
  };
}
