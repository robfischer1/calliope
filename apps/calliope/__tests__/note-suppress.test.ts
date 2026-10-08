/**
 * delete_note's default mode (suppress) and restore_note.
 *
 * Synthetic data only: a FixtureChaosDial, a FixtureBlobStore, a
 * FixtureTagStore, a canned search provider and a FocusRegister behind the
 * real MCP server. Pins: suppress hides the note from every listing
 * (list_by_tag, list_tags counts, search, look) and leaves read_container
 * by its own id answering; restore brings it back with its edges exactly
 * as they were; both are idempotent; purge still retracts, a suppressed
 * note included; dry runs write nothing; the protection rule refuses in
 * both modes.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  type ChaosDial,
  FixtureChaosDial,
  opAdd,
  opCreate,
  opRemove,
  scopeHash,
} from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FocusRegister } from "../src/focus-register.js";
import { createServer } from "../src/mcp/server.js";
import { createNote } from "../src/mcp/tools.js";
import {
  restoreNotes,
  SUPPRESSED,
  SUPPRESSED_VALUE,
  suppressedNotes,
  suppressNotes,
  visible,
} from "../src/note-suppress.js";
import type { SearchProvider } from "../src/search-types.js";
import { FixtureTagStore } from "../src/tag-store.js";
import type { BodyPointer } from "../src/types.js";

const SCOPE = "notes";

interface Rig {
  mcp: Client;
  dial: FixtureChaosDial;
  tags: FixtureTagStore;
  focus: FocusRegister;
  /** The ids the canned search provider answers, in order. */
  searchIds: string[];
}

async function rig(): Promise<Rig> {
  const dial = new FixtureChaosDial();
  const tags = new FixtureTagStore();
  const focus = new FocusRegister();
  const searchIds: string[] = [];
  const search: SearchProvider = {
    search: () =>
      Promise.resolve({
        hits: searchIds.map((id) => ({
          id,
          snippet: "s",
          score: 1,
          arms: ["eros" as const],
        })),
        armsQueried: ["eros"],
        armsDark: [],
      }),
  };
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: SCOPE },
    containers: { blobs: new FixtureBlobStore(), dial },
    tags,
    focus,
    search,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, dial, tags, focus, searchIds };
}

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  isError: boolean;
  text: string;
  out: Record<string, unknown> & {
    notes?: { node_id: string; status: string }[];
    totals?: Record<string, number>;
  };
}> {
  const res = await mcp.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: (res.content as { text: string }[]).map((c) => c.text).join(""),
    out: res.structuredContent as Record<string, unknown>,
  };
}

async function note(
  mcp: Client,
  title: string,
  extra: { tags?: string[]; parent?: string } = {},
): Promise<string> {
  const res = await call(mcp, "create_note", { title, ...extra });
  expect(res.isError).toBe(false);
  return (res.out as { node_id: string }).node_id;
}

const suppress = (mcp: Client, ids: string[], dryRun = false) =>
  call(mcp, "delete_note", { ids, dry_run: dryRun });
const restore = (mcp: Client, ids: string[]) =>
  call(mcp, "restore_note", { ids });

async function listByTag(mcp: Client, tag: string, include?: boolean) {
  const res = await call(mcp, "list_by_tag", {
    tag,
    ...(include !== undefined ? { include_suppressed: include } : {}),
  });
  return (res.out as { node_ids: string[] }).node_ids;
}

async function listTags(mcp: Client) {
  const res = await call(mcp, "list_tags", {});
  return (res.out as { tags: { tag: string; count: number }[] }).tags;
}

async function searchIds(mcp: Client) {
  const res = await call(mcp, "search", { query: "q" });
  return (res.out as { hits: { id: string }[] }).hits.map((h) => h.id);
}

const pointer = (node: string): BodyPointer => ({
  kind: "body",
  node,
  section: "sec",
  offsetFrom: 0,
  offsetTo: 1,
  text: "x",
  ts: "2026-01-01T00:00:00Z",
});

async function edge(
  dial: FixtureChaosDial,
  from: string,
  predicate: string,
  target: { toNode?: string; toLiteral?: string },
  scope = SCOPE,
): Promise<void> {
  const r = await dial.admit([opAdd(from, predicate, target)], scope);
  expect(r.admitted).toBe(true);
}

