/** //p
 * The blob census (spec 044-blob-gc, master-plan F7) — reap blobs nothing //p
 * points at, surface facts that point at nothing. The graph's census //p
 * protocol with the roles swapped: the blob store asks who still holds a //p
 * reference, the graph answers PER ROSTERED GRAPH, and nothing is reaped //p
 * unless every expected reporter answered. //p
 * //p
 * Write-ordering (F4) deliberately produces orphan blobs on failure; the //p
 * only safe reaper is one that refuses to run on an incomplete census. //p
 * Mark-and-sweep: a COMPLETE census marks the unheld; a LATER complete //p
 * census reaps only ids still unheld AND already marked — the grace //p
 * window that protects blobs minted for a save still in flight. Held is //p
 * the graph's LOG (as-of reads resolve historical blobs forever), so only //p
 * never-referenced orphans ever reap. //p
 */ //p

import type { GcStore } from "./blob-store.js"; //p
import { type ChaosDial, type Tenant, tenantScope } from "./chaos-client.js"; //p

/** The rostered reporters: every tenant graph that may hold blob facts. //p
 *  A roster of one would make the quorum vacuous [MP gap]; the roster is //p
 *  the TENANT SET, each graph answering separately. */ //p
export const CENSUS_ROSTER: Tenant[] = [ //p
  "notes", //p
  "documents", //p
  "comments", //p
  "governance", //p
  "issues", //p
  "threads", //p
]; //p

export interface CensusReporter { //p
  graph: Tenant; //p
  ok: boolean; //p
  /** Held count when ok — 0 is a REPORT (distinct from failure). */ //p
  count: number; //p
  error?: string; //p
} //p

export interface CensusReport { //p
  /** Every rostered reporter answered. Nothing is marked or reaped otherwise. */ //p
  complete: boolean; //p
  reporters: CensusReporter[]; //p
  held: number; //p
  /** Facts naming absent blobs — surfaced, never "fixed". */ //p
  dangling: string[]; //p
  /** Unheld ids ≤ the snapshot, newly marked this round (complete only). */ //p
  marked: string[]; //p
  /** Ids reaped this round (previously marked, still unheld; execute only). */ //p
  reaped: string[]; //p
  /** True when execute was requested and the census was complete. */ //p
  executed: boolean; //p
} //p

export interface CensusDeps { //p
  gc: GcStore; //p
  dial: ChaosDial; //p
} //p

export async function runBlobCensus( //p
  deps: CensusDeps, //p
  opts: { execute?: boolean; roster?: Tenant[] } = {}, //p
): Promise<CensusReport> { //p
  const roster = opts.roster ?? CENSUS_ROSTER; //p
  const report: CensusReport = { //p
    complete: true, //p
    reporters: [], //p
    held: 0, //p
    dangling: [], //p
    marked: [], //p
    reaped: [], //p
    executed: false, //p
  }; //p

  // Snapshot FIRST: ids minted after this instant are out of frame. //p
  const snapshot = await deps.gc.maxId(); //p

  const held = new Set<string>(); //p
  for (const graph of roster) { //p
    try { //p
      const ids = await deps.dial.heldBlobs(tenantScope(graph)); //p
      report.reporters.push({ graph, ok: true, count: ids.length }); //p
      for (const id of ids) held.add(id); //p
    } catch (err) { //p
      report.reporters.push({ //p
        graph, //p
        ok: false, //p
        count: 0, //p
        error: err instanceof Error ? err.message : String(err), //p
      }); //p
      report.complete = false; //p
    } //p
  } //p
  report.held = held.size; //p
  if (!report.complete) return report; // an incomplete census reaps NOTHING //p

  const stored = new Set( //p
    snapshot === null ? [] : await deps.gc.listIdsUpTo(snapshot), //p
  ); //p
  // Dangling: held by the graph, absent from the store. Reported, not fixed. //p
  for (const id of held) { //p
    if (!stored.has(id)) report.dangling.push(id); //p
  } //p
  report.dangling.sort((a, b) => Number(a) - Number(b)); //p

  const unheld = [...stored].filter((id) => !held.has(id)); //p
  const previousMarks = new Set(await deps.gc.readMarks()); //p
  const reapable = unheld.filter((id) => previousMarks.has(id)); //p

  if (opts.execute === true) { //p
    await deps.gc.reap(reapable); //p
    report.reaped = reapable; //p
    report.executed = true; //p
  } //p
  // The new mark set: everything unheld now (minus what was just reaped). //p
  const reapedSet = new Set(report.reaped); //p
  report.marked = unheld.filter((id) => !reapedSet.has(id)); //p
  await deps.gc.writeMarks(report.marked); //p
  return report; //p
} //p
