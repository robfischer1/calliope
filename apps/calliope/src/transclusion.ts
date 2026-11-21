import {
  type ChaosDial,
  type Tenant,
  TENANTS,
  graphToken,
  scopeHash,
  tenantScope,
} from "./chaos-client.js";
import { TREE_CONTENT, TREE_MEMBER, TREE_REF } from "./tree.js";

/** A transclusion refusal, with its wire code. */
export class PlacementError extends Error {
  constructor(
    message: string,
    readonly code:
      "not_found" | "bad_args" | "has_placements" | "cross_tenant_placement",
  ) {
    super(message);
    this.name = "PlacementError";
  }
}

/** One slot as the primitives read it, before resolution. */
export interface RawSlot {
  slot: string;
  blobId: string | null;
  ref?: string;
}

/**
 * Fill each placement's `blobId` with its origin's blob, as of `asOfTx`
 * (null = HEAD), in ONE quads read for every origin. A container with no
 * placement costs nothing. An origin that holds no blob (removed, or itself
 * a placement) leaves the placement's `blobId` null: dangling.
 */
export async function resolvePlacements<T extends RawSlot>(
  dial: ChaosDial,
  slots: T[],
  asOfTx: number | null,
): Promise<T[]> {
  const origins = [
    ...new Set(slots.flatMap((s) => (s.ref === undefined ? [] : [s.ref]))),
  ];
  if (origins.length === 0) return slots;
  const rows = await dial.quadsFrom(origins, asOfTx, [TREE_CONTENT, TREE_REF]);
  const contentHash = scopeHash(TREE_CONTENT);
  const refHash = scopeHash(TREE_REF);
  const blobOf = new Map<string, string>();
  const chained = new Set<string>();
  for (const r of rows) {
    if (r.p === contentHash && r.o.startsWith("blob:")) {
      blobOf.set(r.s, r.o.slice("blob:".length));
    } else if (r.p === refHash) {
      chained.add(r.s);
    }
  }
  return slots.map((s) => {
    if (s.ref === undefined) return s;
    const blob = chained.has(s.ref) ? undefined : blobOf.get(s.ref);
    return { ...s, blobId: blob ?? null };
  });
}

/** The container holding each slot NOW (`tree_member` inbound). A slot no
 *  container holds is absent from the map. Needs `referrers`. */
export async function containersOf(
  dial: ChaosDial,
  slots: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dial.referrers === undefined) return out;
  for (const slot of new Set(slots)) {
    const holder = (await dial.referrers(slot)).find(
      (e) => e.predicate === TREE_MEMBER,
    );
    if (holder !== undefined) out.set(slot, holder.subject);
  }
  return out;
}

/** One placement of an origin: the placement slot and its container (absent
 *  when no container holds it). */
export interface Placement {
  slot: string;
  container?: string;
}

/**
 * The placements reverse index: every slot whose `tree_ref` names `origin`,
 * with its container. A dial without `referrers` answers none (the fixture
 * and live dials both have it).
 */
export async function placementsOf(
  dial: ChaosDial,
  origin: string,
): Promise<Placement[]> {
  if (dial.referrers === undefined) return [];
  const slots = (await dial.referrers(origin))
    .filter((e) => e.predicate === TREE_REF)
    .map((e) => e.subject);
  const homes = await containersOf(dial, slots);
  return [...new Set(slots)].sort().map((slot) => {
    const container = homes.get(slot);
    return container === undefined ? { slot } : { slot, container };
  });
}

/**
 * The orphan detector: of `origins`, every placement whose origin holds no
 * blob now. Called after a commit that removed origins (the race the
 * pre-commit check cannot close: chaos `expect` sees only a subject's
 * outbound facts, so a placement added between the check and the commit is
 * found here, after the fact). Read-only; a sweep calls it the same way.
 */
export async function orphanedPlacements(
  dial: ChaosDial,
  origins: readonly string[],
): Promise<(Placement & { origin: string })[]> {
  const out: (Placement & { origin: string })[] = [];
  for (const origin of new Set(origins)) {
    const live = (await dial.edges(origin)).some(
      (e) => e.predicate === TREE_CONTENT && e.domain === "blob",
    );
    if (live) continue;
    for (const p of await placementsOf(dial, origin)) {
      out.push({ ...p, origin });
    }
  }
  return out;
}

/** A slot's current tree state: its blob, or its origin. */
export interface SlotState {
  blobId: string | null;
  ref: string | null;
}

export async function slotState(
  dial: ChaosDial,
  slot: string,
): Promise<SlotState> {
  let blobId: string | null = null;
  let ref: string | null = null;
  for (const e of await dial.edges(slot)) {
    if (e.predicate === TREE_CONTENT && e.domain === "blob") blobId ??= e.value;
    if (e.predicate === TREE_REF && e.domain === "node") ref ??= e.value;
  }
  return { blobId, ref };
}

/**
 * The tenant a slot's tree facts live in, read off the scope chaos placed them
 * in (`materialize_edges` full).
 */
export async function tenantOfSlot(
  dial: ChaosDial,
  slot: string,
  fallback: Tenant,
  scope: (t: Tenant) => string = tenantScope,
): Promise<Tenant> {
  if (dial.placedEdges === undefined) return fallback;
  const fact = (await dial.placedEdges(slot)).find(
    (e) =>
      (e.predicate === TREE_CONTENT || e.predicate === TREE_REF) &&
      e.graph !== "",
  );
  if (fact === undefined) return fallback;
  for (const t of TENANTS) {
    const name = scope(t);
    if (fact.graph === scopeHash(name) || fact.graph === graphToken(name)) {
      return t;
    }
  }
  return fallback;
}

/**
 * The containers an edit to `slots` changed besides the one written: each
 * edited slot resolves to its origin (a placement's `ref`, else itself), and
 * every container holding that origin or a placement of it reads the new
 * text. The write path republishes them (consciousness, inline tags) so eros
 * and the tag mirror do not go stale. Post-commit, read-only.
 */
export async function fanOutContainers(
  dial: ChaosDial,
  slots: readonly string[],
  written: string,
): Promise<string[]> {
  const out = new Set<string>();
  for (const slot of new Set(slots)) {
    const state = await slotState(dial, slot);
    const origin = state.ref ?? slot;
    const placements = await placementsOf(dial, origin);
    if (placements.length === 0 && state.ref === null) continue;
    for (const c of (await containersOf(dial, [origin])).values()) out.add(c);
    for (const p of placements) {
      if (p.container !== undefined) out.add(p.container);
    }
  }
  out.delete(written);
  return [...out].sort();
}