/** Every current edge of a node, order-free, for before/after diffs. */
async function snapshot(dial: FixtureChaosDial, id: string) {
  const out = (await dial.placedEdges(id)).map((e) =>
    JSON.stringify([e.predicate, e.value, e.graph]),
  );
  const inn = (await dial.referrers(id)).map((e) =>
    JSON.stringify([e.subject, e.predicate, e.graph]),
  );
  return { out: out.sort(), in: inn.sort() };
}

describe("delete_note (default: suppress) hides a note from every listing", () => {
  it("list_by_tag, list_tags, search and look all drop it; restore brings each back", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["shared", "only-a"] });
    const b = await note(r.mcp, "B", { tags: ["shared"] });
    r.searchIds.push(a, b);
    r.focus.set(pointer(a), "2026-01-01T00:00:00Z");
    r.focus.pin("p1", pointer(a), "2026-01-01T00:00:00Z");
    r.focus.pin("p2", pointer(b), "2026-01-01T00:00:00Z");

    const res = await suppress(r.mcp, [a]);
    expect(res.isError).toBe(false);
    expect(res.out.notes).toEqual([{ node_id: a, status: "suppressed" }]);

    expect(await listByTag(r.mcp, "shared")).toEqual([b]);
    expect(await listByTag(r.mcp, "only-a")).toEqual([]);
    expect(await listByTag(r.mcp, "shared", true)).toEqual([a, b].sort());
    expect(await listTags(r.mcp)).toEqual([{ tag: "#shared", count: 1 }]);
    expect(await searchIds(r.mcp)).toEqual([b]);
    const looked = await call(r.mcp, "look", {});
    expect(looked.out.focus).toBeNull();
    expect(
      (looked.out.pins as { pin_id: string }[]).map((p) => p.pin_id),
    ).toEqual(["p2"]);
    // The note is hidden, not gone: its tag rows and edges stay.
    expect((await r.tags.byNode(a)).map((t) => t.tag)).toEqual([
      "#only-a",
      "#shared",
    ]);

    const back = await restore(r.mcp, [a]);
    expect(back.out.notes).toEqual([{ node_id: a, status: "restored" }]);
    expect(await listByTag(r.mcp, "shared")).toEqual([a, b].sort());
    expect(await listTags(r.mcp)).toEqual([
      { tag: "#only-a", count: 1 },
      { tag: "#shared", count: 2 },
    ]);
    expect(await searchIds(r.mcp)).toEqual([a, b]);
    const relooked = await call(r.mcp, "look", {});
    expect((relooked.out.focus as { pointer: BodyPointer }).pointer.node).toBe(
      a,
    );
    expect(
      (relooked.out.pins as { pin_id: string }[]).map((p) => p.pin_id),
    ).toEqual(["p1", "p2"]);
  });

  it("read_container on the note's own id still answers while suppressed", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const wrote = await call(r.mcp, "write_container", {
      container: a,
      ops: [{ op: "add", text: "kept prose", position: "a0" }],
    });
    expect(wrote.isError).toBe(false);
    await suppress(r.mcp, [a]);
    const read = await call(r.mcp, "read_container", { container: a });
    expect((read.out.blocks as { text: string }[]).map((b) => b.text)).toEqual([
      "kept prose",
    ]);
  });

  it("a round trip leaves every edge, in and out, exactly as it was", async () => {
    const r = await rig();
    const parent = await note(r.mcp, "Parent");
    const a = await note(r.mcp, "A", { tags: ["t"], parent });
    const referrer = await note(r.mcp, "Ref");
    await edge(r.dial, referrer, "related", { toNode: a });
    await edge(r.dial, a, "status", { toLiteral: "seed" });
    const before = await snapshot(r.dial, a);

    await suppress(r.mcp, [a]);
    const during = await snapshot(r.dial, a);
    expect(during.in).toEqual(before.in);
    expect(during.out).toEqual(
      [
        ...before.out,
        JSON.stringify([SUPPRESSED, SUPPRESSED_VALUE, scopeHash(SCOPE)]),
      ].sort(),
    );
    // The marker is one add, asserted in the notes scope.
    expect(r.dial.admits.at(-1)).toEqual({
      ops: [opAdd(a, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE })],
      scope: SCOPE,
    });

    await restore(r.mcp, [a]);
    expect(await snapshot(r.dial, a)).toEqual(before);
    const last = r.dial.admits.at(-1);
    expect(last?.scope).toBe(SCOPE);
    expect(last?.ops).toEqual([
      opRemove(
        a,
        SUPPRESSED,
        { toLiteral: SUPPRESSED_VALUE },
        scopeHash(SCOPE),
      ),
    ]);
  });
});

