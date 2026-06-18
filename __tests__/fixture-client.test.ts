import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { compareKeys } from "../src/order-key.js";

describe("FixtureBodyClient", () => {
  it("returns [] for an unknown node", async () => {
    const client = new FixtureBodyClient();
    expect(await client.readBody("missing")).toEqual([]);
  });

  it("round-trips a saved body in display order", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [
      { text: "## Heading" },
      { text: "alpha" },
      { text: "beta" },
    ]);
    const body = await client.readBody("n1");
    expect(body.map((s) => s.text)).toEqual(["## Heading", "alpha", "beta"]);
  });

  it("assigns ascending, byte-sortable order keys", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "a" }, { text: "b" }, { text: "c" }]);
    const body = await client.readBody("n1");
    const keys = body.map((s) => s.orderKey);
    const sorted = [...keys].sort(compareKeys);
    expect(sorted).toEqual(keys);
  });

  it("mints distinct placement ids (not content-addressed)", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "dup" }, { text: "dup" }]);
    const body = await client.readBody("n1");
    expect(body[0]?.id).not.toBe(body[1]?.id);
    expect(body[0]?.text).toBe(body[1]?.text);
  });

  it("a re-save replaces the whole body", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "old" }]);
    await client.saveBody("n1", [{ text: "new1" }, { text: "new2" }]);
    const body = await client.readBody("n1");
    expect(body.map((s) => s.text)).toEqual(["new1", "new2"]);
  });

  it("seeds bodies from the constructor", async () => {
    const client = new FixtureBodyClient({
      n1: [{ text: "seeded" }],
    });
    expect((await client.readBody("n1")).map((s) => s.text)).toEqual([
      "seeded",
    ]);
  });

  it("isolates bodies per node id", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("a", [{ text: "in a" }]);
    await client.saveBody("b", [{ text: "in b" }]);
    expect((await client.readBody("a")).map((s) => s.text)).toEqual(["in a"]);
    expect((await client.readBody("b")).map((s) => s.text)).toEqual(["in b"]);
  });
});
