import { describe, expect, it } from "vitest";

import { FixtureBodyClient } from "../src/fixture-client.js";
import { makeBodyClient } from "../src/mcp/backend.js";
import { IndexingBodyClient, type IndexPusher } from "../src/mcp/index-push.js";
import type { BodyClient } from "../src/types.js";

/** Records every index push (or fails on demand) for assertions. */
class RecordingPusher implements IndexPusher {
  calls: { node: string; body: string }[] = [];
  fail = false;

  indexDocument(node: string, body: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error("push boom"));
    this.calls.push({ node, body });
    return Promise.resolve();
  }
}

describe("IndexingBodyClient — the write-side body push (B)", () => {
  it("pushes the assembled body after saveBody", async () => {
    const pusher = new RecordingPusher();
    const client = new IndexingBodyClient(new FixtureBodyClient(), pusher);

    await client.saveBody("node-1", [{ text: "alpha" }, { text: "beta" }]);

    expect(pusher.calls).toEqual([{ node: "node-1", body: "alpha\n\nbeta" }]);
  });

  it("pushes the WHOLE reassembled body after editSection", async () => {
    const pusher = new RecordingPusher();
    const client = new IndexingBodyClient(new FixtureBodyClient(), pusher);
    await client.saveBody("n", [{ text: "one" }, { text: "two" }]);

    const [first] = await client.readBody("n");
    if (first === undefined) throw new Error("expected a section");
    pusher.calls = [];

    await client.editSection?.("n", first.id, "ONE");

    expect(pusher.calls).toEqual([{ node: "n", body: "ONE\n\ntwo" }]);
  });

  it("does not expose editSection when the inner client lacks it", () => {
    const inner: BodyClient = {
      readBody: () => Promise.resolve([]),
      saveBody: () => Promise.resolve(),
    };
    const client = new IndexingBodyClient(inner, new RecordingPusher());

    expect(client.editSection).toBeUndefined();
  });

  it("swallows a push failure — the body write still resolves", async () => {
    const pusher = new RecordingPusher();
    pusher.fail = true;
    const client = new IndexingBodyClient(new FixtureBodyClient(), pusher);

    await expect(
      client.saveBody("n", [{ text: "x" }]),
    ).resolves.toBeUndefined();
  });

  it("passes readBody through without pushing", async () => {
    const pusher = new RecordingPusher();
    const inner = new FixtureBodyClient();
    await inner.saveBody("n", [{ text: "y" }]);
    const client = new IndexingBodyClient(inner, pusher);

    const sections = await client.readBody("n");

    expect(sections.map((s) => s.text)).toEqual(["y"]);
    expect(pusher.calls).toEqual([]);
  });
});

describe("makeBodyClient — index-push wiring", () => {
  it("wraps the urania backend when a urania URL is configured", () => {
    const client = makeBodyClient("urania", {
      URANIA_URL: "http://urania:8206",
    });
    expect(client).toBeInstanceOf(IndexingBodyClient);
  });

  it("does not wrap when no urania endpoint is configured", () => {
    const client = makeBodyClient("urania", {});
    expect(client).not.toBeInstanceOf(IndexingBodyClient);
  });

  it("does not wrap the hades backend (the server-side push owns it)", () => {
    const client = makeBodyClient("hades", {
      CHARON_URL: "http://charon",
      URANIA_URL: "http://urania:8206",
    });
    expect(client).not.toBeInstanceOf(IndexingBodyClient);
  });
});