describe("suppress and restore are idempotent", () => {
  it("a second suppress is already_suppressed and admits nothing", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await suppress(r.mcp, [a]);
    const admits = r.dial.admits.length;
    const again = await suppress(r.mcp, [a]);
    expect(again.isError).toBe(false);
    expect(again.out.notes).toEqual([
      { node_id: a, status: "already_suppressed" },
    ]);
    expect(again.out.totals).toEqual({
      suppressed: 0,
      already_suppressed: 1,
      not_found: 0,
    });
    expect(again.out.tx).toBeUndefined();
    expect(r.dial.admits.length).toBe(admits);
  });

  it("a second restore is not_suppressed and admits nothing", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await suppress(r.mcp, [a]);
    await restore(r.mcp, [a]);
    const admits = r.dial.admits.length;
    const again = await restore(r.mcp, [a]);
    expect(again.isError).toBe(false);
    expect(again.out.notes).toEqual([{ node_id: a, status: "not_suppressed" }]);
    expect(again.out.totals).toEqual({
      restored: 0,
      not_suppressed: 1,
      not_found: 0,
    });
    expect(again.out.tx).toBeUndefined();
    expect(r.dial.admits.length).toBe(admits);
  });

  it("a batch mixes new and already-suppressed notes in one admit", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    await suppress(r.mcp, [a]);
    const admits = r.dial.admits.length;
    const res = await suppress(r.mcp, [a, b]);
    expect(res.out.notes).toEqual([
      { node_id: a, status: "already_suppressed" },
      { node_id: b, status: "suppressed" },
    ]);
    expect(res.out.totals).toEqual({
      suppressed: 1,
      already_suppressed: 1,
      not_found: 0,
    });
    expect(res.out.tx).toBeTypeOf("number");
    expect(r.dial.admits.length).toBe(admits + 1);
  });
});

describe("dry runs write nothing, in both modes", () => {
  it("suppress is the default mode and dry_run its default", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["t"] });
    const admits = r.dial.admits.length;
    const before = await snapshot(r.dial, a);
    const res = await call(r.mcp, "delete_note", { ids: [a] });
    expect(res.out).toEqual({
      mode: "suppress",
      dry_run: true,
      notes: [{ node_id: a, status: "would_suppress" }],
      totals: { suppressed: 1, already_suppressed: 0, not_found: 0 },
    });
    expect(res.text).toBe(
      "would suppress 1 note(s), 0 already suppressed, 0 not found.",
    );
    expect(r.dial.admits.length).toBe(admits);
    expect(await snapshot(r.dial, a)).toEqual(before);
    expect(await listByTag(r.mcp, "t")).toEqual([a]);
  });

  it("purge's dry run writes nothing either", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["t"] });
    const admits = r.dial.admits.length;
    const before = await snapshot(r.dial, a);
    const res = await call(r.mcp, "delete_note", { ids: [a], purge: true });
    expect(res.out.mode).toBe("purge");
    expect(res.out.dry_run).toBe(true);
    expect(r.dial.admits.length).toBe(admits);
    expect(await snapshot(r.dial, a)).toEqual(before);
    expect((await r.tags.byNode(a)).length).toBe(1);
  });

  it("purge=false is the suppress mode, said explicitly", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const res = await call(r.mcp, "delete_note", {
      ids: [a],
      purge: false,
      dry_run: false,
    });
    expect(res.out.mode).toBe("suppress");
    expect(res.text).toBe(
      "suppressed 1 note(s), 0 already suppressed, 0 not found.",
    );
    expect(res.out.tx).toBeTypeOf("number");
  });
});

