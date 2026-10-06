/**
 * delete_note — every fact of a note goes, nothing else does.
 *
 * Synthetic data only: a FixtureChaosDial, a FixtureBlobStore and a
 * FixtureTagStore behind the real MCP server. Pins the edge kinds in both
 * directions, the slot facts, the tag mirror, the dry-run default, the
 * refusals (non-Note, protected, stray children), the shared-blob and
 * shared-slot survivals, batch, and the not_found re-delete.
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
  scopeHash,
} from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import {
  DELETE_NOTE_MAX,
  type DeleteNotesError,
  type DeleteNotesResult,
  deleteNotes,
  isDeleteNotesError,
} from "../src/note-delete.js";
import { FixtureTagStore } from "../src/tag-store.js";

const SCOPE = "notes";

interface Rig {
  mcp: Client;
  dial: FixtureChaosDial;
  tags: FixtureTagStore;
  blobs: FixtureBlobStore;
}

async function rig(): Promise<Rig> {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const tags = new FixtureTagStore();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: SCOPE },
    containers: { blobs, dial },
    tags,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, dial, tags, blobs };
}

async function note(
  mcp: Client,
  title: string,
  extra: { tags?: string[]; parent?: string } = {},
): Promise<string> {
  const res = await mcp.callTool({
    name: "create_note",
    arguments: { title, ...extra },
  });
  expect(res.isError).toBeFalsy();
  return (res.structuredContent as { node_id: string }).node_id;
}

async function addBlock(mcp: Client, container: string, text: string) {
  const res = await mcp.callTool({
    name: "write_container",
    arguments: { container, ops: [{ op: "add", text, position: "a0" }] },
  });
  expect(res.isError).toBeFalsy();
}

interface Block {
  slot: string;
  blobId: string;
  text: string | null;
}

async function blocks(mcp: Client, container: string): Promise<Block[]> {
  const res = await mcp.callTool({
    name: "read_container",
    arguments: { container },
  });
  return (res.structuredContent as { blocks: Block[] }).blocks;
}

async function del(
  mcp: Client,
  ids: string[],
  dryRun?: boolean,
): Promise<{ isError: boolean; out: DeleteNotesResult & DeleteNotesError }> {
  const res = await mcp.callTool({
    name: "delete_note",
    arguments: { ids, ...(dryRun !== undefined ? { dry_run: dryRun } : {}) },
  });
  return {
    isError: res.isError === true,
    out: res.structuredContent as DeleteNotesResult & DeleteNotesError,
  };
}

async function edge(
  dial: FixtureChaosDial,
  from: string,
  predicate: string,
  target: { toNode?: string; toLiteral?: string },
): Promise<void> {
  const r = await dial.admit([opAdd(from, predicate, target)], SCOPE);
  expect(r.admitted).toBe(true);
}

let mints = 0;
async function mint(dial: FixtureChaosDial, kind: string): Promise<string> {
  mints += 1;
  const r = await dial.admit(
    [opCreate(kind, `${kind}-${String(mints)}`)],
    SCOPE,
  );
  const [token] = r.minted;
  if (token === undefined) throw new Error("no mint");
  return token;
}

/** A note carrying every edge kind, in and out, plus a block and tags. */
async function richNote(r: Rig) {
  const { mcp, dial } = r;
  const target = await note(mcp, "Target");
  const a = await note(mcp, "Rich", { tags: ["Explicit/One"] });
  const referrer = await note(mcp, "Referrer");
  await addBlock(mcp, a, "prose with #inline");
  const res = await mcp.callTool({
    name: "set_properties",
    arguments: {
      container_id: a,
      properties: [
        { predicate: "status", values: [{ literal: "seed" }] },
        { predicate: "childOf", values: [{ node: target }] },
      ],
      frontmatter: "status: seed",
    },
  });
  expect(res.isError).toBeFalsy();
  await edge(dial, a, "supersededBy", { toNode: target });
  // Inbound: a property edge from another note, and a collection member.
  await edge(dial, referrer, "related", { toNode: a });
  const collection = await mint(dial, "Collection");
  await edge(dial, collection, "hasMember", { toNode: a });
  return { a, target, referrer, collection };
}

