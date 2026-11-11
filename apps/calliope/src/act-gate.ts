/**
 * The REST door's act-assertion gate: a `wrap` for the adapter (rest.ts).
 *
 * It is the only place the header is read, and the only caller of
 * {@link withActAuthor}. Behaviour:
 *  - no `x-charon-act-assertion` header: the request passes untouched;
 *  - the header present (even empty, even repeated): the request is refused
 *    unless the assertion verifies for THIS request (POST of one
 *    of the six write verbs with no query, digest of the received body), and
 *    then it runs with the human on its async context.
 * Header-name case is the HTTP layer's (RestHeaders is case-insensitive).
 */

import type {
  RestHandler,
  RestRequest,
  RestResponse,
} from "@forge/stellar-core-ts/rest";
import { kairosDoorFetch } from "@forge/stellar-core-ts/pep";
import {
  ACT_ASSERTION_HEADER,
  ActRefusal,
  JwksCache,
  WRITE_VERB_PATHS,
  actConfigFromEnv,
  verifyActAssertion,
  withActAuthor,
} from "./act-assertion.js";
import type { ActConfig, FetchLike, JtiStore } from "./act-assertion.js";
import { argsDigest, DigestError, parseRaw } from "./args-digest.js";
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
 * The fetch the key cache reads Kairos's JWKS with. An https:// keyset is
 * Kairos's mTLS door (`https://kairos:8301/jwks`): its certificate is an SVID
 * with no DNS name, so a plain fetch fails the handshake
 * (ERR_TLS_CERT_ALTNAME_INVALID), the cache holds no key, and every PRESENT
 * assertion is refused 503 act_assertion_unavailable. It is fetched as the
 * SDK's PEP fetches the same URL: with this star's SVID, the peer pinned to
 * star/kairos. `door` is built on first use, so a gate that never sees an
 * assertion never starts the identity source. A caller's own fetch wins.
 */
export function actJwksFetch(
  url: string,
  given: FetchLike | undefined,
  door: () => FetchLike = kairosDoorFetch,
): FetchLike | undefined {
  if (given !== undefined || !/^https:/i.test(url)) return given;
  let f: FetchLike | undefined;
  return (u, init) => (f ??= door())(u, init);
}

/** The wrap: `(next) => handler` for {@link mountRestFace}. */
export function actGate(o: ActGateOptions): (next: RestHandler) => RestHandler {
  const config = o.config ?? actConfigFromEnv();
  const keys =
    config.jwksUrl === ""
      ? undefined
      : new JwksCache(config.jwksUrl, actJwksFetch(config.jwksUrl, o.fetch));
  return (next) => async (req: RestRequest) => {
    const values = req.headers.getAll(ACT_ASSERTION_HEADER);
    if (values.length === 0) return next(req);
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
