/**
 * The blob census (spec 044-blob-gc, master-plan F7) — reap blobs nothing
 * points at, surface facts that point at nothing. The graph's census
 * protocol with the roles swapped: the blob store asks who still holds a
 * reference, the graph answers PER ROSTERED GRAPH, and nothing is reaped
 * unless every expected reporter answered.
 *
 * Write-ordering (F4) deliberately produces orphan blobs on failure; the
 * only safe reaper is one that refuses to run on an incomplete census.
 * Mark-and-sweep: a COMPLETE census marks the unheld; a LATER complete
 * census reaps only ids still unheld AND already marked — the grace
 * window that protects blobs minted for a save still in flight. Held is
 * the graph's LOG (as-of reads resolve historical blobs forever), so only
 * never-referenced orphans ever reap.
 */

import type { GcStore } from "./blob-store.js";
import { type ChaosDial, type Tenant, tenantScope } from "./chaos-client.js";

/** The rostered reporters: every tenant graph that may hold blob facts.
 *  A roster of one would make the quorum vacuous [MP gap]; the roster is
 *  the TENANT SET, each graph answering separately. */
export const CENSUS_ROSTER: Tenant[] = [
  "notes",
  "documents",
  "comments",
  "governance",
];

export interface CensusReporter {
  graph: Tenant;
  ok: boolean;
  /** Held count when ok — 0 is a REPORT (distinct from failure). */
  count: number;
  error?: string;
}

export interface CensusReport {
  /** Every rostered reporter answered. Nothing is marked or reaped otherwise. */
  complete: boolean;
  reporters: CensusReporter[];
  held: number;
  /** Facts naming absent blobs — surfaced, never "fixed". */
  dangling: string[];
  /** Unheld ids ≤ the snapshot, newly marked this round (complete only). */
  marked: string[];
  /** Ids reaped this round (previously marked, still unheld; execute only). */
  reaped: string[];
  /** True when execute was requested and the census was complete. */
  executed: boolean;
}

export interface CensusDeps {
  gc: GcStore;
  dial: ChaosDial;
}

export async function runBlobCensus(
  deps: CensusDeps,
  opts: { execute?: boolean; roster?: Tenant[] } = {},
): Promise<CensusReport> {
  const roster = opts.roster ?? CENSUS_ROSTER;
  const report: CensusReport = {
    complete: true,
    reporters: [],
    held: 0,
    dangling: [],
    marked: [],
    reaped: [],
    executed: false,
  };

  // Snapshot FIRST: ids minted after this instant are out of frame.
  const snapshot = await deps.gc.maxId();

  const held = new Set<string>();
  for (const graph of roster) {
    try {
      const ids = await deps.dial.heldBlobs(tenantScope(graph));
      report.reporters.push({ graph, ok: true, count: ids.length });
      for (const id of ids) held.add(id);
    } catch (err) {
      report.reporters.push({
        graph,
        ok: false,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      report.complete = false;
    }
  }
  report.held = held.size;
  if (!report.complete) return report; // an incomplete census reaps NOTHING

  const stored = new Set(
    snapshot === null ? [] : await deps.gc.listIdsUpTo(snapshot),
  );
  // Dangling: held by the graph, absent from the store. Reported, not fixed.
  for (const id of held) {
    if (!stored.has(id)) report.dangling.push(id);
  }
  report.dangling.sort((a, b) => Number(a) - Number(b));

  const unheld = [...stored].filter((id) => !held.has(id));
  const previousMarks = new Set(await deps.gc.readMarks());
  const reapable = unheld.filter((id) => previousMarks.has(id));

  if (opts.execute === true) {
    await deps.gc.reap(reapable);
    report.reaped = reapable;
    report.executed = true;
  }
  // The new mark set: everything unheld now (minus what was just reaped).
  const reapedSet = new Set(report.reaped);
  report.marked = unheld.filter((id) => !reapedSet.has(id));
  await deps.gc.writeMarks(report.marked);
  return report;
}
