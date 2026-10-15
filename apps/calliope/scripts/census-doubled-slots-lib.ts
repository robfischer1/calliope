// Read-only census of DOUBLED slots: a slot node holding more than one
// `tree_content` fact. Before writeContainer carried a compare-and-set, a
// stale update removed nothing (removeEdge is ensure-absent) and still
// added, leaving two contents on the slot. Run this over the containers
// you care about BEFORE landing the CAS; every reported slot is one the
// old path corrupted. Nothing here writes: it reads edges and reports.
import type { ChaosDial } from "../src/chaos-client.js";
import { TREE_CONTENT, TREE_MEMBER } from "../src/tree.js";

/** One slot that holds more than one content blob. */
export interface DoubledSlot {
  container: string;
  slot: string;
  /** Every blob id the slot holds, ascending (decimal, numeric order). */
  blobIds: string[];
}

/** The doubled slots of `containers`, in container then slot order. */
export async function censusDoubledSlots(
  dial: ChaosDial,
  containers: readonly string[],
): Promise<DoubledSlot[]> {
  const out: DoubledSlot[] = [];
  for (const container of containers) {
    const members = (await dial.edges(container))
      .filter((e) => e.predicate === TREE_MEMBER && e.domain === "node")
      .map((e) => e.value)
      .sort();
    for (const slot of members) {
      const blobIds = [
        ...new Set(
          (await dial.edges(slot))
            .filter((e) => e.predicate === TREE_CONTENT && e.domain === "blob")
            .map((e) => e.value),
        ),
      ].sort((a, b) => Number(BigInt(a) - BigInt(b)));
      if (blobIds.length > 1) out.push({ container, slot, blobIds });
    }
  }
  return out;
}

export const CENSUS_USAGE = `usage: bun apps/calliope/scripts/census-doubled-slots.ts <container-token>...

Read-only. For each container (64-hex node token) lists the slots that hold
more than one tree_content fact, one per line:

  <container> <slot> <blobId>,<blobId>,...

Exit 0 when none are doubled, 1 when any are, 2 on bad arguments.
Chaos is reached via CALLIOPE_CHAOS_URL / CHAOS_URL, as the service does.
`;

const TOKEN = /^[0-9a-f]{64}$/;

/** Run the census. Answers the process exit code. */
export async function runCensus(
  argv: readonly string[],
  dial: ChaosDial,
  out: { write(chunk: string): unknown },
  err: { write(chunk: string): unknown },
): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    out.write(CENSUS_USAGE);
    return 0;
  }
  const bad = args.find((a) => !TOKEN.test(a));
  if (args.length === 0 || bad !== undefined) {
    err.write(
      bad === undefined
        ? CENSUS_USAGE
        : `not a 64-hex container token: ${bad}\n${CENSUS_USAGE}`,
    );
    return 2;
  }
  const doubled = await censusDoubledSlots(dial, args);
  for (const d of doubled) {
    out.write(`${d.container} ${d.slot} ${d.blobIds.join(",")}\n`);
  }
  return doubled.length === 0 ? 0 : 1;
}
