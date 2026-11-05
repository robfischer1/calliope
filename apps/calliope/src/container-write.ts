/** //p
 * The container write (spec 041, master-plan F4) — saving a document is one //p
 * transaction: mint the blobs it needs, then write the tree that names //p
 * them, in that order. //p
 * //p
 * Blob-first ordering is the consistency mechanism across the two logical //p
 * databases (no FK, no 2PC — the master plan's constraint): a failure after //p
 * the mint leaves orphan blobs (legal garbage, the F7 census reaps them) //p
 * and NO partial tree. Content-identical ops net out BEFORE the batch — //p
 * a save that nets to nothing opens no transaction at all. //p
 */ //p

import type { GcStore, ProseStore } from "./blob-store.js"; //p
import { //p
  ChaosClientError, //p
  type ChaosDial, //p
  type ChaosExpect, //p
  type ChaosOp, //p
  expectHeldBlob, //p
  type Tenant, //p
  tenantScope, //p
} from "./chaos-client.js"; //p
import { //p
  type SlotFact, //p
  retractContentHashOps, //p
  retractSpanOps, //p
  heldSpanFacts, //p
  slotFactOps, //p
  textHash, //p
  validateSlotFacts, //p
} from "./slot-facts.js"; //p
import type { PlacementPolicy } from "./placement-policy.js"; //p
import { orphanedPlacements, type Placement } from "./transclusion.js"; //p
import { planRouting } from "./transclusion-write.js"; //p
import { //p
  TREE_CONTENT, //p
  TREE_REF, //p
  placementBirthOps, //p
  placementRemoveOps, //p
  repointOps, //p
  repositionOps, //p
  slotBirthOps, //p
  slotRemoveOps, //p
} from "./tree.js"; //p

/** One container-save op — aglaia's tree diff maps onto these directly. */ //p
export type ContainerOp = //p
  | { //p
      op: "add"; //p
      text: string; //p
      position: string; //p
      facts?: SlotFact[]; //p
      ref?: undefined; //p
    } //p
  /** A PLACEMENT: the new slot references `ref` (an existing slot holding //p
   *  content) instead of holding a blob. */ //p
  | { //p
      op: "add"; //p
      ref: string; //p
      position: string; //p
      text?: undefined; //p
      /** Refused at plan time: a placement's facts live on its origin. */ //p
      facts?: SlotFact[]; //p
    } //p
  | { //p
      op: "update"; //p
      slot: string; //p
      oldBlobId: string; //p
      text: string; //p
      facts?: SlotFact[]; //p
    } //p
  | { //p
      op: "reorder"; //p
      slot: string; //p
      oldPosition: string; //p
      position: string; //p
      /** Internal (not on the wire schema): hold the slot's position as //p
       *  read, so a rebalance re-laid from one read conflicts with a //p
       *  concurrent move instead of overwriting it. */ //p
      guard?: true; //p
    } //p
  | { //p
      op: "remove"; //p
      slot: string; //p
      position: string; //p
      /** The blob the slot reads now (a placement: its origin's; "" for a //p
       *  dangling placement). */ //p
      blobId: string; //p
      /** Removing an ORIGIN that still has placements: "orphan" leaves them //p
       *  dangling (their `ref` kept); absent, the save is refused //p
       *  `has_placements`. */ //p
      placements?: "orphan"; //p
    }; //p

/** The write path's backend facet: the prose store + the graph dial. */ //p
export interface ContainerFacet { //p
  blobs: ProseStore; //p
  dial: ChaosDial; //p
  /** Tenant → graph scope (env-aware); defaults to {@link tenantScope}. */ //p
  scope?: (tenant: Tenant) => string; //p
  /** The census's store surface (F7) — present on backends that can reap. */ //p
  gc?: GcStore; //p
  /** The cross-tenant placement policy (placement-policy.ts); absent, the //p
   *  default, which refuses a placement across tenants. */ //p
  placementPolicy?: PlacementPolicy; //p
} //p

