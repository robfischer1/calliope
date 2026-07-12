/**
 * A8 — the revision reads: fixture-client lineage recording and the
 * read_body_revisions / read_body_at tool handlers (capability guard
 * included). The PG reconstruction has its own docker-gated coverage in
 * pg-client.test.ts; this file pins the wire contract store-free.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { readBodyAt, readBodyRevisions } from "../src/mcp/tools.js";
import type { BodyClient } from "../src/types.js";

async function lineage(client: FixtureBodyClient): Promise<void> {
  await client.saveBody("n1", [{ text: "a" }, { text: "b" }]);
  const v1 = await client.readBody("n1");
  const target = v1.at(1);
  if (target === undefined) throw new Error("missing section");
  await client.editSection("n1", target.id, "b-edited");
  await client.saveBody("n1", [{ text: "final" }]);
}

describe("FixtureBodyClient revisions (A8)", () => {
  it("records save/edit events newest first with counts", async () => {
    const client = new FixtureBodyClient();
    await lineage(client);
    const revs = await client.readRevisions("n1");
    expect(revs.map((r) => r.kind)).toEqual(["save", "edit", "save"]);
    expect(revs.map((r) => r.sections)).toEqual([1, 1, 2]);
    const stamps = revs.map((r) => r.revision);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("reconstructs the body as of each event", async () => {
    const client = new FixtureBodyClient();
    await lineage(client);
    const [atFinal, atEdit, atFirst] = await client.readRevisions("n1");
    if (!atFinal || !atEdit || !atFirst) throw new Error("missing revisions");
    expect(
      (await client.readRevisionAt("n1", atFirst.revision)).map((s) => s.text),
    ).toEqual(["a", "b"]);
    expect(
      (await client.readRevisionAt("n1", atEdit.revision)).map((s) => s.text),
    ).toEqual(["a", "b-edited"]);
    expect(
      (await client.readRevisionAt("n1", atFinal.revision)).map((s) => s.text),
    ).toEqual(["final"]);
    expect(
      await client.readRevisionAt("n1", "2000-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("honors the limit and an unknown node", async () => {
    const client = new FixtureBodyClient();
    await lineage(client);
    expect(await client.readRevisions("n1", 2)).toHaveLength(2);
    expect(await client.readRevisions("nope")).toEqual([]);
  });
});

describe("read_body_revisions / read_body_at handlers", () => {
  it("round-trip through the tool layer", async () => {
    const client = new FixtureBodyClient();
    await lineage(client);
    const { revisions } = await readBodyRevisions(client, "n1");
    expect(revisions).toHaveLength(3);
    const oldest = revisions.at(-1);
    if (oldest === undefined) throw new Error("missing revision");
    const at = await readBodyAt(client, "n1", oldest.revision);
    expect(at.revision).toBe(oldest.revision);
    expect(at.sections.map((s) => s.text)).toEqual(["a", "b"]);
    for (const s of at.sections) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.orderKey).toBe("string");
    }
  });

  it("rejects clearly when the backend lacks the capability", async () => {
    const bare: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    await expect(readBodyRevisions(bare, "n1")).rejects.toThrow(
      /does not support revision reads/,
    );
    await expect(
      readBodyAt(bare, "n1", "2026-01-01T00:00:00Z"),
    ).rejects.toThrow(/does not support revision reads/);
  });
});

describe("IndexingBodyClient passes the revision capability through (A8)", () => {
  it("forwards readRevisions/readRevisionAt from a capable inner client", async () => {
    const { IndexingBodyClient } = await import("../src/mcp/index-push.js");
    const inner = new FixtureBodyClient();
    await lineage(inner);
    const wrapped = new IndexingBodyClient(inner, {
      indexDocument: () => Promise.resolve(),
    });
    expect(wrapped.readRevisions).toBeDefined();
    const revs = await readBodyRevisions(wrapped, "n1");
    expect(revs.revisions).toHaveLength(3);
    const oldest = revs.revisions.at(-1);
    if (oldest === undefined) throw new Error("missing revision");
    const at = await readBodyAt(wrapped, "n1", oldest.revision);
    expect(at.sections.map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("keeps the capability absent when the inner client lacks it", async () => {
    const { IndexingBodyClient } = await import("../src/mcp/index-push.js");
    const bare: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    const wrapped = new IndexingBodyClient(bare, {
      indexDocument: () => Promise.resolve(),
    });
    expect(wrapped.readRevisions).toBeUndefined();
    await expect(readBodyRevisions(wrapped, "n1")).rejects.toThrow(
      /does not support revision reads/,
    );
  });
});
