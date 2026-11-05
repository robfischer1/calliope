/**
 * move_blocks, pinned past what the behaviour tests reach: the exact
 * refusal codes and messages, the cross-tenant fence, the key arithmetic of
 * each landing (end / start / after an anchor), the three rebalance shapes,
 * and the batch's own shape (ops, expects, error mapping, result).
 */

import { describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  type ChaosExpect,
  type ChaosOp,
  FixtureChaosDial,
  type PlacedEdge,
  opAdd,
  opCreate,
  scopeHash,
} from "../src/chaos-client.js";
import { MoveBlocksError, moveBlocks } from "../src/container-move.js";
import { readContainer } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { TREE_MEMBER, readTree, repositionOps } from "../src/tree.js";

/** Records each admit's expectations; can pose as a dial that answers a
 *  fixed placed-edge list (the tenant fence's input). */
class SpyDial extends FixtureChaosDial {
  readonly expects: (ChaosExpect[] | undefined)[] = [];
  placed: PlacedEdge[] | null = null;
  override admit(
    ops: ChaosOp[],
    scope: string,
    expect?: ChaosExpect[],
  ): ReturnType<FixtureChaosDial["admit"]> {
    this.expects.push(expect);
    return super.admit(ops, scope, expect);
  }
  override placedEdges(token: string): Promise<PlacedEdge[]> {
    return this.placed === null
      ? super.placedEdges(token)
      : Promise.resolve(this.placed.filter((e) => e.subject === token));
  }
}

async function world(srcPositions: string[], dstPositions: string[]) {
  const dial = new SpyDial();
  const blobs = new FixtureBlobStore();
  const facet = { dial, blobs };
  const mint = async (label: string): Promise<string> =>
    (await dial.admit([opCreate("Note", label)], "notes")).minted[0] ?? "";
  const from = await mint("src");
  const to = await mint("dst");
  const lay = async (c: string, positions: string[], tag: string) => {
    if (positions.length === 0) return;
    await writeContainer(
      facet,
      c,
      positions.map((position, i) => ({
        op: "add" as const,
        text: `${tag}${String(i)}`,
        position,
      })),
    );
  };
  await lay(from, srcPositions, "s");
  await lay(to, dstPositions, "d");
  const src = await readTree(dial, from);
  const dst = await readTree(dial, to);
  const slotsOf = (xs: { slot: string }[]) => xs.map((x) => x.slot);
  const dump = async (c: string) =>
    (await readContainer(facet, c)).blocks.map((b) => [b.text, b.position]);
  return { dial, blobs, facet, from, to, src, dst, slotsOf, dump };
}

const edge = (
  subject: string,
  predicate: string,
  value: string,
  graph: string,
): PlacedEdge => ({
  subject,
  predicate,
  value,
  isNode: true,
  domain: "node",
  graph,
});

