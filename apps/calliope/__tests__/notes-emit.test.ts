/**
 * Findability F8 (spec 035) — the eros emit path: the wire event's shape,
 * lazy connect, keying, fan-out independence, and the env gate.
 */
import { describe, expect, it } from "vitest";
import {
  ErosNotesPusher,
  fanOutPushers,
  NOTES_TOPIC,
  notesEmitEnabled,
  type NotesProducer,
} from "../src/mcp/notes-emit.js";

class FakeProducer implements NotesProducer {
  connects = 0;
  sends: { topic: string; messages: { key: string; value: string }[] }[] = [];
  connect(): Promise<void> {
    this.connects += 1;
    return Promise.resolve();
  }
  send(record: {
    topic: string;
    messages: { key: string; value: string }[];
  }): Promise<unknown> {
    this.sends.push(record);
    return Promise.resolve(undefined);
  }
}

describe("ErosNotesPusher", () => {
  it("emits the eros wire contract, keyed by the node", async () => {
    const producer = new FakeProducer();
    const pusher = new ErosNotesPusher(producer);
    await pusher.indexDocument("ab".repeat(32), "the assembled prose");
    expect(producer.sends).toHaveLength(1);
    const record = producer.sends[0];
    expect(record?.topic).toBe(NOTES_TOPIC);
    expect(record?.messages[0]?.key).toBe("ab".repeat(32));
    const event = JSON.parse(record?.messages[0]?.value ?? "{}") as {
      node_id: string;
      body_text: string;
      ts: string;
      schema_version: number;
    };
    expect(event.node_id).toBe("ab".repeat(32));
    expect(event.body_text).toBe("the assembled prose");
    expect(event.schema_version).toBe(1);
    expect(Date.parse(event.ts)).not.toBeNaN();
  });

  it("connects once, lazily", async () => {
    const producer = new FakeProducer();
    const pusher = new ErosNotesPusher(producer);
    expect(producer.connects).toBe(0);
    await pusher.indexDocument("n", "a");
    await pusher.indexDocument("n", "b");
    expect(producer.connects).toBe(1);
    expect(producer.sends).toHaveLength(2);
  });
});

describe("fanOutPushers", () => {
  it("one failing projection never stops the other", async () => {
    const seen: string[] = [];
    const good = {
      indexDocument: (node: string): Promise<void> => {
        seen.push(node);
        return Promise.resolve();
      },
    };
    const bad = {
      indexDocument: (): Promise<void> =>
        Promise.reject(new Error("projection down")),
    };
    await fanOutPushers([bad, good]).indexDocument("n1", "body");
    expect(seen).toEqual(["n1"]);
  });

  it("throws only when EVERY projection failed (the decorator swallows it)", async () => {
    const bad = {
      indexDocument: (): Promise<void> => Promise.reject(new Error("down")),
    };
    await expect(
      fanOutPushers([bad, bad]).indexDocument("n", "b"),
    ).rejects.toThrow(/all index pushes failed/);
  });
});

describe("notesEmitEnabled", () => {
  it("is an explicit opt-in", () => {
    expect(notesEmitEnabled({})).toBe(false);
    expect(notesEmitEnabled({ CALLIOPE_NOTES_EMIT: "0" })).toBe(false);
    expect(notesEmitEnabled({ CALLIOPE_NOTES_EMIT: "1" })).toBe(true);
  });
});
