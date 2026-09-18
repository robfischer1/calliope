// ── the focus register's consumer: the loop around the fold ─────────────────
//
// `handleTelemetryMessage` (the pure fold) is pinned in focus-register.test.ts.
// This file pins what DRIVES it: the consumer seam, the stream loop, the
// retry for the life of the process, the degradation on a broker fault, and
// the stop. Every test injects doubles — nothing here can reach a broker —
// and the one line that names the real client (`openFocusConsumer`) is
// pinned by value in focus-consumer-wiring.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringDeserializers } from "@platformatic/kafka";
import {
  CONSUMER_CLIENT_ID,
  CONSUMER_GROUP,
  FOCUS_REBALANCE_TIMEOUT_MS,
  FOCUS_RETRY_DELAY_MS,
  FOCUS_SESSION_TIMEOUT_MS,
  FOCUS_STREAM_MODE,
  FocusRegister,
  TELEMETRY_TOPIC,
  focusConsumerOptions,
  startFocusConsumer,
  type ConsumerLike,
  type FocusMessage,
  type FocusStream,
} from "../src/focus-register.js";
import type { BodyPointer } from "../src/types.js";

const pointer = (over?: Partial<BodyPointer>): BodyPointer => ({
  kind: "body",
  node: "n1",
  section: "s1",
  offsetFrom: 0,
  offsetTo: 6,
  text: "stable",
  ts: "2026-08-13T00:00:00.000Z",
  ...over,
});

const selection = (text: string): string =>
  JSON.stringify({
    v: 1,
    ts: "2026-08-13T00:00:00.000Z",
    nodeId: "n1",
    eventId: `e-${text}`,
    type: "selection-change",
    pointer: pointer({ text }),
  });

