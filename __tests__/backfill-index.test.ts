import { describe, expect, it } from "vitest";

import {
  backfillIndex,
  type BackfillSource,
} from "../src/mcp/backfill-index.js";
import type { IndexPusher } from "../src/mcp/index-push.js";
import type { Section } from "../src/types.js";

class RecordingPusher implements IndexPusher {
  calls: { node: string; body: string }[] = [];
  failOn?: string;

  indexDocument(node: string, body: string): Promise<void> {
    if (node === this.failOn) return Promise.reject(new Error("push boom"));
    this.calls.push({ node, body });
    return Promise.resolve();
  }
}

/** A source over an in-memory `{ nodeId: [sectionTexts] }` map. */
function source(bodies: Record<string, string[]>): BackfillSource {
  return {
    listBodyNodeIds: () => Promise.resolve(Object.keys(bodies)),
    readBody: (nodeId) =>
      Promise.resolve(
        (bodies[nodeId] ?? []).map((text, i): Section => ({
          id: `${nodeId}#${String(i)}`,
          text,
          orderKey: String(i),
        })),
      ),
  };
}

describe("backfillIndex — the one-off existing-body sweep", () => {
  it("pushes each body-bearing node's assembled prose", async () => {
    const pusher = new RecordingPusher();
    const res = await backfillIndex(
      source({ a: ["one", "two"], b: ["solo"] }),
      pusher,
    );
    expect(res).toEqual({ nodes: 2, pushed: 2, failed: 0 });
    expect(pusher.calls).toEqual([
      { node: "a", body: "one\n\ntwo" },
      { node: "b", body: "solo" },
    ]);
  });

  it("probe mode counts without pushing", async () => {
    const pusher = new RecordingPusher();
    const res = await backfillIndex(source({ a: ["x"], b: ["y"] }), pusher, {
      probe: true,
    });
    expect(res).toEqual({ nodes: 2, pushed: 0, failed: 0 });
    expect(pusher.calls).toEqual([]);
  });

  it("tallies a failed push and continues the sweep", async () => {
    const pusher = new RecordingPusher();
    pusher.failOn = "a";
    const res = await backfillIndex(source({ a: ["x"], b: ["y"] }), pusher);
    expect(res).toEqual({ nodes: 2, pushed: 1, failed: 1 });
    expect(pusher.calls).toEqual([{ node: "b", body: "y" }]);
  });
});