describe("delete_note — the verb", () => {
  it("removes the note, its blocks and every edge kind in both directions", async () => {
    const r = await rig();
    const { a, target, referrer, collection } = await richNote(r);
    const [slot] = await blocks(r.mcp, a);
    if (slot === undefined) throw new Error("no block");

    const { isError, out } = await del(r.mcp, [a], false);
    expect(isError).toBe(false);
    expect(out.dry_run).toBe(false);
    const [n] = out.notes;
    expect(n?.status).toBe("deleted");
    expect(n?.tx).toBeTypeOf("number");
    expect(n?.edges_out).toEqual({
      hasName: 1,
      hasType: 1,
      parent: 1,
      hasTag: 2,
      tree_member: 1,
      status: 1,
      childOf: 1,
      frontmatter: 1,
      supersededBy: 1,
    });
    expect(n?.edges_in).toEqual({ related: 1, hasMember: 1 });
    expect(n?.blocks).toBe(1);
    expect(n?.blobs).toEqual([slot.blobId]);
    expect(n?.tags).toEqual(["#explicit/one", "#inline"]);

    expect(await r.dial.edges(a)).toEqual([]);
    expect(await r.dial.edges(slot.slot)).toEqual([]);
    expect(await r.dial.referrers(a)).toEqual([]);
    expect(
      (await r.dial.edges(referrer)).some((e) => e.predicate === "related"),
    ).toBe(false);
    expect(await r.dial.edges(collection)).toEqual([]);
    // The target note itself is untouched — only the edge onto it went.
    expect(
      (await r.dial.edges(target)).some((e) => e.predicate === "hasType"),
    ).toBe(true);
    expect(await blocks(r.mcp, a)).toEqual([]);
    // Every retraction is pinned to the scope the fact lives in, and the
    // membership, read from both ends, is retracted once.
    const last = r.dial.admits.at(-1);
    expect(last?.ops.filter((o) => o.predicate === "tree_member")).toHaveLength(
      1,
    );
    expect(last?.scope).toBe(SCOPE);
    expect(
      last?.ops.every(
        (o) => o.op === "removeEdge" && o.graph === scopeHash(SCOPE),
      ),
    ).toBe(true);
    expect(out.totals).toMatchObject({
      deleted: 1,
      not_found: 0,
      blocks: 1,
      shared_blocks: 0,
      blobs_referenced: 1,
      blobs_deleted: 0,
      tag_rows: 2,
    });
    // History keeps the note: the log still holds its facts.
    expect(r.dial.factLog.some((f) => f.s === a && f.added)).toBe(true);
  });

  it("dry run is the default and writes nothing", async () => {
    const r = await rig();
    const { a } = await richNote(r);
    const admits = r.dial.admits.length;
    const before = await r.dial.edges(a);
    const tagRows = await r.tags.byNode(a);

    const { isError, out } = await del(r.mcp, [a]);
    expect(isError).toBe(false);
    expect(out.dry_run).toBe(true);
    expect(out.notes[0]?.status).toBe("would_delete");
    expect(out.notes[0]?.tx).toBeUndefined();
    expect(out.notes[0]?.edges_in).toEqual({ related: 1, hasMember: 1 });
    expect(out.notes[0]?.tags).toEqual(["#explicit/one", "#inline"]);
    expect(r.dial.admits.length).toBe(admits);
    expect(await r.dial.edges(a)).toEqual(before);
    expect(await r.tags.byNode(a)).toEqual(tagRows);
  });

  it("the dry run's report is exactly what the real run removes", async () => {
    const r = await rig();
    const { a } = await richNote(r);
    const dry = await del(r.mcp, [a], true);
    const real = await del(r.mcp, [a], false);
    const strip = (n: object) => ({ ...n, status: "", tx: 0 });
    expect(real.out.notes.map(strip)).toEqual(dry.out.notes.map(strip));
    expect(real.out.totals).toEqual(dry.out.totals);
  });

  it("the tag mirror follows: list_tags stops counting the note", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["shared", "only-a"] });
    await note(r.mcp, "B", { tags: ["shared"] });
    await del(r.mcp, [a], false);
    expect(await r.tags.byNode(a)).toEqual([]);
    const res = await r.mcp.callTool({ name: "list_tags", arguments: {} });
    expect(
      (res.structuredContent as { tags: { tag: string; count: number }[] })
        .tags,
    ).toEqual([{ tag: "#shared", count: 1 }]);
  });

  it("a blob another note shares survives, and so does that note's text", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    await addBlock(r.mcp, a, "the same prose");
    await addBlock(r.mcp, b, "the same prose");
    const [ba] = await blocks(r.mcp, a);
    const [bb] = await blocks(r.mcp, b);
    expect(ba?.blobId).toBe(bb?.blobId);

    const { out } = await del(r.mcp, [a], false);
    expect(out.totals.blobs_deleted).toBe(0);
    expect(await blocks(r.mcp, b)).toEqual([
      expect.objectContaining({ text: "the same prose" }),
    ]);
    expect(await r.blobs.getText(bb?.blobId ?? "")).toBe("the same prose");
  });

  it("a slot another container also holds keeps its facts; only the membership goes", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    await addBlock(r.mcp, a, "shared slot");
    const [s] = await blocks(r.mcp, a);
    if (s === undefined) throw new Error("no block");
    await edge(r.dial, b, "tree_member", { toNode: s.slot });

    const { out } = await del(r.mcp, [a], false);
    expect(out.notes[0]?.blocks).toBe(0);
    expect(out.notes[0]?.shared_blocks).toBe(1);
    expect(out.notes[0]?.blobs).toEqual([]);
    expect(await blocks(r.mcp, b)).toEqual([
      expect.objectContaining({ slot: s.slot, text: "shared slot" }),
    ]);
  });

  it("a batch deletes several notes, a parent with its child included", async () => {
    const r = await rig();
    const parent = await note(r.mcp, "Parent");
    const child = await note(r.mcp, "Child", { parent });
    const other = await note(r.mcp, "Other");
    const { isError, out } = await del(r.mcp, [parent, child, other], false);
    expect(isError).toBe(false);
    expect(out.notes.map((n) => n.status)).toEqual([
      "deleted",
      "deleted",
      "deleted",
    ]);
    // The child's parent edge is one fact, retracted once.
    expect(out.notes[0]?.edges_in).toEqual({ parent: 1 });
    expect(out.notes[1]?.edges_out.parent).toBe(1);
    for (const id of [parent, child, other]) {
      expect(await r.dial.edges(id)).toEqual([]);
    }
    expect(out.totals.deleted).toBe(3);
  });

  it("a parent whose child is outside the call refuses, writing nothing", async () => {
    const r = await rig();
    const parent = await note(r.mcp, "Parent");
    const child = await note(r.mcp, "Child", { parent });
    const admits = r.dial.admits.length;
    const { isError, out } = await del(r.mcp, [parent], false);
    expect(isError).toBe(true);
    expect(out.error).toBe("refused");
    expect(out.refused).toEqual([
      expect.objectContaining({ node_id: parent, error: "has_children" }),
    ]);
    expect(out.refused?.[0]?.detail).toContain(child);
    expect(r.dial.admits.length).toBe(admits);
  });

  it("a re-delete answers not_found cleanly and admits nothing", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await del(r.mcp, [a], false);
    const admits = r.dial.admits.length;
    const again = await del(r.mcp, [a], false);
    expect(again.isError).toBe(false);
    expect(again.out.notes).toEqual([
      expect.objectContaining({ node_id: a, status: "not_found", tags: [] }),
    ]);
    expect(again.out.totals).toMatchObject({ deleted: 0, not_found: 1 });
    expect(r.dial.admits.length).toBe(admits);
  });

  it("anything not typed Note refuses, and takes its batch with it", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await addBlock(r.mcp, a, "x");
    const [s] = await blocks(r.mcp, a);
    const typed = await mint(r.dial, "Task");
    await edge(r.dial, typed, "hasType", { toLiteral: "Task" });
    const nodeTyped = await mint(r.dial, "Thing");
    await edge(r.dial, nodeTyped, "hasType", { toNode: a });
    const admits = r.dial.admits.length;

    for (const id of [s?.slot ?? "", typed, nodeTyped]) {
      const { isError, out } = await del(r.mcp, [a, id], false);
      expect(isError).toBe(true);
      expect(out.refused).toEqual([
        expect.objectContaining({ node_id: id, error: "not_a_note" }),
      ]);
      expect(out.detail).toBe("1 of 2 id(s) refused; nothing was written");
    }
    expect(r.dial.admits.length).toBe(admits);
    expect((await r.dial.edges(a)).length).toBeGreaterThan(0);
  });
});

