import { describe, expect, it } from "vitest";
import { FixtureChaosDial, opAdd } from "../src/chaos-client.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";
import { FixtureTagStore } from "../src/tag-store.js";
import {
  FRONTMATTER,
  RESERVED_PREDICATES,
  frontmatterOf,
  isSetPropertiesError,
  setProperties,
  withFrontmatter,
  type SetPropertiesResult,
} from "../src/properties.js";

const SCOPE = "notes";

async function note(
  dial: FixtureChaosDial,
  store: FixtureTagStore | undefined,
  title: string,
): Promise<string> {
  const r = await createNote(dial, SCOPE, { title }, store);
  if (isCreateNoteError(r)) throw new Error(r.detail);
  return r.node_id;
}

function ok(r: Awaited<ReturnType<typeof setProperties>>): SetPropertiesResult {
  if (isSetPropertiesError(r)) throw new Error(`${r.code}: ${r.detail}`);
  return r;
}

async function valuesOf(
  dial: FixtureChaosDial,
  id: string,
  predicate: string,
): Promise<string[]> {
  return (await dial.edges(id))
    .filter((e) => e.predicate === predicate)
    .map((e) => e.value)
    .sort();
}

describe("set_properties — frontmatter as edges", () => {
  it("asserts literals, node edges, the source YAML and tags in one call", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "Brain Soup/A");
    const target = await note(dial, store, "Brain Soup/Target");
    const before = dial.admits.length;
    const r = ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        properties: [
          { predicate: "status", values: [{ literal: "seed" }] },
          { predicate: "childOf", values: [{ node: target }] },
        ],
        tags: ["Interest/Health"],
        frontmatter: 'status: seed\nup: "[[Target]]"',
      }),
    );
    expect(r.node_id).toBe(id);
    expect(r.added.sort()).toEqual(
      [
        "status=seed",
        `childOf=${target}`,
        'frontmatter=status: seed\nup: "[[Target]]"',
      ].sort(),
    );
    expect(r.removed).toEqual([]);
    expect(r.tags_added).toEqual(["#interest/health"]);
    expect(r.tags_skipped).toEqual([]);
    expect(r.tx).toBeTypeOf("number");
    // one property batch + one tag batch
    expect(dial.admits.length - before).toBe(2);
    expect(dial.admits[before]?.scope).toBe(SCOPE);
    const childOf = (await dial.edges(id)).find(
      (e) => e.predicate === "childOf",
    );
    expect(childOf?.isNode).toBe(true);
    expect(childOf?.value).toBe(target);
    expect(await store.byNode(id)).toEqual([
      { tag: "#interest/health", source: "explicit" },
    ]);
  });

  it("is idempotent: a re-run is reads only", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    const input = {
      container_id: id,
      properties: [
        { predicate: "status", values: [{ literal: "seed" }] },
        { predicate: "atoms", values: [{ literal: "a" }, { literal: "b" }] },
      ],
      tags: ["x"],
      frontmatter: "status: seed",
    };
    ok(await setProperties(dial, SCOPE, store, input));
    const before = dial.admits.length;
    const again = ok(await setProperties(dial, SCOPE, store, input));
    expect(dial.admits.length).toBe(before);
    expect(again.added).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.tags_added).toEqual([]);
    expect(again.tx).toBeUndefined();
    expect("tx" in again).toBe(false);
  });

  it("replaces a named predicate's value set; unnamed predicates stay", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [
          { predicate: "status", values: [{ literal: "seed" }] },
          { predicate: "keep", values: [{ literal: "me" }] },
          { predicate: "atoms", values: [{ literal: "a" }, { literal: "b" }] },
        ],
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [
          { predicate: "status", values: [{ literal: "grown" }] },
          { predicate: "atoms", values: [{ literal: "b" }, { literal: "c" }] },
        ],
      }),
    );
    expect(r.added.sort()).toEqual(["atoms=c", "status=grown"]);
    expect(r.removed.sort()).toEqual(["atoms=a", "status=seed"]);
    expect(await valuesOf(dial, id, "status")).toEqual(["grown"]);
    expect(await valuesOf(dial, id, "atoms")).toEqual(["b", "c"]);
    expect(await valuesOf(dial, id, "keep")).toEqual(["me"]);
  });

  it("a literal never equals a node edge with the same spelling", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const target = await note(dial, undefined, "T");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "up", values: [{ literal: target }] }],
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "up", values: [{ node: target }] }],
      }),
    );
    expect(r.added).toEqual([`up=${target}`]);
    expect(r.removed).toEqual([`up=${target}`]);
    const ups = (await dial.edges(id)).filter((e) => e.predicate === "up");
    expect(ups.map((e) => e.isNode)).toEqual([true]);
  });

  it("an upgraded unresolved link swaps its literal for the node edge", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const target = await note(dial, undefined, "T");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ literal: "[[T]]" }] }],
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: target }] }],
      }),
    );
    expect(r.removed).toEqual(["childOf=[[T]]"]);
    expect(await valuesOf(dial, id, "childOf")).toEqual([target]);
  });

  it("removes a node edge the new set drops", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const a = await note(dial, undefined, "A");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: a }] }],
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ literal: "[[A]]" }] }],
      }),
    );
    expect(r.removed).toEqual([`childOf=${a}`]);
    const left = (await dial.edges(id)).filter(
      (e) => e.predicate === "childOf",
    );
    expect(left).toHaveLength(1);
    expect(left[0]?.isNode).toBe(false);
  });

  it("merges two entries for one predicate into one value set", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [
          { predicate: "p", values: [{ literal: "1" }] },
          { predicate: "p", values: [{ literal: "2" }] },
        ],
      }),
    );
    expect(await valuesOf(dial, id, "p")).toEqual(["1", "2"]);
  });

  it("frontmatter replaces the standing YAML literal", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        frontmatter: "a: 1",
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        frontmatter: "a: 2",
      }),
    );
    expect(r.removed).toEqual(["frontmatter=a: 1"]);
    expect(frontmatterOf(await dial.edges(id))).toBe("a: 2");
  });

  it("retract removes exactly the named values and explicit tags", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    const t = await note(dial, store, "T");
    ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        properties: [
          { predicate: "status", values: [{ literal: "seed" }] },
          { predicate: "childOf", values: [{ node: t }] },
          { predicate: "keep", values: [{ literal: "me" }] },
        ],
        tags: ["a", "b"],
        frontmatter: "y: 1",
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        properties: [
          {
            predicate: "status",
            values: [{ literal: "seed" }, { literal: "absent" }],
          },
          { predicate: "childOf", values: [{ node: t }] },
        ],
        tags: ["a", "#never"],
        frontmatter: "y: 1",
        retract: true,
      }),
    );
    expect(r.added).toEqual([]);
    expect(r.removed.sort()).toEqual(
      ["status=seed", `childOf=${t}`, "frontmatter=y: 1"].sort(),
    );
    expect(r.tags_removed).toEqual(["#a"]);
    expect(r.tags_added).toEqual([]);
    expect(await valuesOf(dial, id, "status")).toEqual([]);
    expect(await valuesOf(dial, id, "childOf")).toEqual([]);
    expect(await valuesOf(dial, id, "keep")).toEqual(["me"]);
    expect(await valuesOf(dial, id, "hasTag")).toEqual(["#b"]);
    expect(await store.byNode(id)).toEqual([{ tag: "#b", source: "explicit" }]);
  });

  it("retract never takes an inline (body-sourced) tag", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    await store.upsert(id, "#inline", "inline");
    const before = dial.admits.length;
    const r = ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["inline"],
        retract: true,
      }),
    );
    expect(r.tags_removed).toEqual([]);
    expect(dial.admits.length).toBe(before);
    expect(await store.byNode(id)).toEqual([
      { tag: "#inline", source: "inline" },
    ]);
  });

  it("a refused tag retraction throws (the gate's answer is never swallowed)", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["a"],
      }),
    );
    dial.refuseWith = [{ reason: "no" }];
    await expect(
      setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["a"],
        retract: true,
      }),
    ).rejects.toThrow(/refused the tag retraction/);
  });

  it("retract skips the target check (a since-deleted target still retracts)", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const ghost = "ab".repeat(32);
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: ghost }] }],
        retract: true,
      }),
    );
    expect(r.removed).toEqual([]);
  });

  it("skips junk tags and blank tags, reporting the junk", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    const r = ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["#fff", "real", "  ", "#FFF"],
      }),
    );
    expect(r.tags_added).toEqual(["#real"]);
    expect(r.tags_skipped).toEqual(["#fff"]);
  });

  it("without a tag store, tags are not written", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const r = ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        tags: ["a"],
      }),
    );
    expect(r.tags_added).toEqual([]);
    expect(await valuesOf(dial, id, "hasTag")).toEqual([]);
  });

  it("refuses a node that is not a Note", async () => {
    const dial = new FixtureChaosDial();
    const r = await setProperties(dial, SCOPE, undefined, {
      container_id: "cd".repeat(32),
      properties: [{ predicate: "p", values: [{ literal: "v" }] }],
    });
    expect(isSetPropertiesError(r) && r.code).toBe("not_a_note");
    expect(dial.admits).toHaveLength(0);
  });

  it("refuses reserved, blank and padded predicates before any read", async () => {
    const dial = new FixtureChaosDial();
    for (const predicate of [
      "hasName",
      "frontmatter",
      "title",
      "",
      " p",
      "p ",
    ]) {
      const r = await setProperties(dial, SCOPE, undefined, {
        container_id: "cd".repeat(32),
        properties: [{ predicate, values: [{ literal: "v" }] }],
      });
      expect(isSetPropertiesError(r) && r.code).toBe("bad_args");
    }
    expect(RESERVED_PREDICATES.has(FRONTMATTER)).toBe(true);
    expect(RESERVED_PREDICATES.has("hasTag")).toBe(true);
    expect(RESERVED_PREDICATES.has("status")).toBe(false);
  });

  it("refuses an empty literal and a malformed node token", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const empty = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "p", values: [{ literal: "" }] }],
    });
    expect(isSetPropertiesError(empty) && empty.code).toBe("bad_args");
    const malformed = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "p", values: [{ node: "nothex" }] }],
    });
    expect(isSetPropertiesError(malformed) && malformed.code).toBe("bad_args");
  });

  it("refuses a node target missing from the dictionary", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const before = dial.admits.length;
    const r = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [
        { predicate: "childOf", values: [{ node: "ef".repeat(32) }] },
      ],
    });
    expect(isSetPropertiesError(r) && r.code).toBe("bad_args");
    expect(isSetPropertiesError(r) && r.detail).toContain("ef".repeat(32));
    expect(dial.admits.length).toBe(before);
  });

  it("surfaces a refused property batch as admit_refused", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    dial.refuseWith = [{ reason: "shape" }];
    const r = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "p", values: [{ literal: "v" }] }],
    });
    expect(isSetPropertiesError(r) && r.code).toBe("admit_refused");
    expect(isSetPropertiesError(r) && r.violations).toEqual([
      { reason: "shape" },
    ]);
  });
});