/** A stream the test feeds by hand, ends on demand, or fails on demand. */
function stream(): FocusStream & {
  push: (value: string | undefined) => void;
  end: () => void;
  fail: (err: Error) => void;
  closeCalls: number;
} {
  const queue: FocusMessage[] = [];
  let done = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    closeCalls: 0,
    push(value) {
      queue.push({ value });
      notify();
    },
    end() {
      done = true;
      notify();
    },
    fail(err) {
      failure = err;
      notify();
    },
    close() {
      this.closeCalls++;
      done = true;
      notify();
      return Promise.resolve();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (failure !== undefined) throw failure;
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

type Fake = ConsumerLike & {
  consumeCalls: { topics: string[]; mode: string }[];
  closeCalls: number;
  feed: ReturnType<typeof stream>;
};

/** A consumer double: records what it was asked, streams what the test feeds. */
function fakeConsumer(
  behaviour: { consume?: () => Promise<FocusStream> } = {},
): Fake {
  const feed = stream();
  return {
    consumeCalls: [],
    closeCalls: 0,
    feed,
    consume(options) {
      this.consumeCalls.push({
        topics: [...options.topics],
        mode: options.mode,
      });
      return behaviour.consume === undefined
        ? Promise.resolve(feed)
        : behaviour.consume();
    },
    close() {
      this.closeCalls++;
      return Promise.resolve();
    },
  };
}

/** A factory that hands out the given doubles in order, recording each open. */
function factory(...consumers: Fake[]): {
  open: () => ConsumerLike;
  opened: number;
} {
  const f = {
    opened: 0,
    open(): ConsumerLike {
      const next = consumers[f.opened];
      if (next === undefined)
        throw new Error(
          `test opened more consumers than it prepared (${String(f.opened)})`,
        );
      f.opened++;
      return next;
    },
  };
  return f;
}

/** Let the consumer loop run its queued microtasks and 0ms timers. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the consumer this module declares", () => {
  it("names the client and the group, points at the one bootstrap, deserializes strings, and states the session timing", () => {
    expect(focusConsumerOptions("redpanda:29092")).toEqual({
      clientId: CONSUMER_CLIENT_ID,
      groupId: CONSUMER_GROUP,
      bootstrapBrokers: ["redpanda:29092"],
      deserializers: stringDeserializers,
      sessionTimeout: FOCUS_SESSION_TIMEOUT_MS,
      rebalanceTimeout: FOCUS_REBALANCE_TIMEOUT_MS,
    });
    expect(CONSUMER_CLIENT_ID).toBe("calliope-focus");
    expect(CONSUMER_GROUP).toBe("calliope-focus-register");
  });

  it("keeps kafkajs's session timing — a killed pod holds the group for 30s, not the client's 60s", () => {
    expect(FOCUS_SESSION_TIMEOUT_MS).toBe(30_000);
    expect(FOCUS_REBALANCE_TIMEOUT_MS).toBe(60_000);
  });

  it("starts from LATEST — a register wants now, not history", () => {
    expect(FOCUS_STREAM_MODE).toBe("latest");
  });

  it("retries a failed or ended subscription every 15s", () => {
    expect(FOCUS_RETRY_DELAY_MS).toBe(15_000);
  });
});

describe("startFocusConsumer", () => {
  it("subscribes to the telemetry topic from LATEST, and says so once the stream is open", async () => {
    const consumer = fakeConsumer();
    const lines: string[] = [];
    startFocusConsumer(new FocusRegister(), {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
    });
    await settle();
    expect(consumer.consumeCalls).toEqual([
      { topics: [TELEMETRY_TOPIC], mode: "latest" },
    ]);
    expect(lines).toEqual([
      `calliope-focus: consuming ${TELEMETRY_TOPIC} (bootstrap=b:9092)`,
    ]);
  });

  it("folds every streamed record into the register, in order, last write winning", async () => {
    const consumer = fakeConsumer();
    const register = new FocusRegister();
    startFocusConsumer(register, {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: () => undefined,
    });
    await settle();
    consumer.feed.push(selection("first"));
    consumer.feed.push(selection("second"));
    await settle();
    expect(register.current()?.pointer.text).toBe("second");
  });

  it("skips a record the contract refuses and keeps consuming", async () => {
    const consumer = fakeConsumer();
    const register = new FocusRegister();
    startFocusConsumer(register, {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: () => undefined,
    });
    await settle();
    consumer.feed.push("{not json");
    consumer.feed.push(undefined); // a tombstone
    consumer.feed.push(selection("after"));
    await settle();
    expect(register.current()?.pointer.text).toBe("after");
  });

  it("logs a broker fault as unavailable, closes that consumer, and retries with a fresh one after the delay", async () => {
    const refused = fakeConsumer({
      consume: () => Promise.reject(new Error("Cannot connect to any broker")),
    });
    const accepted = fakeConsumer();
    const f = factory(refused, accepted);
    const lines: string[] = [];
    startFocusConsumer(new FocusRegister(), {
      openConsumer: f.open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
      retryDelayMs: 1000,
    });
    await settle();
    expect(lines).toEqual([
      "calliope-focus: consumer unavailable (serving without live focus; retrying in 1000ms): Cannot connect to any broker",
    ]);
    expect(refused.closeCalls).toBe(1);
    expect(f.opened).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.opened).toBe(1); // not before the delay
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(f.opened).toBe(2);
    expect(accepted.consumeCalls).toHaveLength(1);
    expect(lines.at(-1)).toBe(
      `calliope-focus: consuming ${TELEMETRY_TOPIC} (bootstrap=b:9092)`,
    );
  });

  it("logs a stream that dies mid-flight, with the reason, and reconnects", async () => {
    const first = fakeConsumer();
    const second = fakeConsumer();
    const f = factory(first, second);
    const lines: string[] = [];
    startFocusConsumer(new FocusRegister(), {
      openConsumer: f.open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
      retryDelayMs: 1000,
    });
    await settle();
    first.feed.fail(new Error("broker went away"));
    await settle();
    expect(lines.at(-1)).toBe(
      "calliope-focus: consumer unavailable (serving without live focus; retrying in 1000ms): broker went away",
    );
    expect(first.feed.closeCalls).toBe(1);
    expect(first.closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(f.opened).toBe(2);
  });

  it("a stream that simply ends is reconnected too, and said so", async () => {
    const first = fakeConsumer();
    const second = fakeConsumer();
    const f = factory(first, second);
    const lines: string[] = [];
    startFocusConsumer(new FocusRegister(), {
      openConsumer: f.open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
      retryDelayMs: 1000,
    });
    await settle();
    first.feed.end();
    await settle();
    expect(lines.at(-1)).toBe(
      "calliope-focus: stream ended (reconnecting in 1000ms)",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(f.opened).toBe(2);
  });

  it("stop() closes the stream BEFORE the consumer, and a stream ended by the stop is not a fault", async () => {
    const consumer = fakeConsumer();
    const order: string[] = [];
    consumer.feed.close = function (this: typeof consumer.feed) {
      order.push("stream");
      this.closeCalls++;
      this.end();
      return Promise.resolve();
    };
    consumer.close = function (this: typeof consumer) {
      order.push("consumer");
      this.closeCalls++;
      return Promise.resolve();
    };
    const lines: string[] = [];
    const handle = startFocusConsumer(new FocusRegister(), {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
    });
    await settle();
    await handle.stop();
    await settle();
    expect(order).toEqual(["stream", "consumer"]);
    expect(
      lines.filter((l) => l.includes("unavailable") || l.includes("ended")),
    ).toEqual([]);
  });

  it("stop() during the retry delay cancels the retry — no consumer is opened after it", async () => {
    const refused = fakeConsumer({
      consume: () => Promise.reject(new Error("down")),
    });
    const never = fakeConsumer();
    const f = factory(refused, never);
    const handle = startFocusConsumer(new FocusRegister(), {
      openConsumer: f.open,
      bootstrap: "b:9092",
      log: () => undefined,
      retryDelayMs: 1000,
    });
    await settle();
    expect(f.opened).toBe(1);
    await handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(f.opened).toBe(1);
    expect(never.consumeCalls).toHaveLength(0);
  });

  it("a fault raised after stop() is not reported either — the star is going down anyway", async () => {
    const consumer = fakeConsumer();
    consumer.feed.close = function (this: typeof consumer.feed) {
      this.closeCalls++;
      this.fail(new Error("closed underneath the loop"));
      return Promise.resolve();
    };
    const lines: string[] = [];
    const handle = startFocusConsumer(new FocusRegister(), {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: (line) => lines.push(line),
    });
    await settle();
    await handle.stop();
    await settle();
    expect(lines.filter((l) => l.includes("unavailable"))).toEqual([]);
  });

  it("survives a stream and a consumer that cannot be closed", async () => {
    const consumer = fakeConsumer();
    consumer.feed.close = () => Promise.reject(new Error("stream is gone"));
    consumer.close = () => Promise.reject(new Error("socket is gone"));
    const handle = startFocusConsumer(new FocusRegister(), {
      openConsumer: factory(consumer).open,
      bootstrap: "b:9092",
      log: () => undefined,
    });
    await settle();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("resolves the bootstrap from the environment when given none", async () => {
    vi.stubEnv("KAFKA_BOOTSTRAP", "broker-from-env:9092");
    const consumer = fakeConsumer();
    const lines: string[] = [];
    startFocusConsumer(new FocusRegister(), {
      openConsumer: factory(consumer).open,
      log: (line) => lines.push(line),
    });
    await settle();
    expect(lines[0]).toContain("(bootstrap=broker-from-env:9092)");
  });
});
