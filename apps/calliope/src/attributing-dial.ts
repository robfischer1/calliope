/**
 * The write seam of the act assertion: every graph transaction a VERIFIED
 * request lands is recorded, in calliope's own store, as written for that
 * request's human via star/charon.
 *
 * A Proxy rather than a subclass so the dial keeps its class (tests read the
 * fixture's `admits`) and every other member passes straight through. Only
 * `admit` is intercepted; with no verified author on the async context (every
 * unattributed request, every background job) it is a pure pass-through.
 *
 * If the record cannot be written the write has ALREADY landed, so this throws
 * a wire_error naming the tx: the caller sees a failure, never a silent
 * unattributed success.
 */

import { actAuthor } from "./act-assertion.js";
import { ChaosClientError } from "./chaos-client.js";
import type { AdmitResult, ChaosDial } from "./chaos-client.js";
import type { WriteAuthorship } from "./revision-store.js";

/** Where authorship rows go. */
export interface AuthorshipSink {
  recordAuthorship(row: WriteAuthorship): Promise<void>;
}

export function attributing<T extends ChaosDial>(
  dial: T,
  sink: AuthorshipSink,
): T {
  return new Proxy(dial, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop !== "admit") return fn.bind(target);
      return async (...args: unknown[]): Promise<AdmitResult> => {
        const res = (await fn.apply(target, args)) as AdmitResult;
        const author = actAuthor();
        if (author === undefined || !res.admitted || res.tx === undefined) {
          return res;
        }
        try {
          await sink.recordAuthorship({
            tx: res.tx,
            scope: String(args[1]),
            authored_by: author.authoredBy,
            via: author.via,
            verb: author.verb,
            jti: author.jti,
          });
        } catch (err) {
          throw new ChaosClientError(
            `admit: tx ${String(res.tx)} landed but its authorship could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
            "wire_error",
          );
        }
        return res;
      };
    },
  });
}