describe("MoveBlocksError", () => {
  it("is named, carries its code, and is an Error", () => {
    const e = new MoveBlocksError("not_found", "m");
    expect(e.name).toBe("MoveBlocksError");
    expect(e.code).toBe("not_found");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("move_blocks refusals say exactly what is wrong", () => {
  it("names each caller error by code and message", async () => {
    const w = await world(["01", "02"], ["03"]);
    const s = w.slotsOf(w.src);
    const a = s[0] ?? "";
    const admits = w.dial.admits.length;
    const refuse = (
      args: { from: string; to: string; slots: string[]; position?: string },
      code: string,
      message: string,
    ) =>
      expect(moveBlocks(w.facet, args)).rejects.toMatchObject({
        name: "MoveBlocksError",
        code,
        message,
      });
    await refuse(
      { from: w.from, to: w.to, slots: [] },
      "bad_args",
      "move_blocks: slots is empty",
    );
    await refuse(
      { from: w.from, to: w.to, slots: [a, a] },
      "bad_args",
      "move_blocks: slots repeats a slot",
    );
    await refuse(
      { from: w.from, to: w.from, slots: [a] },
      "bad_args",
      "move_blocks: from and to are the same container (use reorder)",
    );
    await refuse(
      { from: w.from, to: w.to, slots: [a], position: "middle" },
      "bad_args",
      'move_blocks: position is "end", "start" or a 64-hex slot to land after',
    );
    const ghost = "c".repeat(64);
    await refuse(
      { from: w.from, to: w.to, slots: [a], position: ghost },
      "not_found",
      `move_blocks: ${ghost} is not a member of ${w.to}`,
    );
    expect(w.dial.admits.length).toBe(admits);
  });

  it("lists every slot the source does not hold, in the order asked", async () => {
    const w = await world(["01"], ["03", "04"]);
    const [d0, d1] = w.slotsOf(w.dst);
    await expect(
      moveBlocks(w.facet, {
        from: w.from,
        to: w.to,
        slots: [d1 ?? "", d0 ?? ""],
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: `move_blocks: ${d1 ?? ""}, ${d0 ?? ""} is not a member of ${w.from}; nothing was moved`,
    });
  });

  it("refuses a slot the destination already holds", async () => {
    const w = await world(["01", "02"], ["03"]);
    const a = w.slotsOf(w.src)[0] ?? "";
    await w.dial.admit([opAdd(w.to, TREE_MEMBER, { toNode: a })], "notes");
    const admits = w.dial.admits.length;
    await expect(
      moveBlocks(w.facet, { from: w.from, to: w.to, slots: [a] }),
    ).rejects.toMatchObject({
      name: "MoveBlocksError",
      code: "bad_args",
      message: `move_blocks: a named slot is already a member of ${w.to}`,
    });
    expect(w.dial.admits.length).toBe(admits);
  });

  it("refuses an anchor with no room after it, naming both positions", async () => {
    const w = await world(["01"], ["05", "06"]);
    const [d0, d1] = w.slotsOf(w.dst);
    // Two members holding one key: no key fits strictly between them.
    await w.dial.admit(repositionOps(d1 ?? "", "06", "05"), "notes");
    const admits = w.dial.admits.length;
    await expect(
      moveBlocks(w.facet, {
        from: w.from,
        to: w.to,
        slots: [w.slotsOf(w.src)[0] ?? ""],
        position: d0 ?? "",
      }),
    ).rejects.toMatchObject({
      name: "MoveBlocksError",
      code: "bad_args",
      message: `move_blocks: ${w.to} has no room between positions 05 and 05`,
    });
    expect(w.dial.admits.length).toBe(admits);
  });
});

describe("the cross-tenant fence", () => {
  it("refuses a source whose membership is homed in another tenant's graph", async () => {
    const w = await world(["01", "02"], ["03"]);
    const [a] = w.slotsOf(w.src);
    // Written under notes, moved as threads: the edges sit in another graph.
    await expect(
      moveBlocks(
        w.facet,
        { from: w.from, to: w.to, slots: [a ?? ""] },
        "threads",
      ),
    ).rejects.toMatchObject({
      name: "MoveBlocksError",
      code: "not_found",
      message:
        `move_blocks: source ${w.from} holds ${[...w.slotsOf(w.src)].sort()[0] ?? ""}` +
        " in another tenant's graph (not threads); cross-tenant moves are refused",
    });
    expect(w.dial.admits.at(-1)?.scope).toBe("notes");
  });

  it("refuses a destination homed elsewhere, and says destination", async () => {
    const w = await world(["01"], ["03"]);
    const d = w.slotsOf(w.dst)[0] ?? "";
    w.dial.placed = [edge(w.to, TREE_MEMBER, d, scopeHash("elsewhere"))];
    await expect(
      moveBlocks(w.facet, {
        from: w.from,
        to: w.to,
        slots: [w.slotsOf(w.src)[0] ?? ""],
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message:
        `move_blocks: destination ${w.to} holds ${d} in another tenant's ` +
        "graph (not notes); cross-tenant moves are refused",
    });
  });

  it("lets through edges that are not foreign tree membership of the held set", async () => {
    const w = await world(["01"], ["03"]);
    const a = w.slotsOf(w.src)[0] ?? "";
    const d = w.slotsOf(w.dst)[0] ?? "";
    const foreign = scopeHash("elsewhere");
    w.dial.placed = [
      // foreign graph, held value, but not the membership predicate
      edge(w.from, "tree_ref", a, foreign),
      edge(w.to, "tree_ref", d, foreign),
      // foreign membership of a value the container does not hold
      edge(w.from, TREE_MEMBER, "e".repeat(64), foreign),
      edge(w.to, TREE_MEMBER, "f".repeat(64), foreign),
      // held membership with no graph on the wire, and in the home graph
      edge(w.from, TREE_MEMBER, a, ""),
      edge(w.to, TREE_MEMBER, d, scopeHash("notes")),
    ];
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: [a],
    });
    expect(res.moved.map((m) => m.slot)).toEqual([a]);
  });

  it("takes a scope given as a token as its own home graph", async () => {
    const w = await world(["01"], ["03"]);
    const a = w.slotsOf(w.src)[0] ?? "";
    const token = "9".repeat(64);
    w.dial.placed = [edge(w.from, TREE_MEMBER, a, token)];
    const facet = { ...w.facet, scope: () => token };
    const res = await moveBlocks(facet, { from: w.from, to: w.to, slots: [a] });
    expect(res.moved).toHaveLength(1);
  });

  it("moves on a dial that cannot say where edges live", async () => {
    const w = await world(["01"], ["03"]);
    Object.defineProperty(w.dial, "placedEdges", { value: undefined });
    const a = w.slotsOf(w.src)[0] ?? "";
    const res = await moveBlocks(w.facet, { from: w.from, to: w.to, slots: [a] });
    expect(res.moved.map((m) => m.slot)).toEqual([a]);
  });
});

describe("where the moved slots land", () => {
  it("end mints above the last key and leaves the destination's keys alone", async () => {
    const w = await world(["01"], ["03", "06"]);
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
    });
    expect(res.moved).toEqual([{ slot: w.slotsOf(w.src)[0], position: "1" }]);
    expect(await w.dump(w.to)).toEqual([
      ["d0", "03"],
      ["d1", "06"],
      ["s0", "1"],
    ]);
  });

  it("start mints below the first key and leaves the destination's keys alone", async () => {
    const w = await world(["01"], ["03", "06"]);
    await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: "start",
    });
    expect(await w.dump(w.to)).toEqual([
      ["s0", "02"],
      ["d0", "03"],
      ["d1", "06"],
    ]);
  });

  it("an empty destination takes the canonical first key, from either end", async () => {
    for (const position of ["end", "start"]) {
      const w = await world(["01"], []);
      const res = await moveBlocks(w.facet, {
        from: w.from,
        to: w.to,
        slots: w.slotsOf(w.src),
        position,
      });
      expect(res.moved).toEqual([
        { slot: w.slotsOf(w.src)[0], position: "5" },
      ]);
    }
  });

  it("after the first member lands between it and the next", async () => {
    const w = await world(["01"], ["03", "06"]);
    await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: w.slotsOf(w.dst)[0] ?? "",
    });
    expect(await w.dump(w.to)).toEqual([
      ["d0", "03"],
      ["s0", "04"],
      ["d1", "06"],
    ]);
  });

  it("after the last member lands above it", async () => {
    const w = await world(["01"], ["03", "06"]);
    await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: w.slotsOf(w.dst)[1] ?? "",
    });
    expect(await w.dump(w.to)).toEqual([
      ["d0", "03"],
      ["d1", "06"],
      ["s0", "1"],
    ]);
  });

  it("several slots take ascending keys inside the gap", async () => {
    const w = await world(["01", "02"], ["03", "06"]);
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: w.slotsOf(w.dst)[0] ?? "",
    });
    expect(res.moved.map((m) => m.position)).toEqual(["04", "05"]);
    expect(await w.dump(w.to)).toEqual([
      ["d0", "03"],
      ["s0", "04"],
      ["s1", "05"],
      ["d1", "06"],
    ]);
  });
});

