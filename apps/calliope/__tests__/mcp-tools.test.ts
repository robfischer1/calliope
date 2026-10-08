import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { readBody, writeBody } from "../src/mcp/tools.js";

describe("calliope-mcp tools — over FixtureBodyClient", () => {
  it("read_body returns [] for an unknown node", async () => {
    const client = new FixtureBodyClient();
    expect(await readBody(client, "missing")).toEqual({ sections: [] });
  });

  it("read_body returns sections sorted by orderKey", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [
      { text: "first" },
      { text: "second" },
      { text: "third" },
    ]);
    const result = await readBody(client, "n1");
    expect(result.sections.map((s) => s.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    const keys = result.sections.map((s) => s.orderKey);
    expect([...keys].sort()).toEqual(keys);
    for (const s of result.sections) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
    }
  });

  it("write_body coarse-saves and reports { ok, count }", async () => {
    const client = new FixtureBodyClient();
    const res = await writeBody(client, "n1", [
      { text: "## Heading" },
      { text: "body" },
    ]);
    expect(res).toEqual({ ok: true, count: 2 });
    expect((await readBody(client, "n1")).sections.map((s) => s.text)).toEqual([
      "## Heading",
      "body",
    ]);
  });

  it("write_body replaces the whole body on re-save", async () => {
    const client = new FixtureBodyClient();
    await writeBody(client, "n1", [{ text: "old" }]);
    const res = await writeBody(client, "n1", [
      { text: "new1" },
      { text: "new2" },
    ]);
    expect(res.count).toBe(2);
    expect((await readBody(client, "n1")).sections.map((s) => s.text)).toEqual([
      "new1",
      "new2",
    ]);
  });
});

// ── F3: the block-native verb surface ────────────────────────────────────────

import { FixtureChaosDial as F11Dial } from "../src/chaos-client.js";
import {
  createNote as f11CreateNote,
  isCreateNoteError as f11IsErr,
} from "../src/mcp/tools.js";

describe("create_note rejects hex-shaped tags (F11)", () => {
  it("returns bad_args for a hex-color-shaped explicit tag", async () => {
    const dial = new F11Dial();
    const res = await f11CreateNote(dial, "notes", {
      title: "Tagged note",
      tags: ["#a6d189"],
    });
    expect(f11IsErr(res)).toBe(true);
    if (f11IsErr(res)) expect(res.code).toBe("bad_args");
  });
});

// ── C8: create_note over the FixtureChaosDial ────────────────────────────────

import {
  FixtureChaosDial,
  NOTE_ROOT_KIND,
  NOTE_ROOT_LABEL,
  opCreate,
} from "../src/chaos-client.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";

const SCOPE = "notes";

