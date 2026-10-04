/**
 * The one-off memory-body retype: select the `memory:<scope>:<name>`
 * containers still typed Note, move only their hasType edge to Memory in
 * batches, log every batch's tx, and undo from that log.
 */
import { describe, expect, it } from "vitest";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";
import {
  BODY_TITLE,
  RetypeRefused,
  batchSize,
  main,
  retype,
  revert,
  selectCandidates,
} from "../src/mcp/retype-memory-bodies.js";

const SCOPE = "notes";

async function mint(dial: FixtureChaosDial, title: string, type?: string) {
  const res = await createNote(dial, SCOPE, {
    title,
    ...(type !== undefined ? { type } : {}),
  });
  if (isCreateNoteError(res)) throw new Error(res.detail);
  return res.node_id;
}

async function types(dial: FixtureChaosDial, id: string): Promise<string[]> {
  return (await dial.edges(id))
    .filter((e) => e.predicate === "hasType")
    .map((e) => e.value)
    .sort();
}

async function seeded() {
  const dial = new FixtureChaosDial();
  const plain = await mint(dial, "Projects/plan.md");
  const near = await mint(dial, "memory: a thought");
  const a = await mint(dial, "memory:mnemosyne:alpha");
  const b = await mint(dial, "memory:mnemosyne:beta");
  const c = await mint(dial, "memory:aglaia:gamma");
  const done = await mint(dial, "memory:mnemosyne:done", "Memory");
  return { dial, plain, near, a, b, c, done };
}

describe("BODY_TITLE", () => {
  it("matches memory:<scope>:<name> only", () => {
    expect(BODY_TITLE.test("memory:mnemosyne:x")).toBe(true);
    expect(BODY_TITLE.test("memory:mnemosyne:")).toBe(false);
    expect(BODY_TITLE.test("memory: a thought")).toBe(false);
    expect(BODY_TITLE.test("memory::x")).toBe(false);
    expect(BODY_TITLE.test("xmemory:m:x")).toBe(false);
  });
});

describe("retype", () => {
  it("selects only Note-typed body titles", async () => {
    const { dial, a, b, c } = await seeded();
    const { extent, candidates } = await selectCandidates(dial, SCOPE);
    // The plain note, the near miss, and three bodies (the root is untyped).
    expect(extent).toBe(5);
    expect(candidates.map((x) => x.id)).toEqual([a, b, c].sort());
    expect(candidates.every((x) => !x.hasTarget)).toBe(true);
  });

  it("a probe lists the plan and writes nothing", async () => {
    const { dial, a } = await seeded();
    const admits = dial.admits.length;
    const log = await retype(dial, SCOPE, { probe: true, batch: 2 });
    expect(log).toMatchObject({
      graph: SCOPE,
      predicate: "hasType",
      from: "Note",
      to: "Memory",
      probe: true,
      note_extent: 5,
      selected: 3,
      by_scope: { mnemosyne: 2, aglaia: 1 },
      batches: [],
    });
    expect(log.nodes).toContainEqual({
      id: a,
      label: "memory:mnemosyne:alpha",
    });
    expect(dial.admits.length).toBe(admits);
    expect(await types(dial, a)).toEqual(["Note"]);
  });

  it("applies in batches, logs each tx, and moves only hasType", async () => {
    const { dial, plain, near, a, b, c } = await seeded();
    const log = await retype(dial, SCOPE, { probe: false, batch: 2 });
    expect(log.nodes).toBeUndefined();
    expect(log.batches.map((x) => x.ids.length)).toEqual([2, 1]);
    expect(log.batches.every((x) => typeof x.tx === "number")).toBe(true);
    for (const id of [a, b, c])
      expect(await types(dial, id)).toEqual(["Memory"]);
    for (const id of [plain, near])
      expect(await types(dial, id)).toEqual(["Note"]);
    // The kind (the reuse key) is untouched: the same node comes back.
    expect(await dial.findByName("Note", "memory:mnemosyne:alpha")).toEqual([
      a,
    ]);
  });

  it("is idempotent: a second run selects nothing and writes nothing", async () => {
    const { dial } = await seeded();
    await retype(dial, SCOPE, { probe: false, batch: 50 });
    const admits = dial.admits.length;
    const again = await retype(dial, SCOPE, { probe: false, batch: 50 });
    expect(again.selected).toBe(0);
    expect(again.batches).toEqual([]);
    expect(dial.admits.length).toBe(admits);
  });

  it("a half-retyped node only loses its Note edge", async () => {
    const { dial, a } = await seeded();
    await dial.admit(
      [
        {
          op: "addEdge",
          from_id: a,
          predicate: "hasType",
          to_literal: "Memory",
        },
      ],
      SCOPE,
    );
    const { candidates } = await selectCandidates(dial, SCOPE);
    expect(candidates.find((x) => x.id === a)?.hasTarget).toBe(true);
    await retype(dial, SCOPE, { probe: false, batch: 50 });
    const ops = dial.admits.at(-1)?.ops ?? [];
    expect(ops.filter((o) => o.from_id === a)).toHaveLength(1);
    expect(await types(dial, a)).toEqual(["Memory"]);
  });

  it("a refused batch throws with the log of what landed", async () => {
    const { dial } = await seeded();
    const real = dial.admit.bind(dial);
    let calls = 0;
    dial.admit = (ops, scope) => {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve({
          admitted: false,
          minted: [],
          violations: ["no"],
        });
      }
      return real(ops, scope);
    };
    const err = await retype(dial, SCOPE, { probe: false, batch: 2 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetypeRefused);
    const refused = err as RetypeRefused;
    expect(refused.log.batches).toHaveLength(1);
    expect(refused.violations).toEqual(["no"]);
    expect(refused.message).toBe('the gate refused a batch: ["no"]');
  });
});