describe("purge still retracts", () => {
  it("a purged note loses every fact, and restore cannot bring it back", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["t"] });
    const res = await call(r.mcp, "delete_note", {
      ids: [a],
      purge: true,
      dry_run: false,
    });
    expect(res.isError).toBe(false);
    expect(res.text).toBe(
      "purged 1 note(s), 0 not found, 0 block(s), 1 tag row(s).",
    );
    expect(await r.dial.edges(a)).toEqual([]);
    const back = await restore(r.mcp, [a]);
    expect(back.out.notes).toEqual([{ node_id: a, status: "not_found" }]);
    expect(back.text).toBe(
      "restored 0 note(s), 0 not suppressed, 1 not found.",
    );
  });

  it("a suppressed note can be purged, marker and all", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await suppress(r.mcp, [a]);
    const res = await call(r.mcp, "delete_note", {
      ids: [a],
      purge: true,
      dry_run: false,
    });
    expect(res.isError).toBe(false);
    const n = (
      res.out.notes as unknown as { edges_out: Record<string, number> }[]
    )[0];
    expect(n?.edges_out[SUPPRESSED]).toBe(1);
    expect(await r.dial.edges(a)).toEqual([]);
    expect(await suppressedNotes(r.dial, SCOPE)).toEqual(new Set());
  });
});

describe("the protection rule applies to both modes", () => {
  async function refusedBoth(r: Rig, ids: string[]): Promise<string[]> {
    const admits = r.dial.admits.length;
    const out = [];
    for (const purge of [false, true]) {
      const res = await call(r.mcp, "delete_note", {
        ids,
        purge,
        dry_run: false,
      });
      expect(res.isError).toBe(true);
      expect(res.out.code).toBe("batch_refused");
      expect(res.text).toBe(`batch_refused: ${String(res.out.detail)}`);
      expect(res.out.detail).toContain(
        `1 of ${String(ids.length)} id(s) refused; nothing was written (`,
      );
      out.push(String(res.out.detail));
    }
    expect(r.dial.admits.length).toBe(admits);
    return out;
  }

  it("a non-Note refuses, taking its batch with it", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const m = await r.dial.admit([opCreate("Thing", "thing")], SCOPE);
    const thing = m.minted[0] ?? "";
    await edge(r.dial, thing, "x", { toLiteral: "y" });
    for (const detail of await refusedBoth(r, [a, thing])) {
      expect(detail).toContain(`not_a_note: ${thing} `);
    }
  });

  it("an archived note refuses", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Archived");
    await edge(r.dial, a, "isArchived", { toLiteral: "true" });
    for (const detail of await refusedBoth(r, [a])) {
      expect(detail).toContain(`protected: ${a} `);
    }
  });

  it("a note another star claimed refuses", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Claimed");
    const owner = "0c".repeat(32);
    r.dial.seed("Owner", "Mnemosyne", owner);
    await edge(r.dial, a, "ownedBy", { toNode: owner });
    for (const detail of await refusedBoth(r, [a])) {
      expect(detail).toContain(`protected: ${a} `);
    }
  });

  it("a parent of a note outside the call refuses; with the child it suppresses", async () => {
    const r = await rig();
    const p = await note(r.mcp, "Parent");
    const c = await note(r.mcp, "Child", { parent: p });
    for (const detail of await refusedBoth(r, [p])) {
      expect(detail).toContain(`has_children: ${p} `);
    }
    const res = await suppress(r.mcp, [p, c]);
    expect(res.isError).toBe(false);
    expect(await suppressedNotes(r.dial, SCOPE)).toEqual(new Set([p, c]));
  });

  it("restore refuses a non-Note or a protected note, writing nothing", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await suppress(r.mcp, [a]);
    const m = await r.dial.admit([opCreate("Memory", "m")], SCOPE);
    const memory = m.minted[0] ?? "";
    await edge(r.dial, memory, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE });
    const admits = r.dial.admits.length;
    const res = await restore(r.mcp, [a, memory]);
    expect(res.isError).toBe(true);
    expect(res.out.code).toBe("batch_refused");
    expect(res.out.detail).toContain(
      "1 of 2 id(s) refused; nothing was written",
    );
    expect(res.out.detail).toContain(`not_a_note: ${memory} `);
    expect(r.dial.admits.length).toBe(admits);
    expect((await suppressedNotes(r.dial, SCOPE)).has(a)).toBe(true);
  });
});