describe("the frontmatter round trip", () => {
  it("frontmatterOf reads the literal and ignores a node edge", () => {
    expect(frontmatterOf([])).toBeNull();
    expect(
      frontmatterOf([
        { predicate: FRONTMATTER, value: "x", isNode: true, domain: "node" },
      ]),
    ).toBeNull();
    expect(
      frontmatterOf([
        { predicate: "other", value: "z", isNode: false, domain: "scalar" },
        {
          predicate: FRONTMATTER,
          value: "a: 1",
          isNode: false,
          domain: "scalar",
        },
      ]),
    ).toBe("a: 1");
  });

  it("withFrontmatter prepends the fence once", () => {
    expect(withFrontmatter("# T", null)).toBe("# T");
    expect(withFrontmatter("# T", "a: 1")).toBe("---\na: 1\n---\n\n# T");
    expect(withFrontmatter("", "a: 1")).toBe("---\na: 1\n---");
    expect(withFrontmatter("---\nb: 2\n---\n\n# T", "a: 1")).toBe(
      "---\nb: 2\n---\n\n# T",
    );
    expect(withFrontmatter("---", "a: 1")).toBe("---");
  });
});

// ── the verb over the MCP surface ───────────────────────────────────────────

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";

async function rig(): Promise<Client> {
  const dial = new FixtureChaosDial();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: SCOPE },
    containers: { blobs: new FixtureBlobStore(), dial },
    tags: new FixtureTagStore(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

describe("set_properties over MCP, and the round trip through export", () => {
  it("lands properties; export and materialize serve the YAML back", async () => {
    const mcp = await rig();
    const dissolved = await mcp.callTool({
      name: "dissolve_note",
      arguments: {
        source_path: "Brain Soup/Idea.md",
        blocks: [{ text: "# Idea" }, { text: "body" }],
      },
    });
    const { node_id } = dissolved.structuredContent as { node_id: string };

    const set = await mcp.callTool({
      name: "set_properties",
      arguments: {
        container_id: node_id,
        properties: [{ predicate: "status", values: [{ literal: "seed" }] }],
        tags: ["idea"],
        frontmatter: "status: seed\ntags:\n  - idea",
      },
    });
    expect(set.isError).toBeFalsy();
    expect(set.content).toEqual([
      { type: "text", text: "+2 -0 edge(s), +1 -0 tag(s)." },
    ]);
    const result = set.structuredContent as SetPropertiesResult;
    expect(result.tags_added).toEqual(["#idea"]);

    const exported = await mcp.callTool({
      name: "export_note",
      arguments: { container_id: node_id },
    });
    expect((exported.structuredContent as { markdown: string }).markdown).toBe(
      "---\nstatus: seed\ntags:\n  - idea\n---\n\n# Idea\n\nbody",
    );

    const mat = await mcp.callTool({
      name: "materialize_note",
      arguments: { container_id: node_id },
    });
    expect(
      (mat.structuredContent as { frontmatter?: string }).frontmatter,
    ).toBe("status: seed\ntags:\n  - idea");
  });

  it("materialize omits frontmatter when the note has none", async () => {
    const mcp = await rig();
    const dissolved = await mcp.callTool({
      name: "dissolve_note",
      arguments: { source_path: "n.md", blocks: [{ text: "a" }] },
    });
    const { node_id } = dissolved.structuredContent as { node_id: string };
    const mat = await mcp.callTool({
      name: "materialize_note",
      arguments: { container_id: node_id },
    });
    expect("frontmatter" in (mat.structuredContent as object)).toBe(false);
  });

  it("answers a refusal as a structured error", async () => {
    const mcp = await rig();
    const r = await mcp.callTool({
      name: "set_properties",
      arguments: {
        container_id: "cd".repeat(32),
        properties: [{ predicate: "p", values: [{ literal: "v" }] }],
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      {
        type: "text",
        text: `not_a_note: ${"cd".repeat(32)} carries no hasType=Note edge`,
      },
    ]);
    expect((r.structuredContent as { code: string }).code).toBe("not_a_note");
  });
});

// ── the pins the mutation lane asked for ────────────────────────────────────

describe("set_properties — exact refusals and quiet paths", () => {
  it("names the refusal in its detail", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const detail = async (input: Parameters<typeof setProperties>[3]) => {
      const r = await setProperties(dial, SCOPE, undefined, input);
      return isSetPropertiesError(r) ? r.detail : "";
    };
    expect(
      await detail({
        container_id: id,
        properties: [{ predicate: " p", values: [{ literal: "v" }] }],
      }),
    ).toBe('predicate " p" must be non-empty and untrimmed');
    expect(
      await detail({
        container_id: id,
        properties: [{ predicate: "title", values: [{ literal: "v" }] }],
      }),
    ).toBe("title is reserved — another writer owns it");
    expect(
      await detail({
        container_id: id,
        properties: [{ predicate: "p", values: [{ node: "nothex" }] }],
      }),
    ).toBe("p: nothex is not a 64-hex node token");
    expect(
      await detail({
        container_id: id,
        properties: [{ predicate: "p", values: [{ literal: "" }] }],
      }),
    ).toBe("p: empty literal");
    dial.refuseWith = [{ reason: "x" }];
    expect(
      await detail({
        container_id: id,
        properties: [{ predicate: "p", values: [{ literal: "v" }] }],
      }),
    ).toBe(`the gate refused the property batch for ${id}`);
  });

  it("a node typed as something other than Note is refused", async () => {
    const dial = new FixtureChaosDial();
    const id = "ab".repeat(32);
    await dial.admit(
      [
        opAdd(id, "hasType", { toLiteral: "Work" }),
        opAdd(id, "title", { toLiteral: "Note" }),
      ],
      SCOPE,
    );
    const r = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "p", values: [{ literal: "v" }] }],
    });
    expect(isSetPropertiesError(r) && r.code).toBe("not_a_note");
  });

  it("asks the dictionary only when a node value is set", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const t = await note(dial, undefined, "T");
    const asked: string[][] = [];
    const real = dial.resolveNodes.bind(dial);
    dial.resolveNodes = (tokens: string[]) => {
      asked.push(tokens);
      return real(tokens);
    };
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "p", values: [{ literal: "v" }] }],
      }),
    );
    expect(asked).toEqual([]);
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [
          { predicate: "childOf", values: [{ node: t }, { node: t }] },
        ],
      }),
    );
    expect(asked).toEqual([[t]]);
  });

  it("a retraction removes a node edge AS a node edge", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const t = await note(dial, undefined, "T");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: t }] }],
      }),
    );
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: t }] }],
        retract: true,
      }),
    );
    const last = dial.admits[dial.admits.length - 1];
    expect(last?.ops).toEqual([
      expect.objectContaining({
        op: "removeEdge",
        predicate: "childOf",
        to_node: t,
        to_literal: null,
      }),
    ]);
  });

  it("asserts and replaces with the right domain on the wire", async () => {
    const dial = new FixtureChaosDial();
    const id = await note(dial, undefined, "N");
    const t = await note(dial, undefined, "T");
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ node: t }] }],
      }),
    );
    expect(dial.admits[dial.admits.length - 1]?.ops).toEqual([
      expect.objectContaining({ op: "addEdge", to_node: t, to_literal: null }),
    ]);
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ literal: "x" }] }],
      }),
    );
    expect(dial.admits[dial.admits.length - 1]?.ops).toEqual([
      expect.objectContaining({
        op: "removeEdge",
        to_node: t,
        to_literal: null,
      }),
      expect.objectContaining({
        op: "addEdge",
        to_node: null,
        to_literal: "x",
      }),
    ]);
    ok(
      await setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "childOf", values: [{ literal: "x" }] }],
        retract: true,
      }),
    );
    expect(dial.admits[dial.admits.length - 1]?.ops).toEqual([
      expect.objectContaining({
        op: "removeEdge",
        to_node: null,
        to_literal: "x",
      }),
    ]);
  });

  it("no tags means no tag-store read at all", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    let reads = 0;
    const real = store.byNode.bind(store);
    store.byNode = (nodeId: string) => {
      reads += 1;
      return real(nodeId);
    };
    for (const tags of [undefined, [], ["  "]]) {
      const r = ok(
        await setProperties(dial, SCOPE, store, {
          container_id: id,
          ...(tags !== undefined ? { tags } : {}),
        }),
      );
      expect(r.tags_added).toEqual([]);
    }
    expect(reads).toBe(0);
    expect(await real(id)).toEqual([]);
  });

  it("reports retracted and skipped tags sorted and distinct", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["b", "a"],
      }),
    );
    const r = ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["b", "a", "b", "#fff", "#abc", "#fff"],
        retract: true,
      }),
    );
    expect(r.tags_removed).toEqual(["#a", "#b"]);
    expect(r.tags_skipped).toEqual(["#abc", "#fff"]);
  });

  it("a refused tag retraction carries the admit_refused code", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const id = await note(dial, store, "N");
    ok(
      await setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["a"],
      }),
    );
    dial.refuseWith = [{ reason: "no" }];
    await expect(
      setProperties(dial, SCOPE, store, {
        container_id: id,
        tags: ["a"],
        retract: true,
      }),
    ).rejects.toMatchObject({
      code: "admit_refused",
      violations: [{ reason: "no" }],
    });
  });
});

