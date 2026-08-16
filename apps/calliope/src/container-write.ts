/**
 * The container write (spec 041, master-plan F4) — saving a document is one
 * transaction: mint the blobs it needs, then write the tree that names
 * them, in that order.
 *
 * Blob-first ordering is the consistency mechanism across the two logical
 * databases (no FK, no 2PC — the master plan's constraint): a failure after
 * the mint leaves orphan blobs (legal garbage, the F7 census reaps them)
 * and NO partial tree. Content-identical ops net out BEFORE the batch —
 * a save that nets to nothing opens no transaction at all.
 */

import type { ProseStore } from "./blob-store.js";
import {
  ChaosClientError,
  type ChaosDial,
  type ChaosOp,
  type Tenant,
  tenantScope,
} from "./chaos-client.js";
import {
  repointOps,
  repositionOps,
  slotBirthOps,
  slotRemoveOps,
} from "./tree.js";

/** One container-save op — aglaia's tree diff maps onto these directly. */
export type ContainerOp =
  | { op: "add"; text: string; position: string }
  | { op: "update"; slot: string; oldBlobId: string; text: string }
  | { op: "reorder"; slot: string; oldPosition: string; position: string }
  | { op: "remove"; slot: string; position: string; blobId: string };

/** The write path's backend facet: the prose store + the graph dial. */
export interface ContainerFacet {
  blobs: ProseStore;
  dial: ChaosDial;
  /** Tenant → graph scope (env-aware); defaults to {@link tenantScope}. */
  scope?: (tenant: Tenant) => string;
}

/** Per-save outcome. Indexes key into the ORIGINAL ops array. */
export interface ContainerWriteResult {
  /** True when every op netted out — nothing was written anywhere. */
  noop: boolean;
  /** Indexes of ops that survived netting and rode the batch. */
  applied: number[];
  /** op index → minted slot token (adds only). */
  minted: Record<number, string>;
  /** op index → blob id (adds and updates). */
  blobIds: Record<number, string>;
}

/**
 * Execute one save. Phase 1 mints every add/update blob (idempotent — the
 * store returns the existing id on a duplicate) and DROPS updates whose
 * content is already the slot's content. Phase 2 composes the survivors
 * through the F3 builders into ONE admit batch at the tenant's scope.
 * A refused batch throws {@link ChaosClientError} carrying the gate's
 * violations verbatim; any blobs minted in phase 1 stay behind as orphans.
 */
export async function writeContainer(
  facet: ContainerFacet,
  containerToken: string,
  ops: ContainerOp[],
  tenant: Tenant = "notes",
): Promise<ContainerWriteResult> {
  const scope = (facet.scope ?? tenantScope)(tenant);
  const blobIds: Record<number, string> = {};
  const surviving: { index: number; op: ContainerOp; blobId?: string }[] = [];

  // Phase 1 — blob-first. Every needed blob is durable before any tree
  // fact references it; identical content nets out here.
  for (const [index, op] of ops.entries()) {
    if (op.op === "add") {
      const blobId = await facet.blobs.mint(op.text);
      blobIds[index] = blobId;
      surviving.push({ index, op, blobId });
    } else if (op.op === "update") {
      const blobId = await facet.blobs.mint(op.text);
      blobIds[index] = blobId;
      if (blobId === op.oldBlobId) continue; // byte-identical — nets out
      surviving.push({ index, op, blobId });
    } else {
      surviving.push({ index, op });
    }
  }
  if (surviving.length === 0) {
    return { noop: true, applied: [], minted: {}, blobIds };
  }

  // Phase 2 — one batch of tree facts, F3 builders only.
  const batch: ChaosOp[] = [];
  const addSlots: { index: number; mintOrdinal: number }[] = [];
  let mintOrdinal = 0;
  for (const { index, op, blobId } of surviving) {
    switch (op.op) {
      case "add": {
        if (blobId === undefined) throw new Error("add without a blob id");
        batch.push(
          ...slotBirthOps(
            containerToken,
            `b:${op.position}`,
            op.position,
            blobId,
          ),
        );
        addSlots.push({ index, mintOrdinal });
        mintOrdinal += 1;
        break;
      }
      case "update": {
        if (blobId === undefined) throw new Error("update without a blob id");
        batch.push(...repointOps(op.slot, op.oldBlobId, blobId));
        break;
      }
      case "reorder":
        batch.push(...repositionOps(op.slot, op.oldPosition, op.position));
        break;
      case "remove":
        batch.push(
          ...slotRemoveOps(op.slot, containerToken, op.position, op.blobId),
        );
        break;
    }
  }

  const res = await facet.dial.admit(batch, scope);
  if (!res.admitted) {
    throw new ChaosClientError(
      "write_container: the gate refused the batch (minted blobs remain as " +
        "orphans for the census; no tree change landed)",
      "admit_refused",
      res.violations,
    );
  }
  const minted: Record<number, string> = {};
  for (const { index, mintOrdinal: ord } of addSlots) {
    const token = res.minted[ord];
    if (token !== undefined) minted[index] = token;
  }
  return {
    noop: false,
    applied: surviving.map((s) => s.index),
    minted,
    blobIds,
  };
}
