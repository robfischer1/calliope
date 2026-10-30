/**
 * The write side of transclusion (Lamarr37-002): before a save mints
 * anything, read each op's slot and decide where it lands.
 *
 * - `add {ref}` places a reference to an existing blob-holding slot. A
 *   missing origin is `not_found`; an origin that is itself a placement is
 *   `bad_args` (chains are refused, so a read is always one hop).
 * - `update` on a placement is ROUTED: it repoints the ORIGIN's blob, so
 *   every placement changes ("all three change", Rob 2026-10-30).
 * - `remove` on a placement retracts only the placement. `remove` on an
 *   origin that still has placements is `has_placements` unless the op says
 *   `placements: "orphan"`.
 * - Every op must land in ONE scope: themis `admit` adds facts in one scope
 *   per batch, so a save whose routed edits reach another tenant's origin
 *   alongside its own edits is refused `bad_args` (split it per tenant)
 *   rather than split into two admits, which would be a race.
 *
 * ATOMICITY: every read here is re-asserted at commit by an `expect` on the
 * batch (origin holds the blob; placement still names the origin), so a
 * concurrent writer turns this save into a `conflict`, never a lost write.
 * The one gap is an origin's INBOUND placements, which `expect` cannot see;
 * the post-commit orphan detector covers it (transclusion.ts).
 */

import type { Tenant } from "./chaos-client.js";
import { isNodeToken } from "./chaos-client.js";
import type { ContainerFacet, ContainerOp } from "./container-write.js";
import type { SlotFact } from "./slot-facts.js";
import {
  type PlacementPolicy,
  defaultPlacementPolicy,
} from "./placement-policy.js";
import {
  PlacementError,
  placementsOf,
  slotState,
  tenantOfSlot,
} from "./transclusion.js";

/** Where each op lands, keyed by its index in the save's op array. */
export interface Routing {
  /** update on a placement → the origin it rewrites. */
  routed: Map<number, string>;
  /** add {ref} → the origin and the blob it holds now (the expect). */
  places: Map<number, { origin: string; blobId: string }>;
  /** remove on a placement → its origin. */
  unplaces: Map<number, string>;
  /** remove on an origin with placements, orphan requested. */
  orphaning: Set<number>;
  /** The one tenant the whole batch admits in. */
  tenant: Tenant;
}

/** Plan a save's transclusion. Throws {@link PlacementError} to refuse;
 *  nothing has been minted or written when it does. */