describe("the marker", () => {
  it("only the notes scope's marker counts: another graph's is not a suppression", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await edge(
      r.dial,
      a,
      SUPPRESSED,
      { toLiteral: SUPPRESSED_VALUE },
      "mnemosyne",
    );
    const admits = r.dial.admits.length;
    const back = await restore(r.mcp, [a]);
    expect(back.out.notes).toEqual([{ node_id: a, status: "not_suppressed" }]);
    expect(r.dial.admits.length).toBe(admits);
    const dry = await suppress(r.mcp, [a], true);
    expect(dry.out.notes).toEqual([{ node_id: a, status: "would_suppress" }]);
  });

  it("only the literal true marks: a false or a node value does not", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    await edge(r.dial, a, SUPPRESSED, { toLiteral: "false" });
    await edge(r.dial, b, SUPPRESSED, { toNode: SUPPRESSED_VALUE });
    const dry = await suppress(r.mcp, [a, b], true);
    expect(dry.out.notes).toEqual([
      { node_id: a, status: "would_suppress" },
      { node_id: b, status: "would_suppress" },
    ]);
    const back = await restore(r.mcp, [a, b]);
    expect(back.out.totals).toEqual({
      restored: 0,
      not_suppressed: 2,
      not_found: 0,
    });
  });

  it("another predicate's literal true is not the marker", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await edge(r.dial, a, "pinned", { toLiteral: SUPPRESSED_VALUE });
    const dry = await suppress(r.mcp, [a], true);
    expect(dry.out.notes).toEqual([{ node_id: a, status: "would_suppress" }]);
    const back = await restore(r.mcp, [a]);
    expect(back.out.notes).toEqual([{ node_id: a, status: "not_suppressed" }]);
  });

  it("a purged note left with only its system edge restores as not_found", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Mine");
    const owner = "0d".repeat(32);
    r.dial.seed("Owner", "unclaimed", owner);
    await edge(r.dial, a, "ownedBy", { toNode: owner });
    await call(r.mcp, "delete_note", { ids: [a], purge: true, dry_run: false });
    expect((await r.dial.edges(a)).map((e) => e.predicate)).toEqual([
      "ownedBy",
    ]);
    const back = await restore(r.mcp, [a]);
    expect(back.isError).toBe(false);
    expect(back.out.notes).toEqual([{ node_id: a, status: "not_found" }]);
  });

  it("set_properties cannot write it: a frontmatter key never hides a note", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const res = await call(r.mcp, "set_properties", {
      container_id: a,
      properties: [{ predicate: SUPPRESSED, values: [{ literal: "true" }] }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("bad_args");
    expect(await suppressedNotes(r.dial, SCOPE)).toEqual(new Set());
  });

  it("an id with no facts is not_found in both suppress and restore", async () => {
    const r = await rig();
    const ghost = "ab".repeat(32);
    const s = await suppress(r.mcp, [ghost]);
    expect(s.out.notes).toEqual([{ node_id: ghost, status: "not_found" }]);
    expect(s.out.totals).toEqual({
      suppressed: 0,
      already_suppressed: 0,
      not_found: 1,
    });
    expect(s.out.tx).toBeUndefined();
  });
});

describe("the fixture's scoped lookup", () => {
  it("answers sorted, deduplicated, literal-only, in the asked scope", async () => {
    const dial = new FixtureChaosDial();
    const lo = "01".repeat(32);
    const hi = "fe".repeat(32);
    await edge(dial, hi, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE });
    await edge(dial, lo, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE });
    await edge(dial, hi, "other", { toLiteral: SUPPRESSED_VALUE });
    expect(await dial.findByValue(SCOPE, SUPPRESSED, SUPPRESSED_VALUE)).toEqual(
      [lo, hi],
    );
    expect(
      await dial.findByValue(scopeHash(SCOPE), SUPPRESSED, SUPPRESSED_VALUE),
    ).toEqual([lo, hi]);
    expect(
      await dial.findByValue("elsewhere", SUPPRESSED, SUPPRESSED_VALUE),
    ).toEqual([]);
  });
});