describe("delete_note — protected notes", () => {
  it("an archived note refuses", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Archived");
    await edge(r.dial, a, "isArchived", { toLiteral: "true" });
    const { out } = await del(r.mcp, [a], false);
    expect(out.refused).toEqual([
      expect.objectContaining({ node_id: a, error: "protected" }),
    ]);
  });

  it("isArchived=false is not protection", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Live");
    await edge(r.dial, a, "isArchived", { toLiteral: "false" });
    const { isError } = await del(r.mcp, [a], false);
    expect(isError).toBe(false);
  });

  it("a note another star claimed refuses", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Claimed");
    const owner = "0c".repeat(32);
    r.dial.seed("Owner", "Mnemosyne", owner);
    await edge(r.dial, a, "ownedBy", { toNode: owner });
    const { out } = await del(r.mcp, [a], false);
    expect(out.refused).toEqual([
      {
        node_id: a,
        error: "protected",
        detail: `${a} is owned by mnemosyne, not calliope`,
      },
    ]);
  });

  it("an unclaimed note deletes and its system edge stays", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Mine");
    const owner = "0d".repeat(32);
    r.dial.seed("Owner", " Unclaimed ", owner);
    await edge(r.dial, a, "ownedBy", { toNode: owner });
    const { isError, out } = await del(r.mcp, [a], false);
    expect(isError).toBe(false);
    expect(out.notes[0]?.edges_out.ownedBy).toBeUndefined();
    expect((await r.dial.edges(a)).map((e) => e.predicate)).toEqual([
      "ownedBy",
    ]);
    // Only system edges left: a re-delete is not_found, not not_a_note.
    const again = await del(r.mcp, [a], false);
    expect(again.out.notes[0]?.status).toBe("not_found");
  });

  it("an owner the dictionary cannot name does not block", async () => {
    const r = await rig();
    const a = await note(r.mcp, "Anon");
    await edge(r.dial, a, "ownedBy", { toNode: "0e".repeat(32) });
    expect((await del(r.mcp, [a], false)).isError).toBe(false);
  });
});

