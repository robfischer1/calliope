/**
 * The container patch — literal find/replace inside a container's blocks,
 * applied server-side as ONE save.
 *
 * Every master-plan on the notes graph is a single block of 13–156 KB, and
 * `write_container`'s update op carries the block's whole new text. A
 * one-line edit therefore shipped the entire plan through Hades. This verb
 * ships only the edits: the server reads the tree, applies the
 * replacements, and lands the changed blocks through {@link writeContainer}
 * — blob-first, one admit batch, the same tree facts a save writes.
 *
 * The batch is all-or-nothing on its counts. Each replacement names how many
 * times its `find` must occur (summed over the targeted blocks, in the text
 * as the earlier replacements left it); one miss refuses the whole batch
 * before anything is minted or admitted. Matching is literal — no regex,
 * no case folding — and counts non-overlapping occurrences left to right,
 * the same occurrences the replacement rewrites.
 */

import type { Tenant } from "./chaos-client.js";
import { readContainer } from "./container-read.js";
import type { ContainerBlock } from "./container-read.js";
import type { ContainerFacet, ContainerOp } from "./container-write.js";
import { writeContainer } from "./container-write.js";

/** One literal replacement. */
export interface Replacement {
  find: string;
  replace: string;
  /** Occurrences of `find` the batch requires, summed over the targets. */
  expected_count: number;
}

export interface PatchInput {
  container: string;
  /** One slot's 64-hex token; absent = every block of the container. */
  slot?: string | undefined;
  replacements: Replacement[];
}

/** Per-replacement outcome, aligned to the input array. */
export interface PatchCount {
  expected: number;
  found: number;
}

export interface PatchResult {
  container: string;
  /** True when the replacements left every block byte-identical. */
  noop: boolean;
  /** The graph transaction the save landed as (absent on a noop). */
  tx?: number;
  counts: PatchCount[];
  /** Slots whose text changed, in position order. */
  slots_changed: string[];
}

export interface PatchError {
  error:
    | "empty_container"
    | "bad_slot"
    | "dangling_slot"
    | "empty_find"
    | "count_mismatch";
  detail: string;
  /** Present on count_mismatch: every replacement's tally. */
  counts?: PatchCount[];
}

export function isPatchError(v: PatchResult | PatchError): v is PatchError {
  return "error" in v;
}

/** Non-overlapping literal occurrences of `find` in `text`. */
export function countLiteral(text: string, find: string): number {
  return text.split(find).length - 1;
}

/** The planned texts: slot → new text for each block the batch changed. */
export interface PatchPlan {
  counts: PatchCount[];
  changed: { block: ContainerBlock; text: string }[];
}

/**
 * Apply the replacements to the targeted blocks in memory. Pure: no reads,
 * no writes. Every replacement runs (so a refusal reports the full tally),
 * and the plan is refused when ANY tally misses its expected count.
 */
export function planPatch(
  blocks: readonly ContainerBlock[],
  slot: string | undefined,
  replacements: readonly Replacement[],
): PatchPlan | PatchError {
  for (const [i, r] of replacements.entries()) {
    if (r.find === "") {
      return {
        error: "empty_find",
        detail: `replacement ${String(i)} has an empty find`,
      };
    }
  }
  if (blocks.length === 0) {
    return { error: "empty_container", detail: "the container has no blocks" };
  }
  let targets: ContainerBlock[];
  if (slot === undefined) {
    // Every block that has prose. A dangling block has no text to match;
    // the census reports it, the patch steps around it.
    targets = blocks.filter((b) => b.text !== null);
  } else {
    const hit = blocks.find((b) => b.slot === slot);
    if (hit === undefined) {
      return { error: "bad_slot", detail: `${slot} is not in the container` };
    }
    if (hit.text === null) {
      return {
        error: "dangling_slot",
        detail: `${slot} names an absent blob; there is no text to patch`,
      };
    }
    targets = [hit];
  }

  const texts = targets.map((b) => b.text ?? "");
  const counts: PatchCount[] = [];
  for (const r of replacements) {
    let found = 0;
    for (const [k, text] of texts.entries()) {
      found += countLiteral(text, r.find);
      texts[k] = text.split(r.find).join(r.replace);
    }
    counts.push({ expected: r.expected_count, found });
  }
  const misses = counts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.found !== c.expected);
  if (misses.length > 0) {
    return {
      error: "count_mismatch",
      detail: misses
        .map(
          ({ c, i }) =>
            `replacement ${String(i)}: expected ${String(c.expected)}, found ${String(c.found)}`,
        )
        .join("; "),
      counts,
    };
  }
  const changed = targets
    .map((block, k) => ({ block, text: texts[k] ?? "" }))
    .filter(({ block, text }) => text !== block.text);
  return { counts, changed };
}

/**
 * Read, plan, save. The save is one {@link writeContainer} call — one admit
 * batch of `update` ops, each repointing its slot from the blob it was read
 * at to the patched text's blob. A refused batch throws the gate's
 * ChaosClientError, as a save does.
 */
export async function patchContainer(
  facet: ContainerFacet,
  input: PatchInput,
  tenant: Tenant = "notes",
): Promise<PatchResult | PatchError> {
  const { blocks } = await readContainer(facet, input.container);
  const plan = planPatch(blocks, input.slot, input.replacements);
  if ("error" in plan) return plan;
  const ops: ContainerOp[] = plan.changed.map(({ block, text }) => ({
    op: "update",
    slot: block.slot,
    oldBlobId: block.blobId ?? "",
    text,
  }));
  const base = {
    container: input.container,
    counts: plan.counts,
    slots_changed: plan.changed.map(({ block }) => block.slot),
  };
  if (ops.length === 0) return { ...base, noop: true };
  const res = await writeContainer(facet, input.container, ops, tenant);
  return {
    ...base,
    noop: res.noop,
    ...(res.tx !== undefined ? { tx: res.tx } : {}),
  };
}