describe("a door whose placed edges carry no graph (the live shape)", () => {
  it("suppress, re-suppress and restore still decide by the scoped lookup", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const full = r.dial;
    // MEASURED 2026-10-07: materialize_edges full answered graph "" for
    // every fact on a live note.
    const live: ChaosDial = {
      admit: (o, s) => full.admit(o, s),
      findByName: (k, l) => full.findByName(k, l),
      resolveNodes: (t) => full.resolveNodes(t),
      edges: (t) => full.edges(t),
      registerGraph: (n) => full.registerGraph(n),
      quadsFrom: (s, at, p, g) => full.quadsFrom(s, at, p, g),
      resolveScalars: (h) => full.resolveScalars(h),
      history: (s, f, g) => full.history(s, f, g),
      heldBlobs: (g) => full.heldBlobs(g),
      findByValue: (s, p, v) => full.findByValue(s, p, v),
      placedEdges: async (t) =>
        (await full.placedEdges(t)).map((e) => ({ ...e, graph: "" })),
      referrers: async (t) =>
        (await full.referrers(t)).map((e) => ({ ...e, graph: "" })),
    };
    expect(
      await suppressNotes(live, SCOPE, { ids: [a], dry_run: false }),
    ).toMatchObject({ notes: [{ node_id: a, status: "suppressed" }] });
    expect(
      await suppressNotes(live, SCOPE, { ids: [a], dry_run: false }),
    ).toMatchObject({ notes: [{ node_id: a, status: "already_suppressed" }] });
    expect(await restoreNotes(live, SCOPE, { ids: [a] })).toMatchObject({
      notes: [{ node_id: a, status: "restored" }],
    });
    expect(await suppressedNotes(full, SCOPE)).toEqual(new Set());
    // The retraction is pinned to the notes scope, not to the empty graph.
    expect(full.admits.at(-1)?.ops).toEqual([
      opRemove(
        a,
        SUPPRESSED,
        { toLiteral: SUPPRESSED_VALUE },
        scopeHash(SCOPE),
      ),
    ]);
  });
});

describe("suppressNotes / restoreNotes — arguments and failure paths", () => {
  const ID = "ab".repeat(32);

  it("refuses a bad id list before reading anything", async () => {
    const dial = new FixtureChaosDial();
    expect(await suppressNotes(dial, SCOPE, { ids: [] })).toEqual({
      code: "bad_args",
      detail: "ids is empty",
    });
    expect(await restoreNotes(dial, SCOPE, { ids: [ID, ID] })).toEqual({
      code: "bad_args",
      detail: `${ID} is repeated`,
    });
  });

  it("a dial that cannot read placed edges refuses rather than guessing", async () => {
    const full = new FixtureChaosDial();
    const bare: ChaosDial = {
      admit: (o, s) => full.admit(o, s),
      findByName: (k, l) => full.findByName(k, l),
      resolveNodes: (t) => full.resolveNodes(t),
      edges: (t) => full.edges(t),
      registerGraph: (n) => full.registerGraph(n),
      quadsFrom: (s, a, p, g) => full.quadsFrom(s, a, p, g),
      resolveScalars: (h) => full.resolveScalars(h),
      history: (s, f, g) => full.history(s, f, g),
      heldBlobs: (g) => full.heldBlobs(g),
      findByValue: (s, p, v) => full.findByValue(s, p, v),
    };
    const unsupported = {
      code: "unsupported",
      detail: "this backend's dial cannot read placed edges",
    };
    expect(await suppressNotes(bare, SCOPE, { ids: [ID] })).toEqual(
      unsupported,
    );
    expect(await restoreNotes(bare, SCOPE, { ids: [ID] })).toEqual(unsupported);
    for (const half of [
      { ...bare, placedEdges: (t: string) => full.placedEdges(t) },
      { ...bare, referrers: (t: string) => full.referrers(t) },
    ]) {
      expect(await suppressNotes(half, SCOPE, { ids: [ID] })).toEqual(
        unsupported,
      );
      expect(await restoreNotes(half, SCOPE, { ids: [ID] })).toEqual(
        unsupported,
      );
    }
  });

  it("a gate refusal writes nothing and says so, for both verbs", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    await suppress(r.mcp, [b]);
    const violations = [{ rule: "no" }];
    const refusing = r.dial;
    refusing.admit = () =>
      Promise.resolve({ admitted: false, minted: [], violations });
    expect(
      await suppressNotes(refusing, SCOPE, { ids: [a], dry_run: false }),
    ).toEqual({
      code: "admit_refused",
      detail: "the gate refused the suppression; nothing was written",
      violations,
    });
    expect(await restoreNotes(refusing, SCOPE, { ids: [b] })).toEqual({
      code: "admit_refused",
      detail: "the gate refused the restore; nothing was written",
      violations,
    });
  });

  it("dry_run omitted in the function defaults to a dry run", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const admits = r.dial.admits.length;
    const out = await suppressNotes(r.dial, SCOPE, { ids: [a] });
    expect(out).toMatchObject({ dry_run: true });
    expect(r.dial.admits.length).toBe(admits);
  });

  it("visible keeps order and passes everything through when nothing hides", () => {
    const items = ["c", "a", "b"];
    expect(visible(items, new Set(), (x) => x)).toEqual(["c", "a", "b"]);
    expect(visible(items, new Set(["a"]), (x) => x)).toEqual(["c", "b"]);
  });
});

