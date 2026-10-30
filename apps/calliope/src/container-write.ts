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
  placementBirthOps,
  placementRemoveOps,
  repointOps,
  repositionOps,
  slotBirthOps,
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
  /** A PLACEMENT: the new slot references `ref` (an existing slot holding
   *  content) instead of holding a blob. */
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
 *
 * Every update and remove is a real compare-and-set. `removeEdge` is ensure-absent and
 * the cardinality guard only warns, so remove-old + add-new alone, after
 * another writer moved the slot, would remove nothing and land a SECOND
 * `tree_content`. Each update therefore rides an `expect` that the slot
 * holds exactly its `oldBlobId`; a stale base refuses the whole batch as
 * `conflict` (code `conflict`, naming the slot), nothing written.
 */
export async function writeContainer(
  facet: ContainerFacet,
  containerToken: string,
  ops: ContainerOp[],
  tenant: Tenant = "notes",
): Promise<ContainerWriteResult> {
  // Transclusion first: refuses (nothing minted) or says where each op lands.
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

  // Phase 0 — validate every op's facts before anything is minted: a
  // disallowed predicate or a contentHash mismatch refuses the whole save.
  const checked = new Map<number, SlotFact[]>();
  for (const [index, op] of ops.entries()) {
    if (op.op === "add" && op.ref !== undefined) continue;
    if ((op.op === "add" || op.op === "update") && op.facts !== undefined) {
      checked.set(index, validateSlotFacts(op.facts, op.text, op.op));
    }
  }

  // Phase 1 — blob-first. Every needed blob is durable before any tree
  // fact references it; identical content nets out here.
  for (const [index, op] of ops.entries()) {
    const place = routing.places.get(index);
    if (place !== undefined) {
      // A placement mints nothing: it reads the origin's blob.
      blobIds[index] = place.blobId;
      surviving.push({ index, op, blobId: place.blobId });
    } else if (op.op === "add") {
      // planRouting placed every ref add, so a text add is all that is left.
      const blobId = await facet.blobs.mint(op.text ?? "");
      blobIds[index] = blobId;
      surviving.push({ index, op, blobId, facts: checked.get(index) ?? [] });
    } else if (op.op === "update") {
      const blobId = await facet.blobs.mint(op.text);
      blobIds[index] = blobId;
      const facts = checked.get(index) ?? [];
      if (blobId === op.oldBlobId) {
        // byte-identical — the text nets out; carried facts still land
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

  // Phase 2 — one batch of tree facts, F3 builders only.
  const batch: ChaosOp[] = [];
  const expects: ChaosExpect[] = [];
  const addSlots: { index: number; mintOrdinal: number }[] = [];
  let mintOrdinal = 0;
  for (const { index, op, blobId, factsOnly, facts } of surviving) {
    const place = routing.places.get(index);
    if (place !== undefined) {
      // The origin must still hold the blob it was read at: it cannot be
      // removed (or turned into a placement) between the check and here.
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
        // An edit through a placement lands on its origin: the CAS is the
        // ORIGIN's blob, and the placement must still name that origin.
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
          batch.push(...repointOps(target, op.oldBlobId, blobId));
        }
        // A rewrite replaces the slot's contentHash; the repeatable edges
        // are added to. A caller that sent no contentHash (Aglaia's client
        // sends none) still must not leave the old one standing: a slot that
        // carries a hash gets the new text's hash, server-side, same batch.
        const sent = (facts ?? []).some((f) => f.predicate === "contentHash");
        let carried: SlotFact[] = facts ?? [];
        let heldHash = false;
        if (sent || factsOnly !== true) {
          const old = retractContentHashOps(
            target,
            await facet.dial.edges(target),
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
          // A new turn window replaces the held one (glaucus backfill-spans
          // rewrites a wrong window; scotty43-003).
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
          // A placement goes alone; its origin is untouched. The CAS holds
          // the reference, and (unless dangling) the content it read.
          expects.push({
            s: op.slot,
            predicate: TREE_REF,
            held: [{ node: origin }],
          });
          if (op.blobId !== "") {
            expects.push(expectHeldBlob(origin, TREE_CONTENT, op.blobId));
          }
          batch.push(
            ...placementRemoveOps(op.slot, containerToken, op.position, origin),
          );
          break;
        }
        // Same hole as an update: removeEdge is ensure-absent, so a stale
        // blobId would remove nothing and report success.
        expects.push(expectHeldBlob(op.slot, TREE_CONTENT, op.blobId));
        batch.push(
          ...slotRemoveOps(op.slot, containerToken, op.position, op.blobId),
        );
        break;
      }
    }
  }

  if (batch.length === 0) {
    // Every op netted out (a window written again as it stands).
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
  // Post-commit: an origin removed with placements leaves them dangling; the
  // detector also finds any placed between the plan's read and the commit.
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
