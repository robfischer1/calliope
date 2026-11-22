import type { GcStore, ProseStore } from "./blob-store.js";
import {
  ChaosClientError,
  type ChaosDial,
  type ChaosExpect,
  type ChaosOp,
  expectHeldBlob,
  type Tenant,
  tenantScope,
} from "./chaos-client.js";
import {
  type SlotFact,
  retractContentHashOps,
  retractSpanOps,
  heldSpanFacts,
  slotFactOps,
  textHash,
  validateSlotFacts,
} from "./slot-facts.js";
import type { PlacementPolicy } from "./placement-policy.js";
import { orphanedPlacements, type Placement } from "./transclusion.js";
import { planRouting } from "./transclusion-write.js";
import {
  TREE_CONTENT,
  TREE_REF,
  heldGraphs,
  placementBirthOps,
  placementHeldGraphs,
  placementRemoveOps,
  repointOps,
  repositionOps,
  slotBirthOps,
  slotHeldGraphs,
  slotRemoveOps,
} from "./tree.js";

/** One container-save op — aglaia's tree diff maps onto these directly. */
export type ContainerOp =
  | {
      op: "add";
      text: string;
      position: string;
      facts?: SlotFact[];
      ref?: undefined;
    }
  | {
      op: "add";
      ref: string;
      position: string;
      text?: undefined;
      /** Refused at plan time: a placement's facts live on its origin. */
      facts?: SlotFact[];
    }
  | {
      op: "update";
      slot: string;
      oldBlobId: string;
      text: string;
      facts?: SlotFact[];
    }
  | {
      op: "reorder";
      slot: string;
      oldPosition: string;
      position: string;
      /** Internal (not on the wire schema): hold the slot's position as
       *  read, so a rebalance re-laid from one read conflicts with a
       *  concurrent move instead of overwriting it. */
      guard?: true;
    }
  | {
      op: "remove";
      slot: string;
      position: string;
      /** The blob the slot reads now (a placement: its origin's; "" for a
       *  dangling placement). */
      blobId: string;
      /** Removing an ORIGIN that still has placements: "orphan" leaves them
       *  dangling (their `ref` kept); absent, the save is refused
       *  `has_placements`. */
      placements?: "orphan";
    };

/** The write path's backend facet: the prose store + the graph dial. */
export interface ContainerFacet {
  blobs: ProseStore;
  dial: ChaosDial;
  /** Tenant → graph scope (env-aware); defaults to {@link tenantScope}. */
  scope?: (tenant: Tenant) => string;
  /** The census's store surface (F7) — present on backends that can reap. */
  gc?: GcStore;
  /** The cross-tenant placement policy (placement-policy.ts); absent, the
   *  default, which refuses a placement across tenants. */
  placementPolicy?: PlacementPolicy;
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
  /** The graph transaction the batch landed as — absent on a noop, or
   *  when the gate answered none. */
  tx?: number;
  /** op index → the origin slot an edit through a placement rewrote.
   *  Present only when a save routed one. */
  routed?: Record<number, string>;
  /** Placements left dangling by this save: the ones a `placements:
   *  "orphan"` remove meant to orphan, plus any placed concurrently (the
   *  post-commit detector). Present only when the save removed an origin
   *  that had placements. */
  orphaned?: (Placement & { origin: string })[];
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
  const routing = await planRouting(facet, containerToken, ops, tenant);
  const scope = (facet.scope ?? tenantScope)(routing.tenant);
  const blobIds: Record<number, string> = {};
  const surviving: {
    index: number;
    op: ContainerOp;
    blobId?: string;
    /** An update whose text is unchanged but which carries facts: only the
     *  facts ride the batch. */
    factsOnly?: boolean;
    facts?: SlotFact[];
  }[] = [];

  const checked = new Map<number, SlotFact[]>();
  for (const [index, op] of ops.entries()) {
    if (op.op === "add" && op.ref !== undefined) continue;
    if ((op.op === "add" || op.op === "update") && op.facts !== undefined) {
      checked.set(index, validateSlotFacts(op.facts, op.text, op.op));
    }
  }

  for (const [index, op] of ops.entries()) {
    const place = routing.places.get(index);
    if (place !== undefined) {
      blobIds[index] = place.blobId;
      surviving.push({ index, op, blobId: place.blobId });
    } else if (op.op === "add") {
      const blobId = await facet.blobs.mint(op.text ?? "");
      blobIds[index] = blobId;
      surviving.push({ index, op, blobId, facts: checked.get(index) ?? [] });
    } else if (op.op === "update") {
      const blobId = await facet.blobs.mint(op.text);
      blobIds[index] = blobId;
      const facts = checked.get(index) ?? [];
      if (blobId === op.oldBlobId) {
        if (facts.length === 0) continue;
        surviving.push({ index, op, blobId, factsOnly: true, facts });
        continue;
      }
      surviving.push({ index, op, blobId, facts });
    } else {
      surviving.push({ index, op });
    }
  }
  if (surviving.length === 0) {
    return { noop: true, applied: [], minted: {}, blobIds };
  }