describe("deleteNotes — arguments and failure paths", () => {
  const ID = "ab".repeat(32);

  async function call(ids: string[], dial: ChaosDial = new FixtureChaosDial()) {
    return deleteNotes(dial, SCOPE, undefined, { ids, dry_run: false });
  }

  it("refuses an empty, oversized, malformed or repeated id list", async () => {
    expect(await call([])).toEqual({
      error: "bad_arguments",
      detail: "ids is empty",
    });
    const many = Array.from({ length: DELETE_NOTE_MAX + 1 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    expect(await call(many)).toEqual({
      error: "bad_arguments",
      detail: `${String(DELETE_NOTE_MAX + 1)} ids; one call takes at most ${String(DELETE_NOTE_MAX)}`,
    });
    const atCap = await call(many.slice(0, DELETE_NOTE_MAX));
    expect(isDeleteNotesError(atCap)).toBe(false);
    expect(await call(["XYZ"])).toEqual({
      error: "bad_arguments",
      detail: "XYZ is not a 64-hex node token",
    });
    expect(await call([ID, ID])).toEqual({
      error: "bad_arguments",
      detail: `${ID} is repeated`,
    });
  });

  it("a dial that cannot read placed edges refuses rather than half-deleting", async () => {
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
    const expected = {
      error: "unsupported",
      detail: "this backend's dial cannot read placed edges",
    };
    expect(await call([ID], bare)).toEqual(expected);
    expect(
      await call([ID], { ...bare, placedEdges: (t) => full.placedEdges(t) }),
    ).toEqual(expected);
    expect(
      await call([ID], { ...bare, referrers: (t) => full.referrers(t) }),
    ).toEqual(expected);
  });

  it("a gate refusal stops the call and reports what landed before it", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const b = await note(r.mcp, "B");
    const dial = r.dial;
    let calls = 0;
    const admit = dial.admit.bind(dial);
    dial.admit = (ops, scope) => {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve({
          admitted: false,
          minted: [],
          violations: [{ rule: "nope" }],
        });
      }
      return admit(ops, scope);
    };
    const out = await deleteNotes(dial, SCOPE, r.tags, {
      ids: [a, b],
      dry_run: false,
    });
    expect(out).toEqual({
      error: "admit_refused",
      detail: `the gate refused the retraction of ${b}`,
      violations: [{ rule: "nope" }],
      notes: [expect.objectContaining({ node_id: a, status: "deleted" })],
    });
    expect(await dial.edges(a)).toEqual([]);
    expect((await dial.edges(b)).length).toBeGreaterThan(0);
  });

  it("without a tag store the delete still lands and reports no tag rows", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["t"] });
    const out = await deleteNotes(r.dial, SCOPE, undefined, {
      ids: [a],
      dry_run: false,
    });
    if (isDeleteNotesError(out)) throw new Error(out.detail);
    expect(out.notes[0]?.tags).toEqual([]);
    expect(await r.dial.edges(a)).toEqual([]);
    // The mirror was not this call's to touch.
    expect(await r.tags.byNode(a)).toEqual([{ tag: "#t", source: "explicit" }]);
  });

  it("dry_run omitted in the function defaults to a dry run", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const out = await deleteNotes(r.dial, SCOPE, r.tags, { ids: [a] });
    if (isDeleteNotesError(out)) throw new Error(out.detail);
    expect(out.dry_run).toBe(true);
    expect((await r.dial.edges(a)).length).toBeGreaterThan(0);
  });
});

