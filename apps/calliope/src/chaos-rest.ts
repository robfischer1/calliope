/**
 * chaos over its openapi-http face (REST mesh P4): calliope's reads dialled
 * as calliope-sa on chaos's plaintext REST door (`CALLIOPE_CHAOS_REST_URL`,
 * e.g. `http://chaos:8209`) with stellar-core-ts's RestClient, instead of a
 * `tools/call` on the mTLS `/mcp` door.
 *
 * Whether calliope-sa may reach chaos is Cilium's, at the port; which verbs
 * the session may call is its token's scope. No caller identity rides the
 * request. {@link CHAOS_MCP_ONLY} keeps any verb the REST face lacks on `/mcp`.
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
 * Verbs calliope sends chaos that the REST face does not carry. Empty: register_graph (the migration tools' per-tenant graph ensure)
 * rides POST /v1/register_graph since REST mesh P7 (wonka68-rm15), when
 * grants-chaos admitted calliope-sa on it and chaos's mTLS /mcp closed.
 */
export const CHAOS_MCP_ONLY: ReadonlySet<string> = new Set<string>();

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