describe("when no key fits, the destination is re-laid in the same admit", () => {
  it("at the end", async () => {
    const w = await world(["01"], ["9998", "9999"]);
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
    });
    expect(res.moved).toEqual([{ slot: w.slotsOf(w.src)[0], position: "03" }]);
    expect(await w.dump(w.to)).toEqual([
      ["d0", "01"],
      ["d1", "02"],
      ["s0", "03"],
    ]);
  });

  it("at the start", async () => {
    const w = await world(["01"], ["0", "1"]);
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: "start",
    });
    expect(res.moved).toEqual([{ slot: w.slotsOf(w.src)[0], position: "01" }]);
    expect(await w.dump(w.to)).toEqual([
      ["s0", "01"],
      ["d0", "02"],
      ["d1", "03"],
    ]);
  });

  it("after an anchor in the middle", async () => {
    const w = await world(["01"], ["5555", "5556", "5557"]);
    const res = await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
      position: w.slotsOf(w.dst)[1] ?? "",
    });
    expect(res.moved).toEqual([{ slot: w.slotsOf(w.src)[0], position: "03" }]);
    expect(await w.dump(w.to)).toEqual([
      ["d0", "01"],
      ["d1", "02"],
      ["s0", "03"],
      ["d2", "04"],
    ]);
  });

  it("leaves a member that already holds its new key out of the batch", async () => {
    const w = await world(["01"], ["01", "9999"]);
    await moveBlocks(w.facet, {
      from: w.from,
      to: w.to,
      slots: w.slotsOf(w.src),
    });
    const [d0, d1] = w.slotsOf(w.dst);
    const ops = w.dial.admits.at(-1)?.ops ?? [];
    expect(ops.filter((o) => o.from_id === d0)).toEqual([]);
    expect(ops.filter((o) => o.from_id === d1)).toHaveLength(2);
    expect(await w.dump(w.to)).toEqual([
      ["d0", "01"],
      ["d1", "02"],
      ["s0", "03"],
    ]);
  });
});