describe("no tx is reported when nothing was written", () => {
  it("suppress dry run, already-suppressed and not_suppressed carry no tx key", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const dry = await suppressNotes(r.dial, SCOPE, { ids: [a] });
    expect(Object.keys(dry)).not.toContain("tx");
    const notYet = await restoreNotes(r.dial, SCOPE, { ids: [a] });
    expect(Object.keys(notYet)).not.toContain("tx");
    await suppressNotes(r.dial, SCOPE, { ids: [a], dry_run: false });
    const again = await suppressNotes(r.dial, SCOPE, {
      ids: [a],
      dry_run: false,
    });
    expect(Object.keys(again)).not.toContain("tx");
  });
});

describe("the listings' published surface", () => {
  it("list_by_tag and list_tags say suppressed notes are left out", async () => {
    const { mcp } = await rig();
    const { tools } = await mcp.listTools();
    expect(tools.find((t) => t.name === "list_by_tag")?.description).toBe(
      "C9: the server-side tag slice — the notes-graph nodes carrying " +
        "hasTag == the (lowercase-normalized) tag, over the graph's indexed " +
        "point lookup, suppressed notes left out unless include_suppressed. " +
        "Returns {tag, node_ids}.",
    );
    expect(tools.find((t) => t.name === "create_note")?.description).toBe(
      "C8: mint a Note-kind identity node on the notes graph through the " +
        "gated two-admit path (createNode, then hasName/hasType/parent " +
        "edges), auto-parenting to the invisible 'Notes' root when no " +
        "parent is named — orphan-safe, idempotent on (Note, title), with " +
        "heal-on-reuse for interrupted mints. tags[] is accepted and " +
        "forward-carried (the hasTag write is C9's). Returns {node_id, " +
        "created}; refusals (bad_args / " +
        "admit_refused / suppressed_exists — the title " +
        "belongs to a suppressed note, whose id it names; restore_note " +
        "brings it back).",
    );
    expect(tools.find((t) => t.name === "list_tags")?.description).toBe(
      "C9: every tag Calliope has written, with carrier counts — the " +
        "picker's chip source. Suppressed notes are not counted. Returns " +
        "{tags: [{tag, count}]}.",
    );
  });

  it("search answers on a server built with no options at all", async () => {
    const server = createServer(new FixtureBodyClient());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
    const res = await call(mcp, "search", { query: "q" });
    expect(res.isError).toBe(false);
    expect(res.out.hits).toEqual([]);
  });
});

describe("restore_note's published surface", () => {
  it("carries its title, description, annotations and schema", async () => {
    const { mcp } = await rig();
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "restore_note");
    expect(tool?.title).toBe("Restore suppressed notes");
    expect(tool?.description).toBe(
      "Undo delete_note's default suppress: retract each note's " +
        "suppressed=true marker and nothing else, so the note returns to " +
        "every listing with its edges as they were. A note that was never " +
        "suppressed answers not_suppressed. A PURGED note cannot be " +
        "restored here (its facts were retracted; history keeps them, " +
        "read_container(as_of_tx) still reads it) and answers not_found. " +
        "Takes up to 100 ids; a non-Note or a protected note refuses the " +
        "call, writing nothing.",
    );
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tool?.inputSchema.required).toEqual(["ids"]);
    const listBy = tools.find((t) => t.name === "list_by_tag");
    const props = listBy?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    expect(props.include_suppressed?.description).toBe(
      "Default false. true also lists suppressed notes (a tag rename " +
        "must reach them).",
    );
  });

  it("answers restore in text", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await suppress(r.mcp, [a]);
    const res = await restore(r.mcp, [a]);
    expect(res.text).toBe("restored 1 note(s), 0 not suppressed, 0 not found.");
    expect(res.out.tx).toBeTypeOf("number");
  });
});

