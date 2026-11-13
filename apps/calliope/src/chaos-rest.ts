/**
 * chaos over its openapi-http face: calliope's reads dialled on chaos's
 * plaintext REST door (`CALLIOPE_CHAOS_REST_URL`, e.g. `http://chaos`)
 * with stellar-core-ts's RestClient. Whether calliope-sa may reach chaos is
 * Cilium's, at the port; no caller identity rides the request.
 */

import {
  RestClient,
  ToolError,
  type RestReply,
} from "@forge/stellar-core-ts/rest";

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