describe("create_note — the note-native mint (C8)", () => {
  it("mints in ONE admit: createNode with hasName/hasType/parent beside it", async () => {
    const dial = new FixtureChaosDial();
    const result = await createNote(dial, SCOPE, { title: "My Note" });
    expect(isCreateNoteError(result)).toBe(false);
    if (isCreateNoteError(result)) return;
    expect(result.created).toBe(true);
    // admits: root mint (2: create+edges), then the note mint (1: all of it).
    // The Note floor (hasName) must ride the createNode (chaos#14929).
    expect(dial.admits).toHaveLength(3);
    const mint = dial.admits[2];
    expect(mint?.ops.map((o) => o.op)).toEqual([
      "createNode",
      "addEdge",
      "addEdge",
      "addEdge",
    ]);
    expect(mint?.ops.slice(1).map((o) => o.predicate)).toEqual([
      "hasName",
      "hasType",
      "parent",
    ]);
    const parentOp = mint?.ops[3];
    const root = await dial.findByName(NOTE_ROOT_KIND, NOTE_ROOT_LABEL);
    expect(parentOp?.to_node).toBe(root[0]);
    expect(mint?.scope).toBe(SCOPE);
    const edges = await dial.edges(result.node_id);
    expect(edges.map((e) => e.predicate)).toEqual([
      "hasName",
      "hasType",
      "parent",
    ]);
  });

  it("is idempotent: an identical re-run answers the standing node, no new admits", async () => {
    const dial = new FixtureChaosDial();
    const first = await createNote(dial, SCOPE, { title: "Twice" });
    if (isCreateNoteError(first)) throw new Error("first create failed");
    const before = dial.admits.length;
    const second = await createNote(dial, SCOPE, { title: "Twice" });
    if (isCreateNoteError(second)) throw new Error("second create failed");
    expect(second.node_id).toBe(first.node_id);
    expect(second.created).toBe(false);
    expect(dial.admits.length).toBe(before); // heal check read only, no writes
  });

  it("heals an interrupted mint: a dictionary row without edges gets them", async () => {
    const dial = new FixtureChaosDial();
    const orphan = "cd".repeat(32);
    dial.seed("Note", "Broken", orphan); // row exists, edges never landed
    const result = await createNote(dial, SCOPE, { title: "Broken" });
    if (isCreateNoteError(result)) throw new Error("heal path errored");
    expect(result.node_id).toBe(orphan);
    expect(result.created).toBe(false);
    const healed = await dial.edges(orphan);
    expect(healed.map((e) => e.predicate)).toEqual([
      "hasName",
      "hasType",
      "parent",
    ]);
  });

  it("honors a caller parent that exists on the dictionary", async () => {
    const dial = new FixtureChaosDial();
    const parent = "ef".repeat(32);
    dial.seed("Note", "The Parent", parent);
    const result = await createNote(dial, SCOPE, {
      title: "Child",
      parent,
    });
    if (isCreateNoteError(result)) throw new Error("create failed");
    const edges = await dial.edges(result.node_id);
    expect(edges.find((e) => e.predicate === "parent")?.value).toBe(parent);
    // no root ensure ran: only the seeded parent's seed and the note's one admit
    expect(dial.admits).toHaveLength(1);
  });

  it("rejects a malformed and an unknown parent as bad_args", async () => {
    const dial = new FixtureChaosDial();
    const malformed = await createNote(dial, SCOPE, {
      title: "X",
      parent: "not-hex",
    });
    expect(isCreateNoteError(malformed) && malformed.code).toBe("bad_args");
    const unknown = await createNote(dial, SCOPE, {
      title: "X",
      parent: "aa".repeat(32),
    });
    expect(isCreateNoteError(unknown) && unknown.code).toBe("bad_args");
  });

  it("rejects an empty title and empty tags", async () => {
    const dial = new FixtureChaosDial();
    const t = await createNote(dial, SCOPE, { title: "   " });
    expect(isCreateNoteError(t) && t.code).toBe("bad_args");
    expect(isCreateNoteError(t) && t.detail).toBe("title must be non-empty");
    const g = await createNote(dial, SCOPE, { title: "ok", tags: ["a", " "] });
    expect(isCreateNoteError(g) && g.code).toBe("bad_args");
    expect(isCreateNoteError(g) && g.detail).toBe(
      "tags must be non-empty strings",
    );
  });

  it("refuses the mint and the heal with admit_refused", async () => {
    const dial = new FixtureChaosDial();
    const parent = await createNote(dial, SCOPE, { title: "P" });
    if (isCreateNoteError(parent)) throw new Error(parent.detail);
    const real = dial.admit.bind(dial);
    const refuse = () =>
      Promise.resolve({ admitted: false, minted: [], violations: ["no"] });

    // the mint itself
    dial.admit = refuse;
    const mint = await createNote(dial, SCOPE, {
      title: "M",
      parent: parent.node_id,
    });
    expect(mint).toEqual({
      code: "admit_refused",
      detail: "the gate refused the mint",
      violations: ["no"],
    });

    // a refused admit is a refused mint even when it names a token; an admit
    // that lands none, or two, is one too
    for (const [admitted, minted] of [
      [false, ["t".repeat(64)]],
      [true, []],
      [true, ["a".repeat(64), "b".repeat(64)]],
    ] as const) {
      dial.admit = () =>
        Promise.resolve({ admitted, minted: [...minted], violations: [] });
      const bad = await createNote(dial, SCOPE, {
        title: "E",
        parent: parent.node_id,
      });
      expect(bad).toMatchObject({
        code: "admit_refused",
        detail: "the gate refused the mint",
      });
    }

    // the heal of a dictionary row that never got its edges
    dial.admit = real;
    const minted = await dial.admit([opCreate("Note", "H")], SCOPE);
    expect(minted.admitted).toBe(true);
    dial.admit = refuse;
    const heal = await createNote(dial, SCOPE, {
      title: "H",
      parent: parent.node_id,
    });
    expect(heal).toMatchObject({ code: "admit_refused", violations: ["no"] });
    expect(isCreateNoteError(heal) && heal.detail).toContain(
      "the gate refused the healing edge batch for ",
    );
  });

  it("surfaces a gate refusal with its violations, verbatim", async () => {
    const dial = new FixtureChaosDial();
    dial.refuseWith = [{ shape: "Note", missing: ["hasName"] }];
    const result = await createNote(dial, SCOPE, { title: "Refused" });
    expect(isCreateNoteError(result)).toBe(true);
    if (!isCreateNoteError(result)) return;
    expect(result.code).toBe("admit_refused");
    expect(result.violations).toEqual([
      { shape: "Note", missing: ["hasName"] },
    ]);
  });
});

