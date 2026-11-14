/**
 * The REST door's act-assertion gate: a `wrap` for the adapter (rest.ts).
 *
 * It is the only place the header is read, and the only caller of
 * {@link withActAuthor}. Behaviour:
 *  - no `x-charon-act-assertion` header: a write verb whose waypoint-verified
 *    caller is a human (caller-author.ts) runs with that human on its async
 *    context; any other request passes untouched;
 *  - the header present (even empty, even repeated): the request is refused
 *    unless the assertion verifies for THIS request (POST of one
 *    of the six write verbs with no query, digest of the received body), and
 *    then it runs with the human on its async context.
 *  - the waypoint's `x-kairos-assertion-*` claims present (waypoint-assertion.ts):
 *    the request is refused unless the act is this verb, args_sha256 is the
 *    digest of the received arguments and the jti is unspent; then it runs
 *    with the human the claims name. Beside the legacy header it is refused.
 * Header-name case is the HTTP layer's (RestHeaders is case-insensitive).
 */

import type {
  RestHandler,
  RestRequest,
  RestResponse,
} from "@forge/stellar-core-ts/rest";
import {
  ACT_ASSERTION_HEADER,
  ActRefusal,
  JwksCache,
  WRITE_VERB_PATHS,
  actConfigFromEnv,
  verifyActAssertion,
  withActAuthor,
} from "./act-assertion.js";
import type {
  ActAuthor,
  ActConfig,
  FetchLike,
  JtiStore,
} from "./act-assertion.js";
import { argsDigest, DigestError, parseRaw } from "./args-digest.js";
import { callerAuthor, xfccService } from "./caller-author.js";
import {
  TOOL_PREFIX,
  assertionArgsSha256,
  digestMatches,
  humanHandle,
  waypointAssertion,
} from "./waypoint-assertion.js";
import type { WaypointAssertion } from "./waypoint-assertion.js";
import type { RawObj } from "./args-digest.js";

const MAX_BODY = 8 << 20;
const TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

function refusal(e: ActRefusal): RestResponse {
  return {
    status: e.status,
    headers: { "Content-Type": "application/json", "X-Star": "calliope" },
    body: JSON.stringify({ code: e.code, detail: e.message }),
  };
}

/**
 * The digest of the arguments the adapter will assemble for `path` from `body`:
 * the body, with the path's own dangerous value (`/live` is dry_run:false)
 * injected as the adapter injects it. A body that contradicts its path would be
 * refused by the adapter; it is refused here too, so the digest is never taken
 * over arguments that will not run.
 */
function assembledDigest(path: string, body: string): string {
  const raw = body.trim() === "" ? new Map() : parseRaw(body);
  if (!(raw instanceof Map))
    throw new DigestError("arguments are not an object");
  const args: RawObj = raw as RawObj;
  if (path.endsWith("/live")) {
    const have = args.get("dry_run");
    if (have !== undefined && have !== false) {
      throw new DigestError("dry_run contradicts the path");
    }
    args.set("dry_run", false);
  }
  return argsDigest(args);
}

export interface ActGateOptions {
  readonly jti: JtiStore;
  readonly config?: ActConfig | undefined;
  readonly fetch?: FetchLike | undefined;
}

/**
 * The arguments the adapter will assemble for `path` from `body`, as an
 * object: `/live` injects dry_run:false, and a body that contradicts it is
 * refused, as in {@link assembledDigest}.
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
  const keys =
    config.jwksUrl === "" ? undefined : new JwksCache(config.jwksUrl, o.fetch);
  return (next) => async (req: RestRequest) => {
    const values = req.headers.getAll(ACT_ASSERTION_HEADER);
    const claims = waypointAssertion(req.headers);
    if (claims !== undefined) {
      try {
        if (claims === "incomplete" || values.length !== 0) {
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
    if (values.length === 0) {
      const write =
        (req.method === "POST" || req.method === "DELETE") &&
        WRITE_VERB_PATHS.has(req.target);
      const author = write
        ? callerAuthor(req.headers, config.trustDomain, verbOf(req.target))
        : undefined;
      return author === undefined
        ? next(req)
        : withActAuthor(author, () => next(req));
    }
    try {
      const token = values[0] ?? "";
      if (values.length !== 1 || !TOKEN_RE.test(token)) {
        throw new ActRefusal(401, "act_assertion_invalid", "malformed");
      }
      const path = req.target;
      // A mutation is POST, a destructive one (write_container, delete_note) DELETE.
      if (
        (req.method !== "POST" && req.method !== "DELETE") ||
        !WRITE_VERB_PATHS.has(path)
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
      let digest: string;
      try {
        digest = assembledDigest(path, new TextDecoder().decode(bytes));
      } catch (e) {
        if (!(e instanceof DigestError)) throw e;
        throw new ActRefusal(401, "act_assertion_invalid", "malformed");
      }
      const author = await verifyActAssertion({
        token,
        argsSha256: digest,
        verb: path,
        config,
        keys,
        jti: o.jti,
      });
      // The adapter reads the body itself: hand it the bytes verified here.
      const replay: RestRequest = {
        ...req,
        body: () => Promise.resolve(bytes),
      };
      return await withActAuthor(author, () => next(replay));
    } catch (e) {
      if (e instanceof ActRefusal) return refusal(e);
      throw e;
    }
  };
}
