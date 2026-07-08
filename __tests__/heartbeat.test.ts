import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVAL_MS,
  HEARTBEAT_TOPIC,
  heartbeatPayload,
  resolveBootstrap,
} from "../src/mcp/heartbeat.js";

/**
 * The heartbeat publisher's pure core — the payload shape and the broker
 * resolution. The Kafka producer wiring (connect / send / interval) is
 * exercised by the deploy path, mirroring the Python stars' convention; here we
 * pin what the publisher puts on the wire and where it points.
 */

describe("heartbeatPayload", () => {
  it("builds the op-contract payload for the given instant", () => {
    const now = new Date("2026-07-08T12:34:56.000Z");
    expect(heartbeatPayload(now)).toEqual({
      star: "calliope",
      live: true,
      ready: true,
      metrics: {},
      ts: "2026-07-08T12:34:56.000Z",
    });
  });

  it("serialises the timestamp as ISO-8601 (matching the Python publisher)", () => {
    const now = new Date("2026-01-02T03:04:05.678Z");
    expect(heartbeatPayload(now).ts).toBe("2026-01-02T03:04:05.678Z");
  });
});

describe("HEARTBEAT_TOPIC", () => {
  it("is the star's op-contract heartbeat topic", () => {
    expect(HEARTBEAT_TOPIC).toBe("calliope._ops.heartbeat");
  });
});

describe("DEFAULT_INTERVAL_MS", () => {
  it("matches the fleet's 30s beat cadence", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(30_000);
  });
});

describe("resolveBootstrap", () => {
  it("prefers PONTUS_BOOTSTRAP", () => {
    expect(resolveBootstrap({ PONTUS_BOOTSTRAP: "broker-a:9092" })).toBe(
      "broker-a:9092",
    );
  });

  it("falls back to KAFKA_BOOTSTRAP", () => {
    expect(resolveBootstrap({ KAFKA_BOOTSTRAP: "broker-b:9092" })).toBe(
      "broker-b:9092",
    );
  });

  it("prefers PONTUS_BOOTSTRAP over KAFKA_BOOTSTRAP when both set", () => {
    expect(
      resolveBootstrap({
        PONTUS_BOOTSTRAP: "pontus-x:29092",
        KAFKA_BOOTSTRAP: "other:9092",
      }),
    ).toBe("pontus-x:29092");
  });

  it("defaults to the pantheon-net Pontus listener when unset", () => {
    expect(resolveBootstrap({})).toBe("pontus:29092");
  });

  it("treats a blank value as unset", () => {
    expect(resolveBootstrap({ PONTUS_BOOTSTRAP: "   " })).toBe("pontus:29092");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveBootstrap({ PONTUS_BOOTSTRAP: "  pontus:29092  " })).toBe(
      "pontus:29092",
    );
  });
});