describe("create_note never hands back a suppressed note", () => {
  it("refuses suppressed_exists, naming the hidden note and restore_note", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Gone");
    await suppress(r.mcp, [a]);
    const before = r.dial.admits.length;
    const res = await call(r.mcp, "create_note", { title: "Gone" });
    expect(res.isError).toBe(true);
    expect(res.out).toEqual({
      code: "suppressed_exists",
      detail: expect.stringContaining(a) as string,
    });
    expect(res.text).toContain("suppressed_exists");
    expect(res.text).toContain("restore_note");
    expect(res.text).toContain(a);
    // Nothing minted, nothing healed: the identity stays the one node.
    expect(r.dial.admits.length).toBe(before);
    expect(await r.dial.findByName("Note", "Gone")).toEqual([a]);
  });

  it("after restore_note the title reuses the note again", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Back");
    await suppress(r.mcp, [a]);
    await restore(r.mcp, [a]);
    const res = await call(r.mcp, "create_note", { title: "Back" });
    expect(res.isError).toBe(false);
    expect(res.out).toEqual({ node_id: a, created: false });
  });

  it("a live holder of the title wins over a suppressed twin that sorts first", async () => {
    const dial = new FixtureChaosDial();
    const live = await createNote(dial, SCOPE, { title: "Twin" });
    expect(live).toMatchObject({ created: true });
    const { node_id } = live as { node_id: string };
    const hidden = "00".repeat(32);
    dial.seed("Note", "Twin", hidden);
    // The fixture keeps one token per (kind, label); the door answers every
    // holder, so the twin is answered here.
    const byName = dial.findByName.bind(dial);
    dial.findByName = async (kind, label) =>
      label === "Twin" ? [node_id, hidden] : byName(kind, label);
    await dial.admit(
      [
        opAdd(hidden, "hasName", { toLiteral: "Twin" }),
        opAdd(hidden, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE }),
      ],
      SCOPE,
    );
    expect([hidden, node_id].sort()[0]).toBe(hidden);
    expect(await createNote(dial, SCOPE, { title: "Twin" })).toEqual({
      node_id,
      created: false,
    });
  });

  it("reuses the LOWEST live holder, and refuses naming the lowest hidden one", async () => {
    const dial = new FixtureChaosDial();
    const low = "01".repeat(32);
    const high = "fe".repeat(32);
    for (const t of [low, high]) {
      dial.seed("Note", "Pair", t);
      await dial.admit([opAdd(t, "hasName", { toLiteral: "Pair" })], SCOPE);
    }
    const byName = dial.findByName.bind(dial);
    dial.findByName = async (kind, label) =>
      label === "Pair" ? [high, low] : byName(kind, label);
    expect(await createNote(dial, SCOPE, { title: "Pair" })).toEqual({
      node_id: low,
      created: false,
    });
    await dial.admit(
      [low, high].map((t) =>
        opAdd(t, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE }),
      ),
      SCOPE,
    );
    expect(await createNote(dial, SCOPE, { title: "Pair" })).toMatchObject({
      code: "suppressed_exists",
      node_id: low,
    });
  });

  it("a marker in another scope does not hide the note from create_note", async () => {
    const dial = new FixtureChaosDial();
    const first = await createNote(dial, SCOPE, { title: "Elsewhere" });
    const { node_id } = first as { node_id: string };
    await dial.admit(
      [opAdd(node_id, SUPPRESSED, { toLiteral: SUPPRESSED_VALUE })],
      "memories",
    );
    expect(await createNote(dial, SCOPE, { title: "Elsewhere" })).toEqual({
      node_id,
      created: false,
    });
  });
});