describe("the batch it admits", () => {
  it("is exactly the re-home and re-key ops, guarded by what was read", async () => {
    const w = await world(["01", "02"], ["03"]);
    const [a, b] = w.slotsOf(w.src);
    await moveBlocks(w.facet, { from: w.from, to: w.to, slots: [a ?? ""] });
    const last = w.dial.admits.at(-1);
    expect(last?.scope).toBe("notes");
    expect(last?.ops).toHaveLength(4);
    expect(last?.ops.every((o) => typeof o === "object")).toBe(true);
    const guard = w.dial.expects.at(-1);
    expect(guard).toEqual([
      {
        s: w.from,
        predicate: TREE_MEMBER,
        held: [{ node: a }, { node: b }],
      },
      { s: a, predicate: "tree_position", held: [{ literal: "01" }] },
      { s: w.to, predicate: TREE_MEMBER, held: [{ node: w.slotsOf(w.dst)[0] }] },
    ]);
  });

  it("guards a populated destination: a late write there is a conflict", async () => {
    const w = await world(["01"], ["03"]);
    const real = w.dial.admit.bind(w.dial);
    w.dial.admit = async (ops, scope, expect) => {
      w.dial.admit = real;
      await writeContainer(w.facet, w.to, [
        { op: "add", text: "late", position: "09" },
      ]);
      return real(ops, scope, expect);
    };
    await expect(
      moveBlocks(w.facet, {
        from: w.from,
        to: w.to,
        slots: w.slotsOf(w.src),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await w.dump(w.from)).toEqual([["s0", "01"]]);
  });

  it("does not guard an empty destination", async () => {
    const w = await world(["01"], []);
    await moveBlocks(w.facet, { from: w.from, to: w.to, slots: w.slotsOf(w.src) });
    const guard = w.dial.expects.at(-1) ?? [];
    expect(guard.map((g) => g.s)).toEqual([w.from, w.slotsOf(w.src)[0]]);
  });

  it("guards each member it re-keys in a rebalance by the key it held", async () => {
    const w = await world(["01"], ["9998", "9999"]);
    const [d0, d1] = w.slotsOf(w.dst);
    await moveBlocks(w.facet, { from: w.from, to: w.to, slots: w.slotsOf(w.src) });
    const guard = w.dial.expects.at(-1) ?? [];
    expect(guard.slice(0, 2)).toEqual([
      { s: d0, predicate: "tree_position", held: [{ literal: "9998" }] },
      { s: d1, predicate: "tree_position", held: [{ literal: "9999" }] },
    ]);
  });
});

describe("how the admit's outcome is answered", () => {
  const rig = async () => world(["01"], ["03"]);
  const move = (w: Awaited<ReturnType<typeof rig>>) =>
    moveBlocks(w.facet, { from: w.from, to: w.to, slots: w.slotsOf(w.src) });

  it("rewraps a conflict with the retry advice and the original detail", async () => {
    const w = await rig();
    w.dial.admit = () =>
      Promise.reject(new ChaosClientError("boom", "conflict"));
    const err: unknown = await move(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect(err).toMatchObject({
      code: "conflict",
      message:
        "move_blocks: conflict — the source, the destination or a moved " +
        "slot changed after it was read; re-read both containers and " +
        "retry. Nothing was moved. [boom]",
    });
  });

  it("passes every other failure through untouched", async () => {
    const w = await rig();
    const wire = new ChaosClientError("down", "wire_error");
    w.dial.admit = () => Promise.reject(wire);
    expect(await move(w).catch((e: unknown) => e)).toBe(wire);

    const plain = Object.assign(new Error("plain"), { code: "conflict" });
    w.dial.admit = () => Promise.reject(plain);
    expect(await move(w).catch((e: unknown) => e)).toBe(plain);

    const bare = new Error("bare");
    w.dial.admit = () => Promise.reject(bare);
    expect(await move(w).catch((e: unknown) => e)).toBe(bare);
  });

  it("surfaces a gate refusal with its violations", async () => {
    const w = await rig();
    w.dial.refuseWith = [{ rule: "no" }];
    const err: unknown = await move(w).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect(err).toMatchObject({
      code: "admit_refused",
      message: "move_blocks: the gate refused the batch; nothing moved",
      violations: [{ rule: "no" }],
    });
  });

  it("answers the transaction when the gate names one, and no key when it does not", async () => {
    const w = await rig();
    const res = await move(w);
    expect(typeof res.tx).toBe("number");

    const w2 = await rig();
    const real = w2.dial.admit.bind(w2.dial);
    w2.dial.admit = async (ops, scope, expect) => {
      const res = await real(ops, scope, expect);
      return {
        admitted: res.admitted,
        minted: res.minted,
        violations: res.violations,
      };
    };
    const none = await move(w2);
    expect(none).toStrictEqual({
      moved: [{ slot: w2.slotsOf(w2.src)[0], position: "1" }],
    });
  });
});