// ── C9: the tag path over the fixtures ───────────────────────────────────────

import { FixtureTagStore } from "../src/tag-store.js";
import {
  HAS_TAG,
  listByTag,
  listTags,
  maybeReconcileInlineTags,
  reconcileNoteTags,
} from "../src/mcp/tools.js";

describe("the tag path (C9)", () => {
  it("create_note writes explicit tags as hasTag edges + mirror rows", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const result = await createNote(
      dial,
      SCOPE,
      { title: "Tagged", tags: ["#Journal", "brain-soup"] },
      store,
    );
    if (isCreateNoteError(result)) throw new Error("create failed");
    const edges = await dial.edges(result.node_id);
    const tags = edges
      .filter((e) => e.predicate === HAS_TAG)
      .map((e) => e.value);
    expect(tags.sort()).toEqual(["#brain-soup", "#journal"]);
    expect(await store.byNode(result.node_id)).toEqual([
      { tag: "#brain-soup", source: "explicit" },
      { tag: "#journal", source: "explicit" },
    ]);
  });

  it("inline reconcile: adds, removes, never touches explicit", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const created = await createNote(
      dial,
      SCOPE,
      { title: "R", tags: ["#journal"] },
      store,
    );
    if (isCreateNoteError(created)) throw new Error("create failed");
    const node = created.node_id;
    await reconcileNoteTags(dial, SCOPE, store, node, {
      inline: ["#a", "#b"],
    });
    await reconcileNoteTags(dial, SCOPE, store, node, {
      inline: ["#b", "#c"],
    });
    const edges = await dial.edges(node);
    const tags = edges
      .filter((e) => e.predicate === HAS_TAG)
      .map((e) => e.value);
    expect(tags.sort()).toEqual(["#b", "#c", "#journal"]);
  });

  it("the body-write hook is kind-gated: only Note-kind nodes reconcile", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const body = new FixtureBodyClient();
    // a Note node
    const created = await createNote(dial, SCOPE, { title: "N" }, store);
    if (isCreateNoteError(created)) throw new Error("create failed");
    await body.saveBody(created.node_id, [{ text: "hello #tagme" }]);
    await maybeReconcileInlineTags(body, dial, SCOPE, store, created.node_id);
    expect(
      (await dial.edges(created.node_id)).some(
        (e) => e.predicate === HAS_TAG && e.value === "#tagme",
      ),
    ).toBe(true);
    // a non-Note node: same body content, no extraction
    const work = "ab".repeat(32);
    await body.saveBody(work, [{ text: "work prose #never" }]);
    await maybeReconcileInlineTags(body, dial, SCOPE, store, work);
    expect(await dial.edges(work)).toEqual([]);
  });

  it("list_by_tag + list_tags serve the read half", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const a = await createNote(
      dial,
      SCOPE,
      { title: "A", tags: ["#x"] },
      store,
    );
    const b = await createNote(
      dial,
      SCOPE,
      { title: "B", tags: ["#x", "#y"] },
      store,
    );
    if (isCreateNoteError(a) || isCreateNoteError(b)) throw new Error("create");
    const byTag = await listByTag(dial, SCOPE, "X", false);
    expect(byTag.tag).toBe("#x");
    expect(byTag.node_ids.sort()).toEqual([a.node_id, b.node_id].sort());
    expect(await listTags(store)).toEqual({
      tags: [
        { tag: "#x", count: 2 },
        { tag: "#y", count: 1 },
      ],
    });
  });
});
