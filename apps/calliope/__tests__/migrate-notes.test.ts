/**
 * F6 — the documents→notes migration over the fixture seams: version
 * ordering, byte parity, idempotent convergence, and the parity gate's
 * failure mode.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { FixtureDocumentStore } from "../src/document-store.js";
import { migrateNotes } from "../src/mcp/migrate-notes.js";
import { sinkNoteVersion } from "../src/notes-sink.js";
import type { BodyClient } from "../src/types.js";

const SCOPE = "notes";

async function seedCorpus(store: FixtureDocumentStore): Promise<void> {
  await store.write({
    source_path: "Notes/versioned.md",
    body_text: "v1 body",
    subject: "Versioned",
  });
  await store.write({
    source_path: "Notes/versioned.md",
    body_text: "v2 body #tagged",
    subject: "Versioned",
  });
  await store.write({
    source_path: "Notes/single.md",
    body_text: "only body",
    schema_type: "Dataset",
  });
}

describe("migrateNotes (F6)", () => {
  it("migrates versions oldest-first into CoW generations with byte parity", async () => {
    const store = new FixtureDocumentStore();
    await seedCorpus(store);
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();
    const tags = new FixtureTagStore();

    const report = await migrateNotes(store, client, dial, SCOPE, tags);
    expect(report).toMatchObject({
      paths: 2,
      versions: 3,
      minted: 2,
      superseded: 1,
      nooped: 0,
      parity_mismatches: [],
    });

    // The versioned path: newest active, oldest reconstructable.
    const [node] = await dial.findByName("Note", "Notes/versioned.md");
    if (node === undefined) throw new Error("note missing");
    const body = await client.readBody(node);
    expect(body.map((s) => s.text)).toEqual(["v2 body #tagged"]);
    const revs = await client.readRevisions(node);
    expect(revs).toHaveLength(2);
    const oldest = revs.at(-1);
    if (!oldest) throw new Error("missing revision");
    expect(
      (await client.readRevisionAt(node, oldest.revision)).map((s) => s.text),
    ).toEqual(["v1 body"]);
    // Inline tags rode along.
    const edges = await dial.edges(node);
    expect(
      edges.some((e) => e.predicate === "hasTag" && e.value === "#tagged"),
    ).toBe(true);
    // schema_type preserved on the other path.
    const [single] = await dial.findByName("Note", "Notes/single.md");
    if (single === undefined) throw new Error("note missing");
    expect(
      (await dial.edges(single)).find((e) => e.predicate === "schema_type")
        ?.value,
    ).toBe("Dataset");
  });

  it("a re-run of a converged store performs zero new writes (SC-002)", async () => {
    const store = new FixtureDocumentStore();
    await seedCorpus(store);
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();
    const tags = new FixtureTagStore();
    await migrateNotes(store, client, dial, SCOPE, tags);

    const admitsBefore = dial.admits.length;
    const [node] = await dial.findByName("Note", "Notes/versioned.md");
    if (node === undefined) throw new Error("note missing");
    const eventsBefore = (await client.readRevisions(node)).length;

    const second = await migrateNotes(store, client, dial, SCOPE, tags);
    expect(second.parity_mismatches).toEqual([]);
    // The older version re-sinks as a superseding generation? NO — the sink
    // sees the ACTIVE body. v1 differs from v2, so a naive re-run would
    // thrash v1->v2 forever. The migration replays versions oldest-first,
    // so the final state converges back to v2 — but a converged store must
    // not even do that. Assert the strong form: zero new events.
    expect((await client.readRevisions(node)).length).toBe(eventsBefore);
    expect(dial.admits.length).toBe(admitsBefore);
  });

  it("archive rows split per document with isArchived + document_id edges (F7 prelude)", async () => {
    const store = new FixtureDocumentStore();
    // Two distinct documents sharing one container source_path.
    await store.write({
      source_path: "F:\\OneDrive",
      body_text: "doc one body",
      subject: "Doc One.pdf",
      file_path: "Ref\\Doc One.pdf",
      source_kind: "phdb-migration",
    });
    await store.write({
      source_path: "F:\\OneDrive",
      body_text: "doc two body",
      subject: "Doc Two.pdf",
      file_path: "Ref\\Doc Two.pdf",
      source_kind: "phdb-migration",
    });
    // A vault row keeps the F6 model untouched.
    await store.write({
      source_path: "Notes/real.md",
      body_text: "vault note",
    });
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();

    const report = await migrateNotes(store, client, dial, SCOPE);
    expect(report).toMatchObject({
      paths: 2,
      identities: 3,
      versions: 3,
      minted: 3,
      archived: 2,
      parity_mismatches: [],
    });

    // Distinct notes, composite-named, archive-flagged, id-bridged.
    const [one] = await dial.findByName(
      "Note",
      "F:\\OneDrive :: Ref\\Doc One.pdf",
    );
    const [two] = await dial.findByName(
      "Note",
      "F:\\OneDrive :: Ref\\Doc Two.pdf",
    );
    if (one === undefined || two === undefined)
      throw new Error("archive notes missing");
    expect(one).not.toBe(two);
    const edgesOne = await dial.edges(one);
    const attr = (p: string) =>
      edgesOne.find((e) => e.predicate === p && !e.isNode)?.value;
    expect(attr("isArchived")).toBe("true");
    // Provenance stays TRUTHFUL: the real container path, the real file.
    expect(attr("source_path")).toBe("F:\\OneDrive");
    expect(attr("file_path")).toBe("Ref\\Doc One.pdf");
    expect(attr("document_id")).toBe("1");
    expect((await client.readBody(one)).map((s) => s.text)).toEqual([
      "doc one body",
    ]);
    // The vault note: bare-path identity, NO archive flag.
    const [vault] = await dial.findByName("Note", "Notes/real.md");
    if (vault === undefined) throw new Error("vault note missing");
    const vaultEdges = await dial.edges(vault);
    expect(vaultEdges.some((e) => e.predicate === "isArchived")).toBe(false);

    // Re-run: zero deltas (identity-grain convergence).
    const admits = dial.admits.length;
    const second = await migrateNotes(store, client, dial, SCOPE);
    expect(second.nooped).toBe(3);
    expect(second.unwound).toEqual([]);
    expect(dial.admits.length).toBe(admits);
  });

  it("unwinds the F6-era mega-note: edges retracted, rows deleted, idempotent", async () => {
    const store = new FixtureDocumentStore();
    await store.write({
      source_path: "F:\\OneDrive",
      body_text: "doc body",
      subject: "Doc.pdf",
      file_path: "Ref\\Doc.pdf",
      source_kind: "phdb-migration",
    });
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();

    // Simulate the F6 run: a mega-note keyed on the bare container path,
    // plus the substrate's own tenancy edge (ownedBy — system-written, not
    // the sink's; the unwind must leave it alone).
    const mega = await sinkNoteVersion(client, dial, SCOPE, undefined, {
      source_path: "F:\\OneDrive",
      body_text: "doc body",
      source_kind: "phdb-migration",
    });
    await dial.admit(
      [
        {
          op: "addEdge",
          from_id: mega.node_id,
          predicate: "ownedBy",
          to_literal: null,
          to_node: "0".repeat(64),
        },
      ],
      SCOPE,
    );
    expect((await dial.edges(mega.node_id)).length).toBeGreaterThan(0);

    const deleted: string[] = [];
    const report = await migrateNotes(
      store,
      client,
      dial,
      SCOPE,
      undefined,
      (nodeId) => {
        deleted.push(nodeId);
        return Promise.resolve();
      },
    );
    expect(report.unwound).toEqual(["F:\\OneDrive"]);
    expect(deleted).toEqual([mega.node_id]);
    // The graph half: every SINK-owned edge retracted; system edges (the
    // substrate's ownedBy tenancy stamp) are not ours and survive — the
    // allowlist that ends the phantom re-unwind loop measured live.
    expect((await dial.edges(mega.node_id)).map((e) => e.predicate)).toEqual([
      "ownedBy",
    ]);
    // The replacement exists under the composite identity.
    const [fresh] = await dial.findByName(
      "Note",
      "F:\\OneDrive :: Ref\\Doc.pdf",
    );
    expect(fresh).toBeDefined();

    // Idempotent: a re-run unwinds nothing and deletes nothing new.
    const second = await migrateNotes(
      store,
      client,
      dial,
      SCOPE,
      undefined,
      (nodeId) => {
        deleted.push(nodeId);
        return Promise.resolve();
      },
    );
    expect(second.unwound).toEqual([]);
  });

  it("the parity gate reports a store that drops writes", async () => {
    const store = new FixtureDocumentStore();
    await store.write({ source_path: "Notes/x.md", body_text: "real" });
    const dial = new FixtureChaosDial();
    // A body client that swallows saves — the failure the gate exists for.
    const broken: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    const report = await migrateNotes(store, broken, dial, SCOPE);
    expect(report.parity_mismatches).toEqual(["Notes/x.md"]);
  });
});