export async function planRouting(
  facet: ContainerFacet,
  container: string,
  ops: readonly ContainerOp[],
  tenant: Tenant,
): Promise<Routing> {
  const { dial } = facet;
  const policy: PlacementPolicy =
    facet.placementPolicy ?? defaultPlacementPolicy;
  const r: Routing = {
    routed: new Map(),
    places: new Map(),
    unplaces: new Map(),
    orphaning: new Set(),
    tenant,
  };
  const tenants = new Set<Tenant>();
  const originTenant = (slot: string): Promise<Tenant> =>
    tenantOfSlot(dial, slot, tenant, facet.scope);
  const edited = new Map<string, number>();
  const removing = new Set<string>();
  const originRemoves: { index: number; slot: string; orphan: boolean }[] = [];

  for (const [index, op] of ops.entries()) {
    if (op.op === "add" && op.ref !== undefined) {
      if (!isNodeToken(op.ref)) {
        throw new PlacementError(
          `write_container: ref ${op.ref} is not a 64-hex slot token`,
          "bad_args",
        );
      }
      if (op.facts !== undefined) {
        throw new PlacementError(
          "write_container: an add with ref carries no facts (the content's " +
            "facts live on the origin)",
          "bad_args",
        );
      }
      const origin = await slotState(dial, op.ref);
      if (origin.ref !== null) {
        throw new PlacementError(
          `write_container: ${op.ref} is itself a placement of ` +
            `${origin.ref}; place the origin instead (chains are refused)`,
          "bad_args",
        );
      }
      if (origin.blobId === null) {
        throw new PlacementError(
          `write_container: ref ${op.ref} names no slot holding content`,
          "not_found",
        );
      }
      policy({
        action: "place",
        fromTenant: tenant,
        toTenant: await originTenant(op.ref),
        origin: op.ref,
        container,
      });
      r.places.set(index, { origin: op.ref, blobId: origin.blobId });
      tenants.add(tenant);
    } else if (op.op === "update") {
      const state = await slotState(dial, op.slot);
      let target = op.slot;
      if (state.ref !== null) {
        target = state.ref;
        const extra = (op.facts ?? []).filter(
          (f) => f.predicate !== "contentHash",
        );
        if (extra.length > 0) {
          throw new PlacementError(
            `write_container: ${op.slot} is a placement; an edit through it ` +
              "may carry only contentHash (the origin's), not " +
              extra.map((f) => f.predicate).join(", "),
            "bad_args",
          );
        }
        const to = await originTenant(target);
        policy({
          action: "write_through",
          fromTenant: tenant,
          toTenant: to,
          origin: target,
          placement: op.slot,
          container,
        });
        r.routed.set(index, target);
        tenants.add(to);
      } else {
        tenants.add(tenant);
      }
      const prior = edited.get(target);
      if (prior !== undefined) {
        throw new PlacementError(
          `write_container: ops ${String(prior)} and ${String(index)} both ` +
            `rewrite slot ${target} (a placement edits its origin); send one`,
          "bad_args",
        );
      }
      edited.set(target, index);
    } else if (op.op === "remove") {
      tenants.add(tenant);
      removing.add(op.slot);
      const state = await slotState(dial, op.slot);
      if (state.ref !== null) {
        r.unplaces.set(index, state.ref);
      } else {
        originRemoves.push({
          index,
          slot: op.slot,
          orphan: op.placements === "orphan",
        });
      }
    } else {
      tenants.add(tenant);
    }
  }

  // An origin's placements: the ones this same save removes do not count.
  for (const { index, slot, orphan } of originRemoves) {
    const live = (await placementsOf(dial, slot)).filter(
      (p) => !removing.has(p.slot),
    );
    if (live.length === 0) continue;
    if (!orphan) {
      throw new PlacementError(
        `write_container: slot ${slot} is placed by ` +
          `${live.map((p) => p.slot).join(", ")}; remove those first, or ` +
          'send placements: "orphan" to leave them dangling',
        "has_placements",
      );
    }
    r.orphaning.add(index);
  }

  if (tenants.size > 1) {
    throw new PlacementError(
      `write_container: this save spans tenants ${[...tenants].join(", ")} ` +
        "(an edit through a placement lands in its origin's tenant); one " +
        "save admits in one tenant, so split it",
      "bad_args",
    );
  }
  const [only] = tenants;
  if (only !== undefined) r.tenant = only;
  return r;
}

/** An op as the wire sends it: `add` may carry text or ref. */
export type WireOp =
  | {
      op: "add";
      text?: string | undefined;
      ref?: string | undefined;
      position: string;
      facts?: SlotFact[] | undefined;
    }
  | Exclude<ContainerOp, { op: "add" }>;

/** Narrow wire ops to {@link ContainerOp}: an add sends exactly one of text
 *  or ref. Answers the bad_args detail instead when one does not. */
export function containerOps(ops: readonly WireOp[]): ContainerOp[] | string {
  const out: ContainerOp[] = [];
  for (const [i, op] of ops.entries()) {
    if (op.op !== "add") {
      out.push(op);
      continue;
    }
    const facts = op.facts !== undefined ? { facts: op.facts } : {};
    if (op.ref !== undefined && op.text === undefined) {
      out.push({ op: "add", ref: op.ref, position: op.position, ...facts });
    } else if (op.text !== undefined && op.ref === undefined) {
      out.push({ op: "add", text: op.text, position: op.position, ...facts });
    } else {
      return `ops[${String(i)}]: an add sends exactly one of text or ref`;
    }
  }
  return out;
}