/** Per-save outcome. Indexes key into the ORIGINAL ops array. */ //p
export interface ContainerWriteResult { //p
  /** True when every op netted out — nothing was written anywhere. */ //p
  noop: boolean; //p
  /** Indexes of ops that survived netting and rode the batch. */ //p
  applied: number[]; //p
  /** op index → minted slot token (adds only). */ //p
  minted: Record<number, string>; //p
  /** op index → blob id (adds and updates). */ //p
  blobIds: Record<number, string>; //p
  /** The graph transaction the batch landed as — absent on a noop, or //p
   *  when the gate answered none. */ //p
  tx?: number; //p
  /** op index → the origin slot an edit through a placement rewrote. //p
   *  Present only when a save routed one. */ //p
  routed?: Record<number, string>; //p
  /** Placements left dangling by this save: the ones a `placements: //p
   *  "orphan"` remove meant to orphan, plus any placed concurrently (the //p
   *  post-commit detector). Present only when the save removed an origin //p
   *  that had placements. */ //p
  orphaned?: (Placement & { origin: string })[]; //p
} //p

/** //p
 * Execute one save. Phase 1 mints every add/update blob (idempotent — the //p
 * store returns the existing id on a duplicate) and DROPS updates whose //p
 * content is already the slot's content. Phase 2 composes the survivors //p
 * through the F3 builders into ONE admit batch at the tenant's scope. //p
 * A refused batch throws {@link ChaosClientError} carrying the gate's //p
 * violations verbatim; any blobs minted in phase 1 stay behind as orphans. //p
 * //p
 * Every update and remove is a real compare-and-set. `removeEdge` is ensure-absent and //p
 * the cardinality guard only warns, so remove-old + add-new alone, after //p
 * another writer moved the slot, would remove nothing and land a SECOND //p
 * `tree_content`. Each update therefore rides an `expect` that the slot //p
 * holds exactly its `oldBlobId`; a stale base refuses the whole batch as //p
 * `conflict` (code `conflict`, naming the slot), nothing written. //p
 */ //p
