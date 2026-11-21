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
