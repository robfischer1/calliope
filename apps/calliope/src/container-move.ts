/**
 * Move blocks between containers — the slot is the durable identity, so a
 * move re-homes its membership and re-keys its position and touches nothing
 * else: blob, slot token and the slot's facts are unchanged, so history from
 * BOTH containers still reaches the slot's transactions (the door's closure
 * over `tree_member` includes every slot a container ever held).
 *
 * One admit batch, conditional on what was read: the source's member set,
 * the destination's member set and each moved slot's position must still
 * hold, else the whole batch refuses `conflict` and nothing is written.
 */

import {
  ChaosClientError,
  type ChaosDial,
  type ChaosExpect,
  type ChaosOp,
  type Tenant,
  graphToken,
  scopeHash,
  tenantScope,
} from "./chaos-client.js";
import type { ContainerFacet } from "./container-write.js";
import { between } from "./order-key.js";
import { TREE_MEMBER, moveOps, readTree, repositionOps } from "./tree.js";

/** Where the moved slots land in the destination. */
export type MovePosition = "end" | "start" | (string & {});

export interface MoveBlocksResult {
  /** The graph transaction the batch landed as. */
  tx?: number;
  /** The moved slots in their new order, with the keys they now hold. */
  moved: { slot: string; position: string }[];
}

/** A caller error — surfaced as `bad_args`, nothing written. */
export class MoveBlocksError extends Error {
  constructor(
    readonly code: "bad_args" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "MoveBlocksError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

const heldNodes = (tokens: string[]): ChaosExpect["held"] =>
  tokens.map((node) => ({ node }));

/** Verify the member edges live in the tenant's own graph, where the dial
 *  can say (placedEdges); a membership homed elsewhere is cross-tenant. */
async function assertSameTenant(
  dial: ChaosDial,
  container: string,
  scope: string,
  members: ReadonlySet<string>,
  label: string,
): Promise<void> {
  if (dial.placedEdges === undefined) return;
  const home = new Set([scopeHash(scope), graphToken(scope)]);
  for (const e of await dial.placedEdges(container)) {
    if (e.predicate !== TREE_MEMBER || !members.has(e.value)) continue;
    if (e.graph !== "" && !home.has(e.graph)) {
      throw new MoveBlocksError(
        "not_found",
        `move_blocks: ${label} ${container} holds ${e.value} in another ` +
          `tenant's graph (not ${scope}); cross-tenant moves are refused`,
      );
    }
  }
}

export async function moveBlocks(
  facet: ContainerFacet,
  args: {
    from: string;
    to: string;
    slots: string[];
    position?: MovePosition;
  },
  tenant: Tenant = "notes",
): Promise<MoveBlocksResult> {
  const { from, to, slots } = args;
  const where = args.position ?? "end";
  const scope = (facet.scope ?? tenantScope)(tenant);
  if (slots.length === 0) {
    throw new MoveBlocksError("bad_args", "move_blocks: slots is empty");
  }
  if (new Set(slots).size !== slots.length) {
    throw new MoveBlocksError("bad_args", "move_blocks: slots repeats a slot");
  }
  if (from === to) {
    throw new MoveBlocksError(
      "bad_args",
      "move_blocks: from and to are the same container (use reorder)",
    );
  }
  if (where !== "end" && where !== "start" && !HEX64.test(where)) {
    throw new MoveBlocksError(
      "bad_args",
      'move_blocks: position is "end", "start" or a 64-hex slot to land after',
    );
  }

  const source = await readTree(facet.dial, from);
  const dest = await readTree(facet.dial, to);
  const sourceSet = new Set(source.map((s) => s.slot));
  const missing = slots.filter((s) => !sourceSet.has(s));
  if (missing.length > 0) {
    throw new MoveBlocksError(
      "not_found",
      `move_blocks: ${missing.join(", ")} is not a member of ${from}; ` +
        "nothing was moved",
    );
  }
  if (dest.some((d) => slots.includes(d.slot))) {
    throw new MoveBlocksError(
      "bad_args",
      `move_blocks: a named slot is already a member of ${to}`,
    );
  }
  await assertSameTenant(facet.dial, from, scope, sourceSet, "source");
  await assertSameTenant(
    facet.dial,
    to,
    scope,
    new Set(dest.map((d) => d.slot)),
    "destination",
  );

  // Original relative order, by the source's position.
  const picked = source.filter((s) => slots.includes(s.slot));

  // The gap in the destination: (lo, hi) exclusive.
  let lo: string | null;
  let hi: string | null;
  if (where === "end") {
    lo = dest.at(-1)?.position ?? null;
    hi = null;
  } else if (where === "start") {
    lo = null;
    hi = dest[0]?.position ?? null;
  } else {
    const at = dest.findIndex((d) => d.slot === where);
    if (at < 0) {
      throw new MoveBlocksError(
        "not_found",
        `move_blocks: ${where} is not a member of ${to}`,
      );
    }
    lo = dest[at]?.position ?? null;
    hi = dest[at + 1]?.position ?? null;
  }
  if (lo !== null && hi !== null && lo >= hi) {
    throw new MoveBlocksError(
      "bad_args",
      `move_blocks: ${to} has no room between positions ${lo} and ${hi}`,
    );
  }

  // n ascending keys inside the gap: each between the previous and hi.
  const moved: { slot: string; position: string }[] = [];
  let prev = lo;
  for (const s of picked) {
    const key = between(prev, hi);
    moved.push({ slot: s.slot, position: key });
    prev = key;
  }

  const batch: ChaosOp[] = [];
  for (const [i, s] of picked.entries()) {
    batch.push(
      ...moveOps(s.slot, from, to),
      ...repositionOps(s.slot, s.position, moved[i]?.position ?? ""),
    );
  }
  const expects: ChaosExpect[] = [
    {
      s: from,
      predicate: TREE_MEMBER,
      held: heldNodes(source.map((s) => s.slot)),
    },
    ...picked.map((s): ChaosExpect => ({
      s: s.slot,
      predicate: "tree_position",
      held: [{ literal: s.position }],
    })),
  ];
  if (dest.length > 0) {
    expects.push({
      s: to,
      predicate: TREE_MEMBER,
      held: heldNodes(dest.map((d) => d.slot)),
    });
  }

  let res;
  try {
    res = await facet.dial.admit(batch, scope, expects);
  } catch (err) {
    if (err instanceof ChaosClientError && err.code === "conflict") {
      throw new ChaosClientError(
        "move_blocks: conflict — the source, the destination or a moved " +
          "slot changed after it was read; re-read both containers and " +
          `retry. Nothing was moved. [${err.message}]`,
        "conflict",
      );
    }
    throw err;
  }
  if (!res.admitted) {
    throw new ChaosClientError(
      "move_blocks: the gate refused the batch; nothing moved",
      "admit_refused",
      res.violations,
    );
  }
  return { moved, ...(res.tx !== undefined ? { tx: res.tx } : {}) };
}