describe("delete_note — the edges of each rule", () => {
  it("only a literal hasType=Note makes a note, with the exact refusal", async () => {
    const r = await rig();
    const nodeTyped = await mint(r.dial, "Thing");
    await edge(r.dial, nodeTyped, "hasType", { toNode: "Note" });
    const wrongPredicate = await mint(r.dial, "Thing");
    await edge(r.dial, wrongPredicate, "kindOf", { toLiteral: "Note" });
    for (const id of [nodeTyped, wrongPredicate]) {
      const { out } = await del(r.mcp, [id], false);
      expect(out.refused).toEqual([
        {
          node_id: id,
          error: "not_a_note",
          detail: `${id} carries no hasType=Note edge`,
        },
      ]);
    }
  });

  it("only a literal isArchived=true protects, with the exact refusal", async () => {
    const r = await rig();
    const archived = await note(r.mcp, "Archived");
    await edge(r.dial, archived, "isArchived", { toLiteral: "true" });
    const { out } = await del(r.mcp, [archived], false);
    expect(out.refused).toEqual([
      {
        node_id: archived,
        error: "protected",
        detail: `${archived} is in the frozen archive (isArchived=true)`,
      },
    ]);
    const nodeValued = await note(r.mcp, "NodeValued");
    await edge(r.dial, nodeValued, "isArchived", { toNode: "true" });
    const otherPredicate = await note(r.mcp, "Other");
    await edge(r.dial, otherPredicate, "done", { toLiteral: "true" });
    const ok = await del(r.mcp, [nodeValued, otherPredicate], false);
    expect(ok.isError).toBe(false);
  });

  it("asks the dictionary for owners only when the note has one", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    let asked = 0;
    const resolve = r.dial.resolveNodes.bind(r.dial);
    r.dial.resolveNodes = (tokens) => {
      asked += 1;
      return resolve(tokens);
    };
    await del(r.mcp, [a]);
    expect(asked).toBe(0);
    await edge(r.dial, a, "ownedBy", { toNode: "0f".repeat(32) });
    await del(r.mcp, [a]);
    expect(asked).toBe(1);
  });

  it("names every stray child in the has_children refusal", async () => {
    const r = await rig();
    const parent = await note(r.mcp, "Parent");
    const c1 = await note(r.mcp, "C1", { parent });
    const c2 = await note(r.mcp, "C2", { parent });
    const { out } = await del(r.mcp, [parent, c1], false);
    expect(out.refused).toEqual([
      {
        node_id: parent,
        error: "has_children",
        detail: `${parent} is the parent of 1 note(s) outside this call (${c2})`,
      },
    ]);
    const both = await del(r.mcp, [parent], false);
    expect(both.out.refused?.[0]?.detail).toBe(
      `${parent} is the parent of 2 note(s) outside this call (${c1}, ${c2})`,
    );
  });

  it("an edge onto a slot from a non-container goes with the slot", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await addBlock(r.mcp, a, "commented");
    const [s] = await blocks(r.mcp, a);
    if (s === undefined) throw new Error("no block");
    const comment = await mint(r.dial, "Comment");
    await edge(r.dial, comment, "annotates", { toNode: s.slot });
    // Blob-domain and literal facts on the slot that are NOT its content.
    await r.dial.admit(
      [
        opAdd(s.slot, "attachment", { toBlob: "999" }),
        opAdd(s.slot, "tree_content", { toLiteral: "77" }),
      ],
      SCOPE,
    );
    const { out } = await del(r.mcp, [a], false);
    expect(out.notes[0]).toMatchObject({
      blocks: 1,
      shared_blocks: 0,
      blobs: [s.blobId],
    });
    expect(await r.dial.edges(comment)).toEqual([]);
    expect(await r.dial.edges(s.slot)).toEqual([]);
    const ops = r.dial.admits.at(-1)?.ops ?? [];
    expect(ops).toContainEqual(
      expect.objectContaining({
        from_id: s.slot,
        predicate: "tree_content",
        to_blob: s.blobId,
        to_literal: null,
        to_node: null,
      }),
    );
    expect(ops).toContainEqual(
      expect.objectContaining({
        from_id: comment,
        predicate: "annotates",
        to_node: s.slot,
      }),
    );
  });

  it("reports blob ids in numeric order", async () => {
    const r = await rig();
    for (let i = 0; i < 8; i += 1) await r.blobs.mint(`burn ${String(i)}`);
    const other = await note(r.mcp, "Other");
    await addBlock(r.mcp, other, "nine"); // blob 9
    const a = await note(r.mcp, "A");
    await addBlock(r.mcp, a, "ten"); // blob 10, first slot
    await addBlock(r.mcp, a, "nine"); // blob 9, second slot
    const { out } = await del(r.mcp, [a]);
    expect(out.notes[0]?.blobs).toEqual(["9", "10"]);
  });

  it("totals sum across the batch and a shared fact is retracted once", async () => {
    const r = await rig();
    const parent = await note(r.mcp, "Parent");
    const child = await note(r.mcp, "Child", { parent });
    const keeper = await note(r.mcp, "Keeper");
    for (const n of [parent, child]) {
      await addBlock(r.mcp, n, `shared of ${n}`);
      const [s] = await blocks(r.mcp, n);
      await edge(r.dial, keeper, "tree_member", { toNode: s?.slot ?? "" });
    }
    const before = r.dial.admits.length;
    const { out } = await del(r.mcp, [parent, child], false);
    expect(out.totals).toEqual({
      deleted: 2,
      not_found: 0,
      edges_out: {
        hasName: 2,
        hasType: 2,
        parent: 2,
        tree_member: 2,
      },
      edges_in: { parent: 1 },
      blocks: 0,
      shared_blocks: 2,
      blobs_referenced: 0,
      blobs_deleted: 0,
      tag_rows: 0,
    });
    const parentOps = r.dial.admits
      .slice(before)
      .flatMap((a) => a.ops)
      .filter((o) => o.from_id === child && o.predicate === "parent");
    expect(parentOps).toHaveLength(1);
  });

  it("a not_found note reports nothing, even with a stale mirror row", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    await del(r.mcp, [a], false);
    await r.tags.upsert(a, "#stale", "inline");
    const { out } = await del(r.mcp, [a], false);
    expect(out.notes).toEqual([
      {
        node_id: a,
        status: "not_found",
        edges_out: {},
        edges_in: {},
        blocks: 0,
        shared_blocks: 0,
        blobs: [],
        tags: [],
      },
    ]);
  });

  it("a gate that names no transaction leaves tx off the report", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A");
    const admit = r.dial.admit.bind(r.dial);
    r.dial.admit = async (ops, scope) => {
      const res = await admit(ops, scope);
      return { admitted: res.admitted, minted: res.minted, violations: [] };
    };
    const { out } = await del(r.mcp, [a], false);
    expect(out.notes[0]?.status).toBe("deleted");
    expect("tx" in (out.notes[0] ?? {})).toBe(false);
  });
});

