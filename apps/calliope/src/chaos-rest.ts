/**
 * chaos over its openapi-http face (REST mesh P4): calliope's reads dialled
 * as calliope-sa on chaos's plaintext REST door (`CALLIOPE_CHAOS_REST_URL`,
 * e.g. `http://chaos:8209`) with stellar-core-ts's RestClient, instead of a
 * `tools/call` on the mTLS `/mcp` door.
 *
 * Authorization is Cilium's: flux grants-chaos admits calliope-sa on exactly
 * the compiled star:calliope routes and stamps `X-Forge-Peer: calliope`,
 * which chaos (attributed) reads as the caller. A verb outside that grant is
 * dropped by the proxy, so {@link CHAOS_MCP_ONLY} keeps those on `/mcp`.
 *
 * Unset `CALLIOPE_CHAOS_REST_URL` is today's behaviour: every chaos call
 * rides `/mcp`. Setting it is the flip; unsetting it is the revert.
 */

import {
  RestClient,
  ToolError,
  type RestReply,
} from "@forge/stellar-core-ts/rest";

/**
 * Verbs calliope sends chaos that grants-chaos does not admit calliope-sa
 * to: register_graph is a write, called once per tenant by the migration
 * tools, and no compiled grant gives calliope it.
 */
export const CHAOS_MCP_ONLY: ReadonlySet<string> = new Set(["register_graph"]);

/** A refusal chaos wrote (X-Star set): its `{code, detail}` and text. */
export interface ChaosRefusal {
  readonly code: string;
  readonly detail: string;
  readonly text: string;
}

/** What one REST call answered, before calliope shapes it. */
export type ChaosRestAnswer =
  | { readonly ok: true; readonly reply: RestReply }
  | { readonly ok: false; readonly refusal: ChaosRefusal };

/** The REST dial onto chaos's openapi-http door. */
export class ChaosRest {
  readonly #client: RestClient;
  readonly #timeoutMs: number;

  constructor(base: string, timeoutMs: number, fetchFn?: typeof fetch) {
    this.#client = new RestClient(
      fetchFn === undefined ? { base } : { base, fetch: fetchFn },
    );
    this.#timeoutMs = timeoutMs;
  }

  /** Whether verb goes over REST (false: it stays on `/mcp`). */
  serves(verb: string): boolean {
    return !CHAOS_MCP_ONLY.has(verb);
  }

  /**
   * One call. A star refusal comes back as `ok: false`; anything else that
   * fails (route miss, proxy drop, transport) throws as RestClient threw it.
   */
  async call(
    verb: string,
    args: Record<string, unknown>,
  ): Promise<ChaosRestAnswer> {
    try {
      const reply = await this.#client.call(verb, args, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      return { ok: true, reply };
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          ok: false,
          refusal: { code: err.code, detail: err.detail, text: err.text },
        };
      }
      throw err;
    }
  }
}

/** The CALLIOPE_CHAOS_REST_URL dial, or undefined when the flip is off. */
export function chaosRestFromEnv(
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): ChaosRest | undefined {
  const base = env.CALLIOPE_CHAOS_REST_URL?.trim() ?? "";
  return base === "" ? undefined : new ChaosRest(base, timeoutMs);
}
