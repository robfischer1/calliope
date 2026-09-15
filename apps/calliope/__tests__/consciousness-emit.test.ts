/**
 * Stream of Consciousness pass 4 (specs 048 + 049), moved onto
 * `@forge/stellar-core-ts/kafkatopics` (wonka-048) — the consciousness
 * producer: the row identity is eros's (pinned against eros-computed
 * vectors), the metadata vocabulary is absent-not-empty, the wire carries the
 * 63-bit id as an integer literal (now via the contract's own `record`/
 * `produce`, not a hand-rolled splice), a publish failure — broker or a
 * schema/producer-check refusal — is counted and never thrown, and the emit
 * is default-on with a loud off.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  decode,
  KafkaJsTransport,
  type Transport,
} from "@forge/stellar-core-ts/kafkatopics";
import {
  CONSCIOUSNESS_CLIENT_ID,
  CONSCIOUSNESS_TOPIC,
  ConsciousnessPublisher,
  METADATA_KEYS,
  consciousnessEmitEnabled,
  consciousnessMetrics,
  escalates,
  makeConsciousnessPublisher,
  makeConsciousnessTransport,
  noteEvent,
  recordSourceId,
  resetConsciousnessMetrics,
  styxRef,
  wireKey,
  wireValue,
  type NoteProjection,
} from "../src/mcp/consciousness-emit.js";

class FakeTransport implements Transport {
  produced: { topic: string; key: string; value: string | null }[] = [];
  fail = false;
  produce(
    topic: string,
    key: string,
    value: string | null,
  ): void | Promise<void> {
    if (this.fail) return Promise.reject(new Error("broker down"));
    this.produced.push({ topic, key, value });
    return Promise.resolve();
  }
}

/** `wireValue` returns `string | null` (`record`'s shared shape with a
 *  tombstone); every call here builds a real event, so narrow instead of
 *  asserting past it. */
function wireValueString(event: ReturnType<typeof noteEvent>): string {
  const value = wireValue(event);
  if (value === null) throw new Error("expected a value, not a tombstone");
  return value;
}

/** `vi.spyOn(process.stderr, "write")`, muted. A named function (rather than
 *  inlining this at each call site) so every spy variable's type is
 *  `ReturnType<typeof spyOnStderr>` — TS's own inference for `write`'s
 *  overloaded signature, not the broader (and here mismatched) ambient
 *  `ReturnType<typeof vi.spyOn>`. */
function spyOnStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

  it("treats a blank title, source path or schema type as absent, not empty", () => {
    const event = noteEvent(
      { node: NODE, body: "prose", title: "", sourcePath: "", schemaType: "" },
      NOW,
    );
    expect(event.metadata.title).toBeUndefined();
    expect(event.metadata.source_path).toBeUndefined();
    expect(event.metadata.schema_type).toBeUndefined();
    expect(Object.keys(event.metadata).sort()).toEqual([
      "container",
      "date_sent",
    ]);
  });
});

