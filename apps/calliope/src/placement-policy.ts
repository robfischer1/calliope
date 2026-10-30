/**
 * THE CROSS-TENANT SEAM (Lamarr37-002, Rob's ruling 5). This is the one place
 * that decides whether a placement may cross tenants. The data model and the
 * write path support a cross-tenant reference fully: `tree_ref` is a node
 * edge, node tokens are global, and an edit through a cross-tenant placement
 * admits at the origin's scope. Only this policy refuses it.
 *
 * The default DENIES a cross-tenant placement. A governance container that
 * places a notes block would let an edit outside governance change law
 * without an inscription (ruling 4). Same-tenant is always allowed.
 *
 * Two actions reach the policy, both from writeContainer before anything is
 * minted:
 * - `place`: an `add {ref}` op creates a placement.
 * - `write_through`: an `update` on a placement rewrites its origin.
 *
 * TO OPEN THE DOORWAY, change the one line in `defaultPlacementPolicy` from
 * `if (req.fromTenant !== req.toTenant) throw ...` to a real permission check
 * (or delete it to allow every crossing). A facet can also carry its own
 * policy (`ContainerFacet.placementPolicy`); the tests stub one that allows.
 */

import type { Tenant } from "./chaos-client.js";
import { PlacementError } from "./transclusion.js";

/** What the policy is asked. */
export interface PlacementRequest {
  action: "place" | "write_through";
  /** The tenant of the container the call writes (the placement's). */
  fromTenant: Tenant;
  /** The tenant the origin slot's facts live in. */
  toTenant: Tenant;
  origin: string;
  /** The placement slot; absent on `place` (it is not minted yet). */
  placement?: string;
  /** The container being written. */
  container: string;
}

/** Throws {@link PlacementError} to refuse; returns to allow. */
export type PlacementPolicy = (req: PlacementRequest) => void;

export const defaultPlacementPolicy: PlacementPolicy = (req) => {
  if (req.fromTenant !== req.toTenant) {
    throw new PlacementError(
      `write_container: ${req.action} from ${req.fromTenant} into a ` +
        `${req.toTenant} origin (${req.origin}) is refused: cross-tenant ` +
        "placements are closed until a permission check exists " +
        "(placement-policy.ts)",
      "cross_tenant_placement",
    );
  }
};

/** A policy that allows every crossing: the tests' stub. */
export const allowAllPlacements: PlacementPolicy = () => undefined;
