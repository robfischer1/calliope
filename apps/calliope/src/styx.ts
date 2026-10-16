/**
 * Styx addresses on the read verbs (`read_container`, `read_containers`).
 *
 * Chaos answers in addresses — three words (`able-frost-casual`) with a label
 * and kind, never a token. A caller that holds only an address reads a
 * container by it. Calliope is an internal star and MAY hold the node token
 * while it reads the tree; it must never hand one back that the caller did not
 * send. So the address is resolved here, the token is used for the read, and
 * the answer echoes the address as sent.
 *
 * HOW A REF BECOMES A TOKEN. `resolve_node_refs` answers in two shapes:
 *   - `missing_ok:true` — `{refs, missing}` in input order, each ref echoed as
 *     sent, no token (names the misses without refusing);
 *   - the legacy default — keyed by token, each row echoing the ref as sent,
 *     but it refuses the whole call on an unknown address.
 * So: the echo names the misses, the legacy map (asked only of the found
 * refs, so it cannot refuse) names each found ref's token, and the two join
 * on `ref` — two calls whatever the batch size. A found ref with no row
 * echoing it (two refs naming one node share the row, which echoes the first
 * sent; or a chaos that predates the echo) is asked singly — the legacy map
 * of a single ref has one key.
 */
import type { ChaosDial } from "./chaos-client.js";
import { NODE_TOKEN_RE } from "./types.js";

/** The styx grammar chaos pins on the wire (stellar-core kafkatopics
 *  `source_ref`): three lowercase 3-6 letter words, bare or `styx://`. */
const STYX_WORDS = "[a-z]{3,6}-[a-z]{3,6}-[a-z]{3,6}";
export const STYX_RE = new RegExp(`^(?:styx://)?${STYX_WORDS}$`);

/** A container ref: a 64-hex token OR a styx address — as a JSON-schema
 *  pattern (the shape the advertised input schema carries). */
export const NODE_REF_RE = new RegExp(
  `^(?:${NODE_TOKEN_RE.source.slice(1, -1)}|(?:styx://)?${STYX_WORDS})$`,
);

/** Does this ref need resolving (is it a styx address, not a token)? */
export function isStyx(ref: string): boolean {
  return STYX_RE.test(ref);
}

/** What {@link resolveStyx} found: ref (as sent) -> token, and the refs that
 *  name no live node. */
export interface Resolved {
  tokens: Map<string, string>;
  missing: Set<string>;
}

/**
 * Resolve styx addresses (as sent) to tokens. Two chaos calls for any number
 * of refs; none for an empty list. See the module header.
 */
export async function resolveStyx(
  dial: ChaosDial,
  refs: readonly string[],
): Promise<Resolved> {
  const out: Resolved = { tokens: new Map(), missing: new Set() };
  const asked = [...new Set(refs)];
  if (asked.length === 0) return out;

  const echo = await dial.resolveRefsEcho(asked);
  for (const m of echo.missing) out.missing.add(m);
  const found = echo.refs.filter((r) => !out.missing.has(r.ref));
  if (found.length === 0) return out;

  const byToken = await dial.resolveNodeRefs(found.map((r) => r.ref));
  const tokenOf = new Map<string, string>();
  for (const [token, row] of Object.entries(byToken)) {
    if (row.ref !== undefined) tokenOf.set(row.ref, token);
  }
  for (const r of found) {
    const token =
      tokenOf.get(r.ref) ?? Object.keys(await dial.resolveNodeRefs([r.ref]))[0];
    if (token === undefined) out.missing.add(r.ref);
    else out.tokens.set(r.ref, token);
  }
  return out;
}