describe("the wire — contract-encoded", () => {
  it("keys on <table>:<id>, matching the contract's own consciousness key rule", () => {
    const event = noteEvent(full, NOW);
    expect(wireKey(event)).toBe("calliope_notes:3541846425442797356");
  });

  it("writes the id as a raw integer literal, never a rounded JS number", () => {
    const event = noteEvent(full, NOW);
    const value = wireValueString(event);
    expect(value).toContain('"source_id":3541846425442797356,');
    // Round-trips as a document (the id is the only field a JS number would
    // round, and the consumer reads it as an int).
    const parsed = JSON.parse(value) as Record<string, unknown>;
    expect(parsed.source_table).toBe("calliope_notes");
    expect(parsed.content).toBe("# Idea\n\nfirst");
    expect((parsed.metadata as Record<string, unknown>).tags).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("passes the contract's schema validation and producer checks — never a refusal for a value this producer builds", () => {
    // `check`/`record` throw on a schema or producer-check refusal; a note
    // this producer's own vocabulary can build must never trip one — a
    // refusal here would be a real bug (see the module doc), not something
    // this test tolerates.
    expect(() => wireValue(noteEvent(full, NOW))).not.toThrow();
    expect(() =>
      wireValue(noteEvent({ node: NODE, body: "" }, NOW)),
    ).not.toThrow();
  });

  it("decodes back through the contract's own decode — what every real consumer (eros) parses", () => {
    const event = noteEvent(full, NOW);
    const decoded = decode(CONSCIOUSNESS_TOPIC, wireValueString(event));
    expect(decoded).toEqual(event);
  });
});

describe("ConsciousnessPublisher", () => {
  beforeEach(() => {
    resetConsciousnessMetrics();
  });

  it("publishes on consciousness, keyed by the row", async () => {
    const transport = new FakeTransport();
    const publisher = new ConsciousnessPublisher(transport, { now: () => NOW });
    expect(await publisher.publish(full)).toBe(true);
    expect(await publisher.publish({ ...full, body: "changed" })).toBe(true);
    expect(transport.produced).toHaveLength(2);
    expect(transport.produced[0]?.topic).toBe(CONSCIOUSNESS_TOPIC);
    expect(transport.produced[0]?.key).toBe(
      "calliope_notes:3541846425442797356",
    );
    expect(transport.produced[0]?.value).toBe(
      wireValueString(noteEvent(full, NOW)),
    );
    expect(consciousnessMetrics()).toEqual({
      calliope_consciousness_published_total: 2,
      calliope_consciousness_publish_failed_total: 0,
      calliope_consciousness_publisher_wired: 1,
    });
  });

  it("defaults `now` to the wall clock when the caller supplies none", async () => {
    const transport = new FakeTransport();
    const publisher = new ConsciousnessPublisher(transport);
    // No `updatedAt`: `noteEvent` falls through to `now().toISOString()`, so
    // a broken default (never called, or not a function) surfaces here.
    expect(await publisher.publish({ node: NODE, body: "prose" })).toBe(true);
    expect(transport.produced).toHaveLength(1);
    expect(
      consciousnessMetrics().calliope_consciousness_publish_failed_total,
    ).toBe(0);
  });

  describe("failure accounting", () => {
    let stderrSpy: ReturnType<typeof spyOnStderr>;

    beforeEach(() => {
      stderrSpy = spyOnStderr();
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("counts a broker refusal, logs the broker's own reason, and never throws", async () => {
      const transport = new FakeTransport();
      transport.fail = true;
      const publisher = new ConsciousnessPublisher(transport, {
        now: () => NOW,
      });

      expect(await publisher.publish(full)).toBe(false);
      expect(
        consciousnessMetrics().calliope_consciousness_publish_failed_total,
      ).toBe(1);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
        "calliope-consciousness: note abababababababab did NOT reach the" +
          " index — broker down (1 failed publish(es) since start; the" +
          " index is behind)\n",
      );
    });

    it("counts a bad token as a compile failure, logging ITS OWN reason (not a downstream one)", async () => {
      const transport = new FakeTransport();
      const publisher = new ConsciousnessPublisher(transport, {
        now: () => NOW,
      });

      expect(await publisher.publish({ node: "nope", body: "x" })).toBe(false);
      expect(
        consciousnessMetrics().calliope_consciousness_publish_failed_total,
      ).toBe(1);
      expect(transport.produced).toHaveLength(0);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain(
        "not a chaos token: nope",
      );
    });

    it("truncates the node in the log line — never the full 64-char token", async () => {
      const transport = new FakeTransport();
      transport.fail = true;
      const publisher = new ConsciousnessPublisher(transport, {
        now: () => NOW,
      });

      await publisher.publish(full);
      const logged = String(stderrSpy.mock.calls[0]?.[0]);
      expect(logged).toContain(NODE.slice(0, 16));
      expect(logged).not.toContain(NODE);
    });

    it("logs only on the 1-2-5 series, not on every failure", async () => {
      const transport = new FakeTransport();
      transport.fail = true;
      const publisher = new ConsciousnessPublisher(transport, {
        now: () => NOW,
      });

      await publisher.publish(full); // failure 1 — escalates(1): logs
      await publisher.publish(full); // failure 2 — escalates(2): logs
      await publisher.publish(full); // failure 3 — escalates(3) is false: silent
      expect(
        consciousnessMetrics().calliope_consciousness_publish_failed_total,
      ).toBe(3);
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("escalates on the 1-2-5 series", () => {
    expect(escalates(0)).toBe(false);
    const loud = [];
    for (let n = 1; n <= 100; n += 1) if (escalates(n)) loud.push(n);
    expect(loud).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });
});

describe("consciousnessEmitEnabled", () => {
  it("is ON when the fleet hands the process a broker, OFF only explicitly", () => {
    expect(consciousnessEmitEnabled({})).toBe(false);
    expect(
      consciousnessEmitEnabled({ KAFKA_BOOTSTRAP: "redpanda:29092" }),
    ).toBe(true);
    expect(
      consciousnessEmitEnabled({
        KAFKA_BOOTSTRAP: "redpanda:29092",
        CALLIOPE_CONSCIOUSNESS_EMIT: "0",
      }),
    ).toBe(false);
  });

  it("treats a whitespace-only bootstrap as unset, not a broker", () => {
    expect(consciousnessEmitEnabled({ KAFKA_BOOTSTRAP: "   " })).toBe(false);
  });

  it("does not report a writer it does not have", () => {
    resetConsciousnessMetrics();
    expect(consciousnessMetrics().calliope_consciousness_publisher_wired).toBe(
      0,
    );
  });
});

describe("makeConsciousnessPublisher", () => {
  let stderrSpy: ReturnType<typeof spyOnStderr>;

  beforeEach(() => {
    resetConsciousnessMetrics();
    stderrSpy = spyOnStderr();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("is undefined and says why when KAFKA_BOOTSTRAP is unset", () => {
    expect(makeConsciousnessPublisher({})).toBeUndefined();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
      "calliope-consciousness: NOT publishing note events — KAFKA_BOOTSTRAP" +
        " is unset; notes written by this process will not reach the index\n",
    );
  });

  it("is undefined and says why when explicitly turned off", () => {
    expect(
      makeConsciousnessPublisher({
        KAFKA_BOOTSTRAP: "redpanda:29092",
        CALLIOPE_CONSCIOUSNESS_EMIT: "0",
      }),
    ).toBeUndefined();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
      "calliope-consciousness: NOT publishing note events —" +
        " CALLIOPE_CONSCIOUSNESS_EMIT=0; notes written by this process will" +
        " not reach the index\n",
    );
  });

  it("is a wired publisher, logging the trimmed bootstrap, when enabled", () => {
    const publisher = makeConsciousnessPublisher({
      KAFKA_BOOTSTRAP: " redpanda:29092 ",
    });
    expect(publisher).toBeInstanceOf(ConsciousnessPublisher);
    expect(consciousnessMetrics().calliope_consciousness_publisher_wired).toBe(
      1,
    );
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
      `calliope-consciousness: publishing note events to ${CONSCIOUSNESS_TOPIC} (bootstrap=redpanda:29092)\n`,
    );
  });
});

describe("makeConsciousnessTransport", () => {
  it("is a real KafkaJsTransport, built with the producer's own client id", () => {
    expect(CONSCIOUSNESS_CLIENT_ID).toBe("calliope-consciousness");
    expect(makeConsciousnessTransport("redpanda:29092")).toBeInstanceOf(
      KafkaJsTransport,
    );
  });
});
