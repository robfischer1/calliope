import { describe, expect, it } from "vitest";
import { FixtureChaosDial } from "../src/chaos-client.js";
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
  if (isSetPropertiesError(r)) throw new Error(`${r.error}: ${r.detail}`);
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
    expect(isSetPropertiesError(r) && r.error).toBe("not_a_note");
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
      expect(isSetPropertiesError(r) && r.error).toBe("bad_predicate");
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
    expect(isSetPropertiesError(empty) && empty.error).toBe("bad_value");
    const malformed = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "p", values: [{ node: "nothex" }] }],
    });
    expect(isSetPropertiesError(malformed) && malformed.error).toBe(
      "bad_target",
    );
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
    expect(isSetPropertiesError(r) && r.error).toBe("bad_target");
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
    expect(isSetPropertiesError(r) && r.error).toBe("admit_refused");
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
    expect((r.structuredContent as { error: string }).error).toBe("not_a_note");
  });
});
