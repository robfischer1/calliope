/**
 * chaos-client's pure surface and its in-memory fixture dial, pinned against
 * the mutation survivors: op constructors, the SSE / text-block decoders, the
 * ensureNotesRoot decision tree (driven through a scripted dial), and every
 * observable rule of FixtureChaosDial (slot expectations, batch labels, typed
 * literals and their retraction, ref resolution, as-of reads, history).
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANCHORS_ROLE,
  ChaosClientError,
  FixtureChaosDial,
  decodeRpcBody,
  ensureNotesRoot,
  opAdd,
  opCreate,
  opRemove,
  scopeHash,
  shapeFromTextBlocks,
  type AdmitResult,
  type ChaosDial,
  type ChaosOp,
} from "../src/chaos-client.js";
import { canonicalInstant, renderEastern } from "../src/instant.js";

const SCOPE = "notes";
const Z = "2026-10-17T22:12:00+00:00";
const Z2 = "2026-10-18T01:00:00+00:00";

function rendered(instant: string): string {
  const micros = canonicalInstant(instant);
  if (micros === null) throw new Error("bad test instant");
  return renderEastern(BigInt(micros));
}

describe("op constructors", () => {
  it("opCreate defaults the label to the empty string", () => {
    expect(opCreate("Note")).toStrictEqual({
      op: "createNode",
      kind: "Note",
      label: "",
    });
  });

  it("opAdd carries to_blob only when a blob target is stated", () => {
    expect(opAdd("a", "p", { toBlob: "7" })).toStrictEqual({
      op: "addEdge",
      from_id: "a",
      predicate: "p",
      to_literal: null,
      to_node: null,
      to_blob: "7",
    });
    expect(opAdd("a", "p", { toLiteral: "x" })).toStrictEqual({
      op: "addEdge",
      from_id: "a",
      predicate: "p",
      to_literal: "x",
      to_node: null,
    });
  });

  it("opRemove carries the graph pin only when given", () => {
    expect(opRemove("a", "p", { toNode: "n" })).toStrictEqual({
      op: "removeEdge",
      from_id: "a",
      predicate: "p",
      to_literal: null,
      to_node: "n",
    });
    expect(opRemove("a", "p", { toNode: "n" }, "g1")).toMatchObject({
      graph: "g1",
    });
  });

  it("ChaosClientError defaults to a wire_error with no violations", () => {
    const err = new ChaosClientError("x");
    expect(err.code).toBe("wire_error");
    expect(err.violations).toStrictEqual([]);
    expect(err.name).toBe("ChaosClientError");
  });

  it("scopeHash hashes the UTF-8 bytes of the name", () => {
    expect(scopeHash("café ☃")).toBe(
      createHash("sha256").update(Buffer.from("café ☃", "utf8")).digest("hex"),
    );
  });
});

describe("decodeRpcBody — SSE field rules, to the byte", () => {
  const V = "verb";

  it("data lines of one event join with a newline, never run together", () => {
    // joined with "" these would be the number 12
    expect(() =>
      decodeRpcBody("data: 1\ndata: 2\n\n", "text/event-stream", V),
    ).toThrow(SyntaxError);
    expect(() =>
      decodeRpcBody("data: 1\ndata: 2", "text/event-stream", V),
    ).toThrow(SyntaxError);
  });

  it("a line of only carriage returns ends the event", () => {
    const sse = 'data: {"a":1}\n\r\r\ndata: {"b":2}\n\n';
    expect(decodeRpcBody(sse, "text/event-stream", V)).toEqual({ b: 2 });
  });

  it("carriage returns are stripped at the line end only", () => {
    expect(() =>
      decodeRpcBody('data: "a\rb"\n\n', "text/event-stream", V),
    ).toThrow(SyntaxError);
  });

  it("a data: value with no leading space keeps its inner spaces", () => {
    expect(decodeRpcBody('data:"x y"\n\n', "text/event-stream", V)).toBe("x y");
  });

  it("a data: value that starts with a non-space survives the strip", () => {
    expect(decodeRpcBody('data:{"a":1}\n\n', "text/event-stream", V)).toEqual({
      a: 1,
    });
  });

  it("the no-data error quotes only the first 200 characters", () => {
    const text = `event: ${"x".repeat(300)}\n\n`;
    let caught: unknown;
    try {
      decodeRpcBody(text, "text/event-stream", V);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChaosClientError);
    expect((caught as ChaosClientError).message).toBe(
      `chaos wire call "verb": event-stream body carried no data: field: ${JSON.stringify(text.slice(0, 200))}`,
    );
    expect((caught as ChaosClientError).code).toBe("wire_error");
  });
});

describe("shapeFromTextBlocks — which blocks count", () => {
  it("takes only well-formed text blocks, whatever else rides along", () => {
    const content = [
      null,
      undefined,
      "abc",
      7,
      { type: "image", text: "9" },
      { type: "text", text: 5 },
      { type: "text" },
      { type: "text", text: "[1]" },
    ];
    expect(shapeFromTextBlocks(content)).toEqual([1]);
  });
});

// ── ensureNotesRoot, driven through a scripted dial ───────────────────────────

function scripted(opts: { finds: string[][]; admits?: AdmitResult[] }): {
  dial: ChaosDial;
  admitted: { ops: ChaosOp[]; scope: string }[];
} {
  const finds = [...opts.finds];
  const admits = [...(opts.admits ?? [])];
  const admitted: { ops: ChaosOp[]; scope: string }[] = [];
  const dial = {
    findByName: () => Promise.resolve(finds.shift() ?? []),
    admit: (ops: ChaosOp[], scope: string) => {
      admitted.push({ ops, scope });
      const next = admits.shift();
      if (next === undefined) throw new Error("no scripted admit");
      return Promise.resolve(next);
    },
  } as unknown as ChaosDial;
  return { dial, admitted };
}

const OK = (minted: string[]): AdmitResult => ({
  admitted: true,
  minted,
  violations: [],
});

describe("ensureNotesRoot — decision tree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("several standing roots: the lowest wins and the twins are logged", async () => {
    const log = vi.fn();
    const { dial } = scripted({ finds: [["bb", "aa", "cc"]] });
    expect(await ensureNotesRoot(dial, SCOPE, log)).toBe("aa");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "ensureNotesRoot: 3 root twins on the dictionary — using lowest aa",
    );
  });

  it("one standing root logs nothing", async () => {
    const log = vi.fn();
    const { dial } = scripted({ finds: [["bb"]] });
    expect(await ensureNotesRoot(dial, SCOPE, log)).toBe("bb");
    expect(log).not.toHaveBeenCalled();
  });

  it("logs to console.error by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { dial } = scripted({ finds: [["bb", "aa"]] });
    await ensureNotesRoot(dial, SCOPE);
    expect(spy).toHaveBeenCalledWith(
      "ensureNotesRoot: 2 root twins on the dictionary — using lowest aa",
    );
  });

  it.each([
    [{ admitted: false, minted: ["t"], violations: [{ r: 1 }] }],
    [{ admitted: true, minted: [], violations: [{ r: 1 }] }],
    [{ admitted: true, minted: ["a", "b"], violations: [{ r: 1 }] }],
  ])(
    "a mint that is not exactly one admitted token is refused: %j",
    async (mint) => {
      const { dial } = scripted({ finds: [[]], admits: [mint] });
      const err = await ensureNotesRoot(dial, SCOPE, () => undefined).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ChaosClientError);
      expect((err as ChaosClientError).message).toBe(
        "ensureNotesRoot: mint refused",
      );
      expect((err as ChaosClientError).code).toBe("admit_refused");
      expect((err as ChaosClientError).violations).toStrictEqual([{ r: 1 }]);
    },
  );

  it("a minted list holding no token is a bad_result", async () => {
    const { dial } = scripted({
      finds: [[]],
      admits: [OK([undefined as unknown as string])],
    });
    const err = await ensureNotesRoot(dial, SCOPE, () => undefined).catch(
      (e: unknown) => e,
    );
    expect((err as ChaosClientError).message).toBe(
      "ensureNotesRoot: no minted token",
    );
    expect((err as ChaosClientError).code).toBe("bad_result");
  });

  it("the edge batch names the root and anchors its role, in scope", async () => {
    const { dial, admitted } = scripted({
      finds: [[], []],
      admits: [OK(["tok"]), OK([])],
    });
    expect(await ensureNotesRoot(dial, SCOPE, () => undefined)).toBe("tok");
    expect(admitted[1]).toStrictEqual({
      ops: [
        opAdd("tok", "hasName", { toLiteral: "Notes" }),
        opAdd("tok", ANCHORS_ROLE, { toLiteral: "Notes" }),
      ],
      scope: SCOPE,
    });
  });

  it("a refused edge batch is an admit_refused carrying the violations", async () => {
    const { dial } = scripted({
      finds: [[]],
      admits: [
        OK(["tok"]),
        { admitted: false, minted: [], violations: [{ v: 2 }] },
      ],
    });
    const err = await ensureNotesRoot(dial, SCOPE, () => undefined).catch(
      (e: unknown) => e,
    );
    expect((err as ChaosClientError).message).toBe(
      "ensureNotesRoot: edge admit refused",
    );
    expect((err as ChaosClientError).code).toBe("admit_refused");
    expect((err as ChaosClientError).violations).toStrictEqual([{ v: 2 }]);
  });

  it("a mint race: the lowest twin wins and the race is logged", async () => {
    const log = vi.fn();
    const { dial } = scripted({
      finds: [[], ["zz", "aa"]],
      admits: [OK(["tok"]), OK([])],
    });
    expect(await ensureNotesRoot(dial, SCOPE, log)).toBe("aa");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "ensureNotesRoot: mint race — 2 twins; winner aa, this mint tok",
    );
  });

  it("a re-find that names one other node adopts it, silently", async () => {
    const log = vi.fn();
    const { dial } = scripted({
      finds: [[], ["only"]],
      admits: [OK(["tok"]), OK([])],
    });
    expect(await ensureNotesRoot(dial, SCOPE, log)).toBe("only");
    expect(log).not.toHaveBeenCalled();
  });

  it("an empty re-find keeps this mint", async () => {
    const { dial } = scripted({
      finds: [[], []],
      admits: [OK(["tok"]), OK([])],
    });
    expect(await ensureNotesRoot(dial, SCOPE, () => undefined)).toBe("tok");
  });
});

// ── FixtureChaosDial ──────────────────────────────────────────────────────────

function lit(from: string, predicate: string, value: string): ChaosOp {
  return opAdd(from, predicate, { toLiteral: value });
}

describe("FixtureChaosDial — construction and by-name reuse", () => {
  it("starts with an empty fact log", () => {
    expect(new FixtureChaosDial().factLog).toStrictEqual([]);
  });

  it("a by-name find ignores case and surrounding space", async () => {
    const dial = new FixtureChaosDial();
    const { minted } = await dial.admit([opCreate("Note", "Hello")], SCOPE);
    expect(await dial.findByName("Note", "  hELLO ")).toStrictEqual(minted);
    expect(await dial.findByName("Other", "hello")).toStrictEqual([]);
  });

  it("a successful admit answers admitted, tokens, no violations and its tx", async () => {
    const dial = new FixtureChaosDial();
    const out = await dial.admit([opCreate("Note", "a")], SCOPE);
    expect(out).toStrictEqual({
      admitted: true,
      minted: ["1".padStart(64, "0")],
      violations: [],
      tx: 1,
    });
  });

  it("a refusing dial answers admitted:false with no minted tokens", async () => {
    const dial = new FixtureChaosDial();
    dial.refuseWith = [{ r: 1 }];
    expect(await dial.admit([opCreate("Note", "a")], SCOPE)).toStrictEqual({
      admitted: false,
      minted: [],
      violations: [{ r: 1 }],
    });
  });

  it("wire fields coerce through asStr: numbers and booleans spell, the rest are empty", async () => {
    const dial = new FixtureChaosDial();
    const { minted } = await dial.admit(
      [
        { op: "createNode", kind: 5, label: true },
        { op: "createNode", kind: null, label: undefined },
        { op: "createNode", kind: {}, label: [] },
        { op: "createNode", kind: "Note", label: "x" },
      ],
      SCOPE,
    );
    const rows = await dial.resolveNodeRefs(minted);
    expect(rows).toStrictEqual({
      [minted[0] ?? ""]: { ref: minted[0], label: "true", kind: "5" },
      [minted[1] ?? ""]: { ref: minted[1], label: "", kind: "" },
      [minted[2] ?? ""]: { ref: minted[2], label: "", kind: "" },
      [minted[3] ?? ""]: { ref: minted[3], label: "x", kind: "Note" },
    });
  });
});

describe("FixtureChaosDial — slot expectations", () => {
  async function slot(): Promise<FixtureChaosDial> {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        lit("s1", "p", "x"),
        lit("s1", "p", "y"),
        lit("s2", "p", "z"),
        lit("s1", "q", "w"),
      ],
      SCOPE,
    );
    return dial;
  }

  it("the held set is order-free and must match exactly", async () => {
    const dial = await slot();
    const held = (...h: { literal: string }[]) =>
      dial.admit([], SCOPE, [{ s: "s1", predicate: "p", held: h }]);
    await expect(
      held({ literal: "y" }, { literal: "x" }),
    ).resolves.toMatchObject({ admitted: true });
    // same size, one member differs: not held
    await expect(
      held({ literal: "x" }, { literal: "zz" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // a strict subset: not held
    await expect(held({ literal: "x" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("node and blob held values are matched in their own domain", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [opAdd("s3", "p", { toNode: "N" }), opAdd("s3", "p", { toBlob: "5" })],
      SCOPE,
    );
    await expect(
      dial.admit([], SCOPE, [
        { s: "s3", predicate: "p", held: [{ node: "N" }, { $blob: "5" }] },
      ]),
    ).resolves.toMatchObject({ admitted: true });
    await expect(
      dial.admit([], SCOPE, [
        { s: "s3", predicate: "p", held: [{ literal: "N" }, { $blob: "5" }] },
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("a conflict names the slot, the scope and the revision count of that slot only", async () => {
    const dial = await slot();
    let err: unknown;
    try {
      await dial.admit([], SCOPE, [
        { s: "s1", predicate: "p", held: [{ literal: "no" }] },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((err as ChaosClientError).message).toBe(
      "admit: conflict: expect[0] s=s1 predicate=p g=* want=held have=rev:2",
    );
    const named = await dial
      .admit([], SCOPE, [
        { s: "s2", predicate: "p", g: "abc", held: [{ literal: "no" }] },
      ])
      .catch((e: unknown) => e);
    expect((named as ChaosClientError).message).toBe(
      "admit: conflict: expect[0] s=s2 predicate=p g=abc want=held have=rev:1",
    );
  });

  it("an expectation on a slot nothing ever touched fails against an empty slot", async () => {
    const dial = new FixtureChaosDial();
    await expect(
      dial.admit([], SCOPE, [
        { s: "never", predicate: "p", held: [{ literal: "x" }] },
      ]),
    ).rejects.toMatchObject({
      message:
        "admit: conflict: expect[0] s=never predicate=p g=* want=held have=rev:0",
    });
    await expect(
      dial.admit([], SCOPE, [{ s: "never", predicate: "p", held: [] }]),
    ).resolves.toMatchObject({ admitted: true });
  });
});

describe("FixtureChaosDial — batch labels and edge domains", () => {
  it("a non-empty create label names its mint, the first create winning a duplicate", async () => {
    const dial = new FixtureChaosDial();
    const { minted } = await dial.admit(
      [
        opCreate("K", "L"),
        opCreate("K", "L"),
        opCreate("K", ""),
        lit("L", "p", "v"),
        opAdd("src", "to", { toNode: "L" }),
        lit("", "q", "e"),
      ],
      SCOPE,
    );
    const [first, second, third] = minted;
    expect((await dial.edges(first ?? "")).map((e) => e.predicate)).toEqual([
      "p",
    ]);
    expect(await dial.edges(second ?? "")).toStrictEqual([]);
    expect(await dial.edges(third ?? "")).toStrictEqual([]);
    expect((await dial.edges("src"))[0]?.value).toBe(first);
    // an empty label names nothing: that edge stays on the literal "" subject
    expect((await dial.edges("")).map((e) => e.predicate)).toEqual(["q"]);
  });

  it("blob, node and literal targets land in their own domains", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        opAdd("s", "blob", { toBlob: "5" }),
        { ...opAdd("s", "null-blob", { toLiteral: "x" }), to_blob: null },
        opAdd("s", "node", { toNode: "N" }),
        lit("s", "lit", "v"),
      ],
      SCOPE,
    );
    expect(await dial.edges("s")).toStrictEqual([
      { predicate: "blob", value: "5", isNode: false, domain: "blob" },
      { predicate: "null-blob", value: "x", isNode: false, domain: "scalar" },
      { predicate: "node", value: "N", isNode: true, domain: "node" },
      { predicate: "lit", value: "v", isNode: false, domain: "scalar" },
    ]);
  });

  it("an op that is neither add nor remove changes nothing", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit([lit("s", "p", "a")], SCOPE);
    await dial.admit(
      [{ op: "noop", from_id: "s", predicate: "p", to_literal: "a" }],
      SCOPE,
    );
    expect((await dial.edges("s")).map((e) => e.value)).toEqual(["a"]);
  });
});

describe("FixtureChaosDial — typed literals", () => {
  it("an instant reads back Eastern, a wallclock canonical", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        opAdd("s", "mtime", { toLiteral: Z, dtype: "instant" }),
        opAdd("s", "ctime", {
          toLiteral: "2026-10-17T18:11:45.5",
          dtype: "wallclock",
        }),
      ],
      SCOPE,
    );
    expect((await dial.edges("s")).map((e) => e.value)).toEqual([
      rendered(Z),
      "2026-10-17T18:11:45.500000",
    ]);
  });

  it("a dtype on a node or blob edge is not a literal to normalise", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        opAdd("s", "n", { toNode: "N", dtype: "instant" }),
        opAdd("s", "b", { toBlob: "5", dtype: "instant" }),
        lit("s", "plain", "free text"),
      ],
      SCOPE,
    );
    expect((await dial.edges("s")).map((e) => e.value)).toEqual([
      "N",
      "5",
      "free text",
    ]);
  });

  it.each([
    ["nope", "instant"],
    ["2026-10-17T18:11:45", "instant"],
    [Z, "wallclock"],
    ["2026-10-17T18:11:45", "bogus"],
  ])("%j as %s is refused with a bad_result", (value, dtype) => {
    const dial = new FixtureChaosDial();
    let err: unknown;
    try {
      void dial.admit([opAdd("s", "p", { toLiteral: value, dtype })], SCOPE);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("bad_result");
    expect((err as ChaosClientError).message).toBe(
      `fixture: ${JSON.stringify(value)} is not a valid ${dtype} literal`,
    );
  });
});

describe("FixtureChaosDial — retraction", () => {
  it("an untyped retract takes only the fact of that text", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit([lit("s", "p", "a"), lit("s", "p", "b")], SCOPE);
    await dial.admit([opRemove("s", "p", { toLiteral: "a" })], SCOPE);
    expect((await dial.edges("s")).map((e) => e.value)).toEqual(["b"]);
  });

  it("an untyped retract leaves a typed fact that merely reads the same", async () => {
    const dial = new FixtureChaosDial();
    const text = rendered(Z);
    await dial.admit(
      [
        opAdd("s", "t", { toLiteral: Z, dtype: "instant" }),
        lit("s", "t", text),
      ],
      SCOPE,
    );
    await dial.admit([opRemove("s", "t", { toLiteral: text })], SCOPE);
    const left = await dial.edges("s");
    expect(left).toHaveLength(1);
    expect(left[0]?.value).toBe(text);
    // the survivor is the typed one: a typed retract now removes it
    await dial.admit(
      [opRemove("s", "t", { toLiteral: Z, dtype: "instant" })],
      SCOPE,
    );
    expect(await dial.edges("s")).toStrictEqual([]);
  });

  it("a typed retract skips an untyped fact and a typed fact of another value", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        lit("s", "t", "plain"),
        opAdd("s", "t", { toLiteral: Z, dtype: "instant" }),
        opAdd("s", "t", { toLiteral: Z2, dtype: "instant" }),
      ],
      SCOPE,
    );
    await dial.admit(
      [opRemove("s", "t", { toLiteral: Z, dtype: "instant" })],
      SCOPE,
    );
    expect((await dial.edges("s")).map((e) => e.value)).toEqual([
      "plain",
      rendered(Z2),
    ]);
  });

  it("a typed retract of another dtype hits nothing", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        opAdd("s", "t", {
          toLiteral: "2026-10-17T18:11:45",
          dtype: "wallclock",
        }),
      ],
      SCOPE,
    );
    await dial.admit(
      [opRemove("s", "t", { toLiteral: Z, dtype: "instant" })],
      SCOPE,
    );
    expect(await dial.edges("s")).toHaveLength(1);
  });

  it("a blob edge retracts by its id and the log records the removal", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit([opAdd("s", "b", { toBlob: "5" })], SCOPE);
    await dial.admit([opRemove("s", "b", { toBlob: "5" })], SCOPE);
    expect(await dial.edges("s")).toStrictEqual([]);
    expect(dial.factLog.at(-1)).toMatchObject({
      tx: 2,
      s: "s",
      predicate: "b",
      value: "5",
      domain: "blob",
      added: false,
    });
  });

  it("a node edge retracts by its target", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit([opAdd("s", "n", { toNode: "N" })], SCOPE);
    await dial.admit([opRemove("s", "n", { toNode: "N" })], SCOPE);
    expect(await dial.edges("s")).toStrictEqual([]);
  });

  it("retracting from a node with no edges leaves it with none", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit([opRemove("ghost", "p", { toLiteral: "a" })], SCOPE);
    expect(await dial.edges("ghost")).toStrictEqual([]);
    expect(dial.factLog).toStrictEqual([]);
  });
});

describe("FixtureChaosDial — ref resolution", () => {
  const HEX = "ab".repeat(32);

  async function seeded(): Promise<{ dial: FixtureChaosDial; token: string }> {
    const dial = new FixtureChaosDial();
    const { minted } = await dial.admit([opCreate("Note", "Hello")], SCOPE);
    return { dial, token: minted[0] ?? "" };
  }

  it("a token resolves to its dictionary row", async () => {
    const { dial, token } = await seeded();
    expect(await dial.resolveNodeRefs([token])).toStrictEqual({
      [token]: { ref: token, label: "Hello", kind: "Note" },
    });
  });

  it("a seeded node resolves with its kind and label", async () => {
    const dial = new FixtureChaosDial();
    dial.seed("Note", "Seeded", HEX);
    expect(await dial.resolveNodeRefs([HEX])).toStrictEqual({
      [HEX]: { ref: HEX, label: "Seeded", kind: "Note" },
    });
    expect(await dial.resolveNodes([HEX])).toStrictEqual({ [HEX]: "Seeded" });
    expect(await dial.resolveRefsEcho([HEX])).toStrictEqual({
      refs: [{ ref: HEX, label: "Seeded", kind: "Note" }],
      missing: [],
    });
  });

  it("an unknown hex token is omitted; an unknown address refuses the call", async () => {
    const { dial } = await seeded();
    expect(await dial.resolveNodeRefs([HEX])).toStrictEqual({});
    await expect(dial.resolveNodeRefs(["nope"])).rejects.toMatchObject({
      message: "resolve_node_refs: bad_args: nope resolves to no live node",
      code: "wire_error",
    });
    // an address that merely CONTAINS 64 hex characters is still an address
    await expect(dial.resolveNodeRefs([`q-${HEX}`])).rejects.toBeInstanceOf(
      ChaosClientError,
    );
    await expect(dial.resolveNodeRefs([`${HEX}-x`])).rejects.toBeInstanceOf(
      ChaosClientError,
    );
  });

  it("styx addresses resolve with or without the scheme, even around hex", async () => {
    const { dial, token } = await seeded();
    dial.assignStyx(token, `q-${HEX}`);
    expect(Object.keys(await dial.resolveNodeRefs([`q-${HEX}`]))).toEqual([
      token,
    ]);
    expect(
      Object.keys(await dial.resolveNodeRefs([`styx://q-${HEX}`])),
    ).toEqual([token]);
    const second = await dial.admit([opCreate("Note", "Two")], SCOPE);
    const t2 = second.minted[0] ?? "";
    dial.assignStyx(t2, `${HEX}-x`);
    expect(Object.keys(await dial.resolveNodeRefs([`${HEX}-x`]))).toEqual([t2]);
  });

  it("two refs naming one node answer the first ref sent", async () => {
    const { dial, token } = await seeded();
    dial.assignStyx(token, "abc");
    expect((await dial.resolveNodeRefs(["abc", token]))[token]?.ref).toBe(
      "abc",
    );
    expect((await dial.resolveNodeRefs([token, "abc"]))[token]?.ref).toBe(
      token,
    );
  });
});

describe("FixtureChaosDial — as-of reads, scalars, blobs", () => {
  it("quadsFrom answers wire-form rows, filtered by predicate and tx", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        lit("s", "name", "v"),
        opAdd("s", "kid", { toNode: "N" }),
        opAdd("s", "file", { toBlob: "7" }),
      ],
      SCOPE,
    );
    await dial.admit([lit("s", "late", "z")], SCOPE);
    const all = await dial.quadsFrom(["s"], null, null);
    expect(all).toStrictEqual([
      { s: "s", p: scopeHash("name"), o: scopeHash("v"), g: "00" },
      { s: "s", p: scopeHash("kid"), o: "N", g: "00" },
      { s: "s", p: scopeHash("file"), o: "blob:7", g: "00" },
      { s: "s", p: scopeHash("late"), o: scopeHash("z"), g: "00" },
    ]);
    expect((await dial.quadsFrom(["s"], 1, null)).map((r) => r.p)).toEqual([
      scopeHash("name"),
      scopeHash("kid"),
      scopeHash("file"),
    ]);
    expect(
      (await dial.quadsFrom(["s"], null, ["kid", "late"])).map((r) => r.o),
    ).toEqual(["N", scopeHash("z")]);
    expect(await dial.quadsFrom(["other"], null, null)).toStrictEqual([]);
    expect(await dial.quadsFrom(["s"], null, [])).toStrictEqual([]);
  });

  it("resolveScalars inverts only the requested scalar hashes", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        lit("s", "p", "val"),
        lit("s", "p", "other"),
        opAdd("s", "kid", { toNode: "N" }),
      ],
      SCOPE,
    );
    expect(
      await dial.resolveScalars([scopeHash("val"), scopeHash("N"), "none"]),
    ).toStrictEqual({ [scopeHash("val")]: "val" });
  });

  it("heldBlobs lists ids in numeric order", async () => {
    const dial = new FixtureChaosDial();
    await dial.admit(
      [
        opAdd("s", "b", { toBlob: "10" }),
        opAdd("s", "b", { toBlob: "9" }),
        opAdd("s", "b", { toBlob: "100" }),
        lit("s", "p", "5"),
      ],
      SCOPE,
    );
    expect(await dial.heldBlobs()).toStrictEqual(["9", "10", "100"]);
  });

  it("a failing census refuses as a wire error", async () => {
    const dial = new FixtureChaosDial();
    dial.failHeldBlobs = true;
    const err = await dial.heldBlobs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).message).toBe(
      "held_blobs: fixture refuses",
    );
    expect((err as ChaosClientError).code).toBe("wire_error");
  });
});

describe("FixtureChaosDial — history closure", () => {
  it("follows added node edges from members, once, in log order", async () => {
    const dial = new FixtureChaosDial();
    const tx = (op: ChaosOp) => dial.admit([op], SCOPE);
    await tx(opAdd("A", "child", { toNode: "B" })); //  1 A -> B
    await tx(lit("B", "name", "b")); //                 2 B in closure
    await tx(opAdd("A", "other", { toNode: "C" })); //  3 not a follow predicate
    await tx(lit("C", "name", "c")); //                 4 C is not in
    await tx(opAdd("D", "child", { toNode: "E" })); //  5 D is not a member
    await tx(lit("E", "name", "e")); //                 6 E is not in
    await tx(lit("A", "child", "F")); //                7 scalar: not followed
    await tx(lit("F", "name", "f")); //                 8 F is not in
    await tx(opAdd("X", "child", { toNode: "Y" })); //  9 X not yet a member
    await tx(opAdd("A", "child", { toNode: "X" })); // 10 X joins
    await tx(opRemove("X", "child", { toNode: "Y" })); // 11 a removal follows nothing
    await tx(lit("Y", "name", "y")); //                12 Y is not in
    const out = await dial.history(["A"], ["child"]);
    expect(out.map((h) => h.tx)).toEqual([1, 2, 3, 7, 9, 10, 11]);
    expect(out[0]).toStrictEqual({
      tx: 1,
      at: null,
      author: FixtureChaosDial.AUTHOR,
      note: "",
    });
  });
});