describe("revert", () => {
  it("puts every logged node back to Note, one admit per batch", async () => {
    const { dial, a, b, c } = await seeded();
    const log = await retype(dial, SCOPE, { probe: false, batch: 2 });
    const back = await revert(dial, SCOPE, log);
    expect(back.map((x) => x.ids)).toEqual(log.batches.map((x) => x.ids));
    for (const id of [a, b, c]) expect(await types(dial, id)).toEqual(["Note"]);
  });

  it("a refused revert names the tx it was undoing", async () => {
    const { dial } = await seeded();
    dial.refuseWith = ["nope"];
    await expect(
      revert(dial, SCOPE, { batches: [{ tx: 7, ids: ["x"] }] }),
    ).rejects.toThrow('revert of tx 7 refused: ["nope"]');
  });
});

describe("the CLI", () => {
  it("batchSize defaults to 200 and refuses a non-positive value", () => {
    expect(batchSize([])).toBe(200);
    expect(batchSize(["--batch", "25"])).toBe(25);
    expect(() => batchSize(["--batch", "0"])).toThrow(
      "--batch needs a positive integer",
    );
    expect(() => batchSize(["--batch"])).toThrow();
    expect(() => batchSize(["--batch", "1.5"])).toThrow();
  });

  it("--probe prints the plan as one JSON line", async () => {
    const { dial } = await seeded();
    const lines: string[] = [];
    await main(
      ["bun", "x", "--probe"],
      {},
      { dial, write: (l) => lines.push(l) },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    const out = JSON.parse(lines[0] ?? "") as {
      probe: boolean;
      selected: number;
    };
    expect(out).toMatchObject({ probe: true, selected: 3 });
  });

  it("apply then --revert round-trips through the printed log", async () => {
    const { dial, a } = await seeded();
    const lines: string[] = [];
    const write = (l: string) => lines.push(l);
    await main(["bun", "x", "--batch", "2"], {}, { dial, write });
    expect(await types(dial, a)).toEqual(["Memory"]);
    await main(
      ["bun", "x", "--revert"],
      {},
      {
        dial,
        write,
        stdin: () => Promise.resolve(lines[0] ?? ""),
      },
    );
    expect(await types(dial, a)).toEqual(["Note"]);
    const reverted = JSON.parse(lines[1] ?? "") as { reverted: unknown[] };
    expect(reverted.reverted).toHaveLength(2);
  });

  it("a refusal prints the partial log with the violations, then throws", async () => {
    const { dial } = await seeded();
    dial.refuseWith = ["closed"];
    const lines: string[] = [];
    await expect(
      main(["bun", "x"], {}, { dial, write: (l) => lines.push(l) }),
    ).rejects.toThrow("the gate refused a batch");
    const out = JSON.parse(lines[0] ?? "") as {
      batches: unknown[];
      refused: unknown[];
    };
    expect(out.batches).toEqual([]);
    expect(out.refused).toEqual(["closed"]);
  });
});
