// Test-only: calliope served exactly as main() serves it (serveCalliope, the
// REST door as the only listener) on an ephemeral port.

import { RequestLog } from "@forge/stellar-core-ts";
import type { RequestRecord } from "@forge/stellar-core-ts";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { serveCalliope } from "../src/mcp/http.js";
import type { ServeOptions } from "../src/mcp/http.js";
import type { Witness } from "../src/mcp/witness.js";

/** A witness whose records land in `got`; `closed()` counts its closes. */
export function recordingWitness(): {
  witness: Witness;
  got: RequestRecord[];
  closed: () => number;
} {
  const got: RequestRecord[] = [];
  let closed = 0;
  return {
    witness: {
      log: new RequestLog("calliope", {
        sink: (r) => {
          got.push(r);
        },
      }),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    },
    got,
    closed: () => closed,
  };
}

/** Serve on an ephemeral REST port; `env` adds to the environment the door reads. */
export async function serveDoor(
  o: Omit<ServeOptions, "getenv">,
  env: Record<string, string> = {},
): Promise<{ rest: RestMount; base: string }> {
  const vars: Record<string, string> = {
    STELLAR_REST_PLAINTEXT_PORT: "0",
    ...env,
  };
  const rest = await serveCalliope({
    kind: "fixture",
    ...o,
    getenv: (k) => vars[k],
  });
  return {
    rest,
    base: `http://127.0.0.1:${String(rest.plaintextAddress()?.port)}`,
  };
}

/** The tool records (the server's door), without the HTTP door's `rest.*` ones. */
export const toolRecords = (got: RequestRecord[]): RequestRecord[] =>
  got.filter((r) => !r.verb.startsWith("rest."));
