/**
 * Stream of Consciousness pass 4 (specs 048 + 049) — the consciousness
 * producer: the row identity is eros's (pinned against eros-computed
 * vectors), the metadata vocabulary is absent-not-empty, the wire carries the
 * 63-bit id as an integer literal, a publish failure is counted and never
 * thrown, and the emit is default-on with a loud off.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  CONSCIOUSNESS_TOPIC,
  ConsciousnessPublisher,
  METADATA_KEYS,
  consciousnessEmitEnabled,
  consciousnessMetrics,
  escalates,
  noteEvent,
  recordSourceId,
  resetConsciousnessMetrics,
  styxRef,
  wireKey,
  wireValue,
  type NoteProjection,
  type WireProducer,
} from "../src/mcp/consciousness-emit.js";

class FakeProducer implements WireProducer {
  connects = 0;
  sends: { topic: string; messages: { key: string; value: string }[] }[] = [];
  fail = false;
  connect(): Promise<void> {
    this.connects += 1;
    return Promise.resolve();
  }
  send(record: {
    topic: string;
    messages: { key: string; value: string }[];
  }): Promise<unknown> {
    if (this.fail) return Promise.reject(new Error("broker down"));
    this.sends.push(record);
    return Promise.resolve(undefined);
  }
}

const NODE = "ab".repeat(32);
const NOW = new Date("2026-09-05T21:00:00.000Z");

const full: NoteProjection = {
  node: NODE,
  body: "# Idea\n\nfirst",
  title: "Idea",
  sourcePath: "Brain Soup/Idea.md",
  tags: ["beta", "alpha", "alpha"],
  revision: 3,
  authorKind: "human",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-04T00:00:00Z",
  lifecycle: "active",
  schemaType: "Note",
};

describe("the row identity is eros's", () => {
  // Computed 2026-09-05 with eros.keys.record_source_id (blake2b-8 of the
  // styx ref, masked to 63 bits) — the SAME vectors on both sides of the seam.
  it.each([
    ["ab".repeat(32), "3541846425442797356"],
    ["cd".repeat(32), "2341581022270581932"],
    ["0123456789abcdef".repeat(4), "7442564788381397842"],
  ])("record_source_id(styx://%s…) matches eros", (node, want) => {
    expect(recordSourceId(styxRef(node)).toString()).toBe(want);
  });

  it("refuses a node that is not a chaos token", () => {
    expect(() => styxRef("not-a-token")).toThrow(/not a chaos token/);
    expect(styxRef(" AB".repeat(1) + "ab".repeat(31) + " ")).toBe(
      `styx://${NODE}`,
    );
  });
});

describe("noteEvent — the vocabulary", () => {
  it("carries every documented key when the note has it", () => {
    const event = noteEvent(full, NOW);
    expect(event.source_star).toBe("calliope");
    expect(event.source_table).toBe("calliope_notes");
    expect(event.schema_type).toBe("Note");
    expect(event.schema_version).toBe("1.0.0");
    expect(event.content).toBe("# Idea\n\nfirst");
    expect(event.source_ref).toBe(`styx://${NODE}`);
    expect(event.metadata).toEqual({
      title: "Idea",
      date_sent: "2026-09-04T00:00:00Z",
      source_path: "Brain Soup/Idea.md",
      tags: ["alpha", "beta"],
      container: NODE,
      revision: 3,
      author_kind: "human",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-04T00:00:00Z",
      lifecycle: "active",
      schema_type: "Note",
    });
    for (const key of Object.keys(event.metadata)) {
      expect(METADATA_KEYS).toContain(key);
    }
  });

  it("leaves a key ABSENT rather than empty when the note has none", () => {
    const event = noteEvent({ node: NODE, body: "prose", tags: [] }, NOW);
    expect(Object.keys(event.metadata).sort()).toEqual([
      "container",
      "date_sent",
    ]);
    // No local timestamp: the publish instant stands in for the date arm.
    expect(event.metadata.date_sent).toBe(NOW.toISOString());
  });
});

describe("the wire", () => {
  it("keys on <table>:<id> and writes the id as an integer literal", () => {
    const event = noteEvent(full, NOW);
    expect(wireKey(event)).toBe("calliope_notes:3541846425442797356");
    const value = wireValue(event);
    expect(value).toContain('"source_id":3541846425442797356,');
    // Round-trips as a document (the id is the only field JSON.parse would
    // round, and the consumer reads it as an int).
    const parsed = JSON.parse(value) as Record<string, unknown>;
    expect(parsed.source_table).toBe("calliope_notes");
    expect(parsed.content).toBe("# Idea\n\nfirst");
    expect((parsed.metadata as Record<string, unknown>).tags).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("ConsciousnessPublisher", () => {
  beforeEach(() => {
    resetConsciousnessMetrics();
  });

  it("publishes on consciousness, keyed by the row, connecting once", async () => {
    const producer = new FakeProducer();
    const publisher = new ConsciousnessPublisher(producer, { now: () => NOW });
    expect(await publisher.publish(full)).toBe(true);
    expect(await publisher.publish({ ...full, body: "changed" })).toBe(true);
    expect(producer.connects).toBe(1);
    expect(producer.sends).toHaveLength(2);
    expect(producer.sends[0]?.topic).toBe(CONSCIOUSNESS_TOPIC);
    expect(producer.sends[0]?.messages[0]?.key).toBe(
      "calliope_notes:3541846425442797356",
    );
    expect(consciousnessMetrics()).toEqual({
      calliope_consciousness_published_total: 2,
      calliope_consciousness_publish_failed_total: 0,
      calliope_consciousness_publisher_wired: 1,
    });
  });

  it("counts a refusal and never throws", async () => {
    const producer = new FakeProducer();
    producer.fail = true;
    const publisher = new ConsciousnessPublisher(producer, { now: () => NOW });
    expect(await publisher.publish(full)).toBe(false);
    expect(
      consciousnessMetrics().calliope_consciousness_publish_failed_total,
    ).toBe(1);
    // A bad token is a compile failure — counted the same way.
    expect(await publisher.publish({ node: "nope", body: "x" })).toBe(false);
    expect(
      consciousnessMetrics().calliope_consciousness_publish_failed_total,
    ).toBe(2);
  });

  it("escalates on the 1-2-5 series", () => {
    const loud = [];
    for (let n = 1; n <= 100; n += 1) if (escalates(n)) loud.push(n);
    expect(loud).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });
});

describe("consciousnessEmitEnabled", () => {
  it("is ON when the fleet hands the process a broker, OFF only explicitly", () => {
    expect(consciousnessEmitEnabled({})).toBe(false);
    expect(consciousnessEmitEnabled({ KAFKA_BOOTSTRAP: "pontus:29092" })).toBe(
      true,
    );
    expect(
      consciousnessEmitEnabled({
        KAFKA_BOOTSTRAP: "pontus:29092",
        CALLIOPE_CONSCIOUSNESS_EMIT: "0",
      }),
    ).toBe(false);
  });

  it("does not report a writer it does not have", () => {
    resetConsciousnessMetrics();
    expect(consciousnessMetrics().calliope_consciousness_publisher_wired).toBe(
      0,
    );
  });
});