  const batch: ChaosOp[] = [];
  const expects: ChaosExpect[] = [];
  const addSlots: { index: number; mintOrdinal: number }[] = [];
  let mintOrdinal = 0;
  for (const { index, op, blobId, factsOnly, facts } of surviving) {
    const place = routing.places.get(index);
    if (place !== undefined) {
      expects.push(expectHeldBlob(place.origin, TREE_CONTENT, place.blobId));
      batch.push(
        ...placementBirthOps(
          containerToken,
          `b:${op.op === "add" ? op.position : String(index)}`,
          op.op === "add" ? op.position : "",
          place.origin,
        ),
      );
      addSlots.push({ index, mintOrdinal });
      mintOrdinal += 1;
      continue;
    }
    switch (op.op) {
      case "add": {
        if (blobId === undefined) throw new Error("add without a blob id");
        batch.push(
          ...slotBirthOps(
            containerToken,
            `b:${op.position}`,
            op.position,
            blobId,
            slotFactOps(`b:${op.position}`, facts ?? []),
          ),
        );
        addSlots.push({ index, mintOrdinal });
        mintOrdinal += 1;
        break;
      }
      case "update": {
        if (blobId === undefined) throw new Error("update without a blob id");
        const origin = routing.routed.get(index);
        const target = origin ?? op.slot;
        if (origin !== undefined) {
          expects.push({
            s: op.slot,
            predicate: TREE_REF,
            held: [{ node: origin }],
          });
        }
        if (factsOnly !== true) {
          expects.push(expectHeldBlob(target, TREE_CONTENT, op.oldBlobId));
          batch.push(
            ...repointOps(
              target,
              op.oldBlobId,
              blobId,
              await heldGraphs(facet.dial, target, op.oldBlobId),
            ),
          );
        }
        const sent = (facts ?? []).some((f) => f.predicate === "contentHash");
        let carried: SlotFact[] = facts ?? [];
        let heldHash = false;
        if (sent || factsOnly !== true) {
          const old = retractContentHashOps(
            target,
            facet.dial.placedEdges !== undefined
              ? await facet.dial.placedEdges(target)
              : await facet.dial.edges(target),
          );
          heldHash = old.length > 0;
          if (sent || heldHash) batch.push(...old);
        }
        if (!sent && heldHash) {
          carried = [
            ...carried,
            { predicate: "contentHash", literal: textHash(op.text) },
          ];
        }
        if (
          carried.some(
            (f) => f.predicate === "spanFrom" || f.predicate === "spanTo",
          )
        ) {
          const edges = await facet.dial.edges(target);
          batch.push(...retractSpanOps(target, edges, carried));
          const same = new Set(heldSpanFacts(edges, carried));
          carried = carried.filter((f) => !same.has(f));
        }
        if (carried.length > 0) {
          batch.push(...slotFactOps(target, carried));
        }
        break;
      }
      case "reorder":
        if (op.guard === true) {
          expects.push({
            s: op.slot,
            predicate: "tree_position",
            held: [{ literal: op.oldPosition }],
          });
        }
        batch.push(...repositionOps(op.slot, op.oldPosition, op.position));
        break;
      case "remove": {
        const origin = routing.unplaces.get(index);
        if (origin !== undefined) {
          expects.push({
            s: op.slot,
            predicate: TREE_REF,
            held: [{ node: origin }],
          });
          if (op.blobId !== "") {
            expects.push(expectHeldBlob(origin, TREE_CONTENT, op.blobId));
          }
          batch.push(
            ...placementRemoveOps(
              op.slot,
              containerToken,
              op.position,
              origin,
              await placementHeldGraphs(
                facet.dial,
                op.slot,
                containerToken,
                op.position,
                origin,
              ),
            ),
          );
          break;
        }
        expects.push(expectHeldBlob(op.slot, TREE_CONTENT, op.blobId));
        batch.push(
          ...slotRemoveOps(
            op.slot,
            containerToken,
            op.position,
            op.blobId,
            await slotHeldGraphs(
              facet.dial,
              op.slot,
              containerToken,
              op.position,
              op.blobId,
            ),
          ),
        );
        break;
      }
    }
  }

  if (batch.length === 0) {
    return { noop: true, applied: [], minted: {}, blobIds };
  }
  let res;
  try {
    res = await facet.dial.admit(batch, scope, expects);
  } catch (err) {
    if (err instanceof ChaosClientError && err.code === "conflict") {
      throw conflictError(err, expects);
    }
    throw err;
  }
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
  const routed = Object.fromEntries(routing.routed);
  const removedOrigins = ops.flatMap((op, i) =>
    op.op === "remove" && !routing.unplaces.has(i) ? [op.slot] : [],
  );
  const orphaned =
    removedOrigins.length > 0
      ? await orphanedPlacements(facet.dial, removedOrigins)
      : [];
  return {
    noop: false,
    applied: surviving.map((s) => s.index),
    minted,
    blobIds,
    ...(res.tx !== undefined ? { tx: res.tx } : {}),
    ...(routing.routed.size > 0 ? { routed } : {}),
    ...(orphaned.length > 0 ? { orphaned } : {}),
  };
}

/**
 * A failed expectation, said in calliope's words and naming the slot. The
 * store's detail leads `expect[<i>] s=<slot> ...`; the index (or, failing
 * that, the slot token) picks the slot, and an unreadable detail names every
 * slot the batch was conditional on rather than none.
 */
function conflictError(
  err: ChaosClientError,
  expects: readonly ChaosExpect[],
): ChaosClientError {
  const idx = /expect\[(\d+)\]/.exec(err.message)?.[1];
  const named = idx === undefined ? undefined : expects[Number(idx)];
  const slots =
    named !== undefined ? [named.s] : [...new Set(expects.map((x) => x.s))];
  return new ChaosClientError(
    `write_container: conflict — slot ${slots.join(", ")} no longer holds ` +
      "the content the update was based on (another writer changed it " +
      "after oldBlobId was read); re-read the container and retry. " +
      "Nothing was written (blobs minted for this save remain as orphans " +
      `for the census). [${err.message}]`,
    "conflict",
  );
}
