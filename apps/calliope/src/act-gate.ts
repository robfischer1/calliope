/**
 * The REST door's act-assertion gate: a `wrap` for the adapter (rest.ts).
 *
 * It is the only caller of {@link withActAuthor}. Behaviour:
 *  - no waypoint assertion claims: a write verb whose waypoint-verified
 *    caller is a human (caller-author.ts) runs with that human on its async
 *    context, one that is a session or star with that subject (chaos's
 *    on_behalf_of only); any other request passes untouched;
 *  - the waypoint's `x-kairos-assertion-*` claims present (waypoint-assertion.ts):
 *    the request is refused unless the act is this verb, args_sha256 is the
 *    digest of the received arguments and the jti is unspent; then it runs
 *    with the human the claims name.
 */

import type {
  RestHandler,
  RestRequest,
  RestResponse,
} from "@forge/stellar-core-ts/rest";
import {
  ActRefusal,
  WRITE_VERB_PATHS,
  actConfigFromEnv,
  withActAuthor,
  withCallerSubject,
} from "./act-assertion.js";
import type { ActAuthor, ActConfig, JtiStore } from "./act-assertion.js";
import { DigestError } from "./args-digest.js";
import { callerAuthor, callerSubject, xfccService } from "./caller-author.js";
import {
  TOOL_PREFIX,
  assertionArgsSha256,
  digestMatches,
  humanHandle,
  waypointAssertion,
} from "./waypoint-assertion.js";
import type { WaypointAssertion } from "./waypoint-assertion.js";

const MAX_BODY = 8 << 20;

function refusal(e: ActRefusal): RestResponse {
  return {
    status: e.status,
    headers: { "Content-Type": "application/json", "X-Star": "calliope" },
    body: JSON.stringify({ code: e.code, detail: e.message }),
  };
}

export interface ActGateOptions {
  readonly jti: JtiStore;
  readonly config?: ActConfig | undefined;
}

/**
 * The arguments the adapter will assemble for `path` from `body`, as an
 * object: `/live` injects dry_run:false, and a body that contradicts it is
 * refused.
 */
function assembledArgs(path: string, body: string): Record<string, unknown> {
  const parsed: unknown = body.trim() === "" ? {} : JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DigestError("arguments are not an object");
  }
  const args = parsed as Record<string, unknown>;
  if (path.endsWith("/live")) {
    if (args.dry_run !== undefined && args.dry_run !== false) {
      throw new DigestError("dry_run contradicts the path");
    }
    return { ...args, dry_run: false };
  }
  return args;
}

/** Seconds a spent jti is kept: past mesh-opa's 120s exp-iat window and its 30s skew. */
const SPENT_JTI_TTL_S = 300;

/**
 * The waypoint-verified assertion's check: the comparison and the jti spend,
 * never a signature. Answers the author to run the write as.
 */
async function waypointAuthor(
  req: RestRequest,
  claims: WaypointAssertion,
  bytes: Uint8Array,
  o: ActGateOptions,
  trustDomain: string,
): Promise<ActAuthor> {
  const path = req.target;
  const verb = verbOf(path);
  if (claims.act !== `${TOOL_PREFIX}${verb}`) {
    throw new ActRefusal(
      403,
      "act_assertion_forbidden",
      "the assertion names another act",
    );
  }
  let args: Record<string, unknown>;
  try {
    args = assembledArgs(path, new TextDecoder().decode(bytes));
  } catch {
    throw new ActRefusal(401, "act_assertion_invalid", "malformed");
  }
  if (
    !digestMatches(claims.argsSha256, assertionArgsSha256(claims.act, args))
  ) {
    throw new ActRefusal(
      401,
      "act_assertion_invalid",
      "args do not match the assertion",
    );
  }
  const handle = humanHandle(claims.azp, trustDomain);
  if (handle === undefined) {
    throw new ActRefusal(
      401,
      "act_assertion_invalid",
      "azp is not a human of this trust domain",
    );
  }
  let fresh: boolean;
  try {
    fresh = await o.jti.claimJti(
      claims.jti,
      Math.floor(Date.now() / 1000) + SPENT_JTI_TTL_S,
    );
  } catch {
    throw new ActRefusal(
      503,
      "act_assertion_unavailable",
      "single use could not be recorded",
    );
  }
  if (!fresh) {
    throw new ActRefusal(401, "act_assertion_replayed", "already used");
  }
  return {
    authoredBy: `human/${handle}`,
    subject: `spiffe://${trustDomain}/human/${handle}`,
    via: xfccService(req.headers),
    jti: claims.jti,
    verb,
  };
}

/** `write_container` of `/v1/write_container`, `delete_note` of `/v1/delete_note/live`. */
function verbOf(path: string): string {
  return path.slice("/v1/".length).split("/")[0] ?? "";
}

/** The wrap: `(next) => handler` for {@link mountRestFace}. */
export function actGate(o: ActGateOptions): (next: RestHandler) => RestHandler {
  const config = o.config ?? actConfigFromEnv();
  return (next) => async (req: RestRequest) => {
    const claims = waypointAssertion(req.headers);
    if (claims !== undefined) {
      try {
        if (claims === "incomplete") {
          throw new ActRefusal(401, "act_assertion_invalid", "malformed");
        }
        if (
          (req.method !== "POST" && req.method !== "DELETE") ||
          !WRITE_VERB_PATHS.has(req.target)
        ) {
          throw new ActRefusal(
            403,
            "act_assertion_forbidden",
            "an act assertion rides only the note write verbs",
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = await req.body(MAX_BODY);
        } catch {
          throw new ActRefusal(413, "act_assertion_invalid", "unreadable body");
        }
        const author = await waypointAuthor(
          req,
          claims,
          bytes,
          o,
          config.trustDomain,
        );
        const replay: RestRequest = {
          ...req,
          body: () => Promise.resolve(bytes),
        };
        return await withActAuthor(author, () => next(replay));
      } catch (e) {
        if (e instanceof ActRefusal) return refusal(e);
        throw e;
      }
    }
    const write =
      (req.method === "POST" || req.method === "DELETE") &&
      WRITE_VERB_PATHS.has(req.target);
    if (!write) return next(req);
    const author = callerAuthor(
      req.headers,
      config.trustDomain,
      verbOf(req.target),
    );
    if (author !== undefined) return withActAuthor(author, () => next(req));
    // A session or star the waypoint verified: no authorship row, but its
    // chaos writes say who they were for.
    const subject = callerSubject(req.headers, config.trustDomain);
    return subject === undefined
      ? next(req)
      : withCallerSubject(subject, () => next(req));
  };
}
