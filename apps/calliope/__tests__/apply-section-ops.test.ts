/**
 * A11 — the `apply_section_ops` tool wrapper (wire decode + capability
 * guard) over the fixture backend, and the fixture engine's transactional
 * semantics (the snapshot-based half of the contract the pg tests pin
 * against real postgres).
 */
import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { applySectionOps, writeBody } from "../src/mcp/tools.js";
import type { BodyClient } from "../src/types.js";

async function seeded(): Promise<FixtureBodyClient> {
  const client = new FixtureBodyClient();
  await writeBody(client, "n1", [
    { text: "alpha" },
    { text: "beta" },
    { text: "gamma" },
  ]);
  return client;
}

describe("apply_section_ops tool — over FixtureBodyClient", () => {
  it("decodes wire ops (snake_case) and applies at block grain", async () => {
    const client = await seeded();
    const body = (await client.readBody("n1")).map((s) => s.id);
    const [alphaId, betaId] = body;
    if (!alphaId || !betaId) throw new Error("fixture body missing");

    const result = await applySectionOps(client, "n1", [
      { op: "update", section_id: betaId, text: "beta edited" },
      { op: "add", text: "wedged", order_key: "015" },
      { op: "delete", section_id: alphaId },
    ]);
    expect(result.sections.map((s) => s.text)).toEqual([
      "wedged",
      "beta edited",
      "gamma",
    ]);
    expect(result.applied).toHaveLength(3);
    // The revision surface records one "ops" event with the op count.
    const revs = await client.readRevisions("n1");
    expect(revs.at(0)).toMatchObject({ kind: "ops", sections: 3 });
  });

  it("update carrying order_key relocates (edit+move, one gesture)", async () => {
    const client = await seeded();
    const body = await client.readBody("n1");
    const alpha = body.at(0);
    if (alpha === undefined) throw new Error("fixture body missing");
    const result = await applySectionOps(client, "n1", [
      {
        op: "update",
        section_id: alpha.id,
        text: "alpha edited",
        order_key: "09",
      },
    ]);
    expect(result.sections.map((s) => s.text)).toEqual([
      "beta",
      "gamma",
      "alpha edited",
    ]);
  });

  it("rejects a malformed wire op naming the index and field", async () => {
    const client = await seeded();
    await expect(
      applySectionOps(client, "n1", [{ op: "add", text: "no key" }]),
    ).rejects.toThrow(/op\[0\].*order_key/);
    await expect(
      applySectionOps(client, "n1", [{ op: "delete" }]),
    ).rejects.toThrow(/op\[0\].*section_id/);
  });

  it("stale section_id rejects the whole batch (nothing applied)", async () => {
    const client = await seeded();
    const body = await client.readBody("n1");
    const alpha = body.at(0);
    if (alpha === undefined) throw new Error("fixture body missing");
    await expect(
      applySectionOps(client, "n1", [
        { op: "update", section_id: alpha.id, text: "x" },
        { op: "reorder", section_id: "nope", order_key: "9" },
      ]),
    ).rejects.toThrow(/stale_section/);
    expect((await client.readBody("n1")).map((s) => s.text)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("guards a backend without the capability with a clear error", async () => {
    const bare: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    await expect(
      applySectionOps(bare, "n1", [{ op: "delete", section_id: "s" }]),
    ).rejects.toThrow(/does not support/);
  });

  it("readRevisionAt reconstructs across ops events (snapshot fixture)", async () => {
    const client = await seeded();
    const body = await client.readBody("n1");
    const beta = body.at(1);
    if (beta === undefined) throw new Error("fixture body missing");
    await applySectionOps(client, "n1", [
      { op: "delete", section_id: beta.id },
    ]);
    const revs = await client.readRevisions("n1");
    const [atOps, atSave] = revs;
    if (!atOps || !atSave) throw new Error("missing revisions");
    expect(
      (await client.readRevisionAt("n1", atSave.revision)).map((s) => s.text),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      (await client.readRevisionAt("n1", atOps.revision)).map((s) => s.text),
    ).toEqual(["alpha", "gamma"]);
  });
});