export async function writeContainer( //p
  facet: ContainerFacet, //p
  containerToken: string, //p
  ops: ContainerOp[], //p
  tenant: Tenant = "notes", //p
): Promise<ContainerWriteResult> { //p
  // Transclusion first: refuses (nothing minted) or says where each op lands. //p
  const routing = await planRouting(facet, containerToken, ops, tenant); //p
  const scope = (facet.scope ?? tenantScope)(routing.tenant); //p
  const blobIds: Record<number, string> = {}; //p
  const surviving: { //p
    index: number; //p
    op: ContainerOp; //p
    blobId?: string; //p
    /** An update whose text is unchanged but which carries facts: only the //p
     *  facts ride the batch. */ //p
    factsOnly?: boolean; //p
    facts?: SlotFact[]; //p
  }[] = []; //p

  // Phase 0 — validate every op's facts before anything is minted: a //p
  // disallowed predicate or a contentHash mismatch refuses the whole save. //p
  const checked = new Map<number, SlotFact[]>(); //p
  for (const [index, op] of ops.entries()) { //p
    if (op.op === "add" && op.ref !== undefined) continue; //p
    if ((op.op === "add" || op.op === "update") && op.facts !== undefined) { //p
      checked.set(index, validateSlotFacts(op.facts, op.text, op.op)); //p
    } //p
  } //p

  // Phase 1 — blob-first. Every needed blob is durable before any tree //p
  // fact references it; identical content nets out here. //p
  for (const [index, op] of ops.entries()) { //p
    const place = routing.places.get(index); //p
    if (place !== undefined) { //p
      // A placement mints nothing: it reads the origin's blob. //p
      blobIds[index] = place.blobId; //p
      surviving.push({ index, op, blobId: place.blobId }); //p
    } else if (op.op === "add") { //p
      // planRouting placed every ref add, so a text add is all that is left. //p
      const blobId = await facet.blobs.mint(op.text ?? ""); //p
      blobIds[index] = blobId; //p
      surviving.push({ index, op, blobId, facts: checked.get(index) ?? [] }); //p
    } else if (op.op === "update") { //p
      const blobId = await facet.blobs.mint(op.text); //p
      blobIds[index] = blobId; //p
      const facts = checked.get(index) ?? []; //p
      if (blobId === op.oldBlobId) { //p
        // byte-identical — the text nets out; carried facts still land //p
        if (facts.length === 0) continue; //p
        surviving.push({ index, op, blobId, factsOnly: true, facts }); //p
        continue; //p
      } //p
      surviving.push({ index, op, blobId, facts }); //p
    } else { //p
      surviving.push({ index, op }); //p
    } //p
  } //p
  if (surviving.length === 0) { //p
    return { noop: true, applied: [], minted: {}, blobIds }; //p
  } //p

  // Phase 2 — one batch of tree facts, F3 builders only. //p
  const batch: ChaosOp[] = []; //p
  const expects: ChaosExpect[] = []; //p
  const addSlots: { index: number; mintOrdinal: number }[] = []; //p
  let mintOrdinal = 0; //p
  for (const { index, op, blobId, factsOnly, facts } of surviving) { //p
    const place = routing.places.get(index); //p
    if (place !== undefined) { //p
      // The origin must still hold the blob it was read at: it cannot be //p
      // removed (or turned into a placement) between the check and here. //p
      expects.push(expectHeldBlob(place.origin, TREE_CONTENT, place.blobId)); //p
      batch.push( //p
        ...placementBirthOps( //p
          containerToken, //p
          `b:${op.op === "add" ? op.position : String(index)}`, //p
          op.op === "add" ? op.position : "", //p
          place.origin, //p
        ), //p
      ); //p
      addSlots.push({ index, mintOrdinal }); //p
      mintOrdinal += 1; //p
      continue; //p
    } //p
    switch (op.op) { //p
      case "add": { //p
        if (blobId === undefined) throw new Error("add without a blob id"); //p
        batch.push( //p
          ...slotBirthOps( //p
            containerToken, //p
            `b:${op.position}`, //p
            op.position, //p
            blobId, //p
            slotFactOps(`b:${op.position}`, facts ?? []), //p
          ), //p
        ); //p
        addSlots.push({ index, mintOrdinal }); //p
        mintOrdinal += 1; //p
        break; //p
      } //p
      case "update": { //p
        if (blobId === undefined) throw new Error("update without a blob id"); //p
        // An edit through a placement lands on its origin: the CAS is the //p
        // ORIGIN's blob, and the placement must still name that origin. //p
        const origin = routing.routed.get(index); //p
        const target = origin ?? op.slot; //p
        if (origin !== undefined) { //p
          expects.push({ //p
            s: op.slot, //p
            predicate: TREE_REF, //p
            held: [{ node: origin }], //p
          }); //p
        } //p
        if (factsOnly !== true) { //p
          expects.push(expectHeldBlob(target, TREE_CONTENT, op.oldBlobId)); //p
          batch.push(...repointOps(target, op.oldBlobId, blobId)); //p
        } //p
        // A rewrite replaces the slot's contentHash; the repeatable edges //p
        // are added to. A caller that sent no contentHash (Aglaia's client //p
        // sends none) still must not leave the old one standing: a slot that //p
        // carries a hash gets the new text's hash, server-side, same batch. //p
        const sent = (facts ?? []).some((f) => f.predicate === "contentHash"); //p
        let carried: SlotFact[] = facts ?? []; //p
        let heldHash = false; //p
        if (sent || factsOnly !== true) { //p
          const old = retractContentHashOps( //p
            target, //p
            await facet.dial.edges(target), //p
          ); //p
          heldHash = old.length > 0; //p
          if (sent || heldHash) batch.push(...old); //p
        } //p
        if (!sent && heldHash) { //p
          carried = [ //p
            ...carried, //p
            { predicate: "contentHash", literal: textHash(op.text) }, //p
          ]; //p
        } //p
        if ( //p
          carried.some( //p
            (f) => f.predicate === "spanFrom" || f.predicate === "spanTo", //p
          ) //p
        ) { //p
          // A new turn window replaces the held one (glaucus backfill-spans //p
          // rewrites a wrong window; scotty43-003). //p
          const edges = await facet.dial.edges(target); //p
          batch.push(...retractSpanOps(target, edges, carried)); //p
          const same = new Set(heldSpanFacts(edges, carried)); //p
          carried = carried.filter((f) => !same.has(f)); //p
        } //p
        if (carried.length > 0) { //p
          batch.push(...slotFactOps(target, carried)); //p
        } //p
        break; //p
      } //p
      case "reorder": //p
        if (op.guard === true) { //p
          expects.push({ //p
            s: op.slot, //p
            predicate: "tree_position", //p
            held: [{ literal: op.oldPosition }], //p
          }); //p
        } //p
        batch.push(...repositionOps(op.slot, op.oldPosition, op.position)); //p
        break; //p
      case "remove": { //p
        const origin = routing.unplaces.get(index); //p
        if (origin !== undefined) { //p
          // A placement goes alone; its origin is untouched. The CAS holds //p
          // the reference, and (unless dangling) the content it read. //p
          expects.push({ //p
            s: op.slot, //p
            predicate: TREE_REF, //p
            held: [{ node: origin }], //p
          }); //p
          if (op.blobId !== "") { //p
            expects.push(expectHeldBlob(origin, TREE_CONTENT, op.blobId)); //p
          } //p
          batch.push( //p
            ...placementRemoveOps(op.slot, containerToken, op.position, origin), //p
          ); //p
          break; //p
        } //p
        // Same hole as an update: removeEdge is ensure-absent, so a stale //p
        // blobId would remove nothing and report success. //p
        expects.push(expectHeldBlob(op.slot, TREE_CONTENT, op.blobId)); //p
        batch.push( //p
          ...slotRemoveOps(op.slot, containerToken, op.position, op.blobId), //p
        ); //p
        break; //p
      } //p
    } //p
  } //p

  if (batch.length === 0) { //p
    // Every op netted out (a window written again as it stands). //p
    return { noop: true, applied: [], minted: {}, blobIds }; //p
  } //p
  let res; //p
  try { //p
    res = await facet.dial.admit(batch, scope, expects); //p
  } catch (err) { //p
    if (err instanceof ChaosClientError && err.code === "conflict") { //p
      throw conflictError(err, expects); //p
    } //p
    throw err; //p
  } //p
  if (!res.admitted) { //p
    throw new ChaosClientError( //p
      "write_container: the gate refused the batch (minted blobs remain as " + //p
        "orphans for the census; no tree change landed)", //p
      "admit_refused", //p
      res.violations, //p
    ); //p
  } //p
  const minted: Record<number, string> = {}; //p
  for (const { index, mintOrdinal: ord } of addSlots) { //p
    const token = res.minted[ord]; //p
    if (token !== undefined) minted[index] = token; //p
  } //p
  const routed = Object.fromEntries(routing.routed); //p
  // Post-commit: an origin removed with placements leaves them dangling; the //p
  // detector also finds any placed between the plan's read and the commit. //p
  const removedOrigins = ops.flatMap((op, i) => //p
    op.op === "remove" && !routing.unplaces.has(i) ? [op.slot] : [], //p
  ); //p
  const orphaned = //p
    removedOrigins.length > 0 //p
      ? await orphanedPlacements(facet.dial, removedOrigins) //p
      : []; //p
  return { //p
    noop: false, //p
    applied: surviving.map((s) => s.index), //p
    minted, //p
    blobIds, //p
    ...(res.tx !== undefined ? { tx: res.tx } : {}), //p
    ...(routing.routed.size > 0 ? { routed } : {}), //p
    ...(orphaned.length > 0 ? { orphaned } : {}), //p
  }; //p
} //p

/** //p
 * A failed expectation, said in calliope's words and naming the slot. The //p
 * store's detail leads `expect[<i>] s=<slot> ...`; the index (or, failing //p
 * that, the slot token) picks the slot, and an unreadable detail names every //p
 * slot the batch was conditional on rather than none. //p
 */ //p
function conflictError( //p
  err: ChaosClientError, //p
  expects: readonly ChaosExpect[], //p
): ChaosClientError { //p
  const idx = /expect\[(\d+)\]/.exec(err.message)?.[1]; //p
  const named = idx === undefined ? undefined : expects[Number(idx)]; //p
  const slots = //p
    named !== undefined ? [named.s] : [...new Set(expects.map((x) => x.s))]; //p
  return new ChaosClientError( //p
    `write_container: conflict — slot ${slots.join(", ")} no longer holds ` + //p
      "the content the update was based on (another writer changed it " + //p
      "after oldBlobId was read); re-read the container and retry. " + //p
      "Nothing was written (blobs minted for this save remain as orphans " + //p
      `for the census). [${err.message}]`, //p
    "conflict", //p
  ); //p
} //p