describe("set_properties' published surface", () => {
  it("carries its title, description, annotations and schema", async () => {
    const mcp = await rig();
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "set_properties");
    expect(tool?.title).toBe("Set a note's properties (frontmatter as edges)");
    expect(tool?.description).toBe(
      "Land a note's frontmatter on the graph: each named predicate's " +
        "values become exactly the given set (literals, or node tokens for " +
        "resolved wikilinks); unnamed predicates are untouched. tags[] " +
        "ride the C9 explicit tag path; frontmatter is the source YAML, " +
        "kept verbatim as one literal so export_note can reproduce it. " +
        "retract:true removes exactly the named values (the revert form). " +
        "Idempotent — a re-run is a read. Returns {node_id, added, " +
        "removed, tags_added, tags_removed, tags_skipped, tx?}; refusals " +
        "are not_a_note / bad_args / admit_refused.",
    );
    const props = tool?.inputSchema.properties as Record<
      string,
      { description?: string; pattern?: string }
    >;
    expect(props.container_id?.pattern).toBe("^[0-9a-f]{64}$");
    expect(props.container_id?.description).toBe("The note's node token.");
    expect(props.properties?.description).toBe(
      "predicate → values; a node value is a 64-hex token.",
    );
    expect(props.tags?.description).toBe("Explicit tags.");
    expect(props.frontmatter?.description).toBe(
      "The source YAML (between the fences), verbatim.",
    );
    expect(props.retract?.description).toBe(
      "Remove exactly the named values instead of setting.",
    );
    expect(tool?.inputSchema.required).toEqual(["container_id"]);
  });

  it("refuses a malformed container token and an empty predicate at the schema", async () => {
    const mcp = await rig();
    for (const args of [
      { container_id: "XY".repeat(32) },
      { container_id: `${"a".repeat(64)}0` },
      { container_id: `0${"a".repeat(64)}` },
      {
        container_id: "a".repeat(64),
        properties: [{ predicate: "", values: [] }],
      },
      {
        container_id: "a".repeat(64),
        properties: [{ predicate: "p", values: [{ node: "x", extra: 1 }] }],
      },
    ]) {
      const refused = await mcp
        .callTool({ name: "set_properties", arguments: args })
        .then(
          (r) =>
            r.isError === true &&
            !JSON.stringify(r.content).includes("not_a_note"),
          () => true,
        );
      expect(refused).toBe(true);
    }
  });

  it("takes a node value through the wire", async () => {
    const mcp = await rig();
    const mk = async (path: string) =>
      (
        (
          await mcp.callTool({
            name: "dissolve_note",
            arguments: { source_path: path, blocks: [{ text: "x" }] },
          })
        ).structuredContent as { node_id: string }
      ).node_id;
    const a = await mk("a.md");
    const b = await mk("b.md");
    const r = await mcp.callTool({
      name: "set_properties",
      arguments: {
        container_id: a,
        properties: [{ predicate: "childOf", values: [{ node: b }] }],
      },
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as SetPropertiesResult).added).toEqual([
      `childOf=${b}`,
    ]);
  });
});
