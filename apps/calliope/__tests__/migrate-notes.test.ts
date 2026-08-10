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