describe("delete_note's published surface", () => {
  it("carries its title, description, annotations and schema", async () => {
    const { mcp } = await rig();
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "delete_note");
    expect(tool?.title).toBe("Delete notes (retract every current fact)");
    expect(tool?.description).toBe(
      "Take Note nodes off the notes graph: every current outbound and " +
        "inbound fact, each block slot's facts, and the tag-mirror rows. " +
        "History keeps the retracted facts; blobs are left to the census. " +
        "dry_run defaults to TRUE and reports what would go (edges by " +
        "predicate, blocks, blobs, tags). Takes up to 100 ids. Refuses the " +
        "whole call, writing nothing, on a non-Note, a protected note " +
        "(archived, or claimed by another star) or a parent of a note " +
        "outside the call. A note already gone answers not_found.",
    );
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    const props = tool?.inputSchema.properties as Record<
      string,
      {
        description?: string;
        minItems?: number;
        maxItems?: number;
        items?: { pattern?: string };
      }
    >;
    expect(props.ids).toMatchObject({
      description: "Note node tokens.",
      minItems: 1,
      maxItems: 100,
      items: { pattern: "^[0-9a-f]{64}$" },
    });
    expect(props.dry_run?.description).toBe("Default true. false deletes.");
    expect(tool?.inputSchema.required).toEqual(["ids"]);
  });

  it("refuses malformed ids at the schema", async () => {
    const { mcp } = await rig();
    for (const ids of [
      [],
      ["XY".repeat(32)],
      [`${"a".repeat(64)}0`],
      [`0${"a".repeat(64)}`],
    ]) {
      const res = await mcp
        .callTool({ name: "delete_note", arguments: { ids } })
        .then(
          (x) => x.isError === true,
          () => true,
        );
      expect(res, JSON.stringify(ids)).toBe(true);
    }
  });

  it("answers in text: the dry run, the real run and a refusal", async () => {
    const r = await rig();
    const a = await note(r.mcp, "A", { tags: ["t"] });
    await addBlock(r.mcp, a, "x");
    const text = async (args: Record<string, unknown>) => {
      const res = await r.mcp.callTool({
        name: "delete_note",
        arguments: args,
      });
      return (res.content as { text: string }[]).map((c) => c.text);
    };
    expect(await text({ ids: [a] })).toEqual([
      "would delete 1 note(s), 0 not found, 1 block(s), 1 tag row(s).",
    ]);
    expect(await text({ ids: [a], dry_run: false })).toEqual([
      "deleted 1 note(s), 0 not found, 1 block(s), 1 tag row(s).",
    ]);
    const other = await mint(r.dial, "Thing");
    await edge(r.dial, other, "x", { toLiteral: "y" });
    expect(await text({ ids: [other] })).toEqual([
      "refused: 1 of 1 id(s) refused; nothing was written",
    ]);
  });
});
