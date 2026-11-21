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
  "issues",
  "threads",
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
  if (!report.complete) return report;

  const stored = new Set(
    snapshot === null ? [] : await deps.gc.listIdsUpTo(snapshot),
  );
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
  const reapedSet = new Set(report.reaped);
  report.marked = unheld.filter((id) => !reapedSet.has(id));
  await deps.gc.writeMarks(report.marked);
  return report;
}
