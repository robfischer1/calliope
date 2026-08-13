/**
 * 028 ("Look At This" F5) — the focus register: the broadcast-register half
 * of the attention pointer. One Rob, one focus, N sessions — so N sessions
 * are N READERS of one value, and routing dissolves (the reason the
 * `claude://` push scheme died in discovery).
 *
 * The register is written from the telemetry the editor ALREADY emits:
 * Charon's /telemetry route produces A15 event batches onto the Pontus topic
 * (`aglaia.writing.deltas.v1`, charon `lib/pontus.ts`), and since theia 059
 * a `selection-change` event carries the capture-time-resolved `pointer`.
 * This module consumes that topic and folds pointers into a last-write-wins
 * slot. No new pipe, no new endpoint.
 *
 * Degrades like `mcp/heartbeat.ts`: a broker that never connects logs to
 * stderr and the star serves on — the register just stays at its last known
 * value (or empty). Reading NEVER mutates.
 */

import { Kafka, logLevel } from "kafkajs";
import type { Consumer } from "kafkajs";
import type { BodyPointer } from "./types.js";
import { isBodyPointer } from "./types.js";

/** The A15 writing-telemetry topic (the producer side lives in charon). */
export const TELEMETRY_TOPIC = "aglaia.writing.deltas.v1";
/** One register per star; the group id makes redeploys resume cleanly. */
export const CONSUMER_GROUP = "calliope-focus-register";
/** Pontus's internal listener on the pantheon net (heartbeat's default). */
const DEFAULT_BOOTSTRAP = "pontus:29092";

/** What the register holds: the pointer + when this star received it. */
export interface FocusEntry {
  pointer: BodyPointer;
  receivedAt: string;
}

/** 029 (F6): one deliberate pin — a FocusEntry with its editor-minted id. */
export interface PinEntry extends FocusEntry {
  pinId: string;
}

/**
 * The last-write-wins focus slot. Process-global by design for now — the
 * per-window vs global question is an open master-plan decision; one slot
 * is coherent under LWW and a window key can widen it later.
 */
export class FocusRegister {
  #current: FocusEntry | null = null;
  // 029 (F6): the second grain — deliberate pins, arrival-ordered. Live
  // focus is LWW; pins STACK ("pin three things, compare these").
  #pins: PinEntry[] = [];

  /** Fold a newer pointer in — last write wins. */
  set(pointer: BodyPointer, receivedAt: string): void {
    this.#current = { pointer, receivedAt };
  }

  /** The current focus, or null when none has ever arrived. Never mutates. */
  current(): FocusEntry | null {
    return this.#current;
  }

  /** Append a pin. The wire is at-least-once, so a pinId seen before is a
   *  redelivery — the pin exists once, at its original position. */
  pin(pinId: string, pointer: BodyPointer, receivedAt: string): void {
    if (this.#pins.some((p) => p.pinId === pinId)) return;
    this.#pins.push({ pinId, pointer, receivedAt });
  }

  /** Remove one pin by id; answers whether it existed. */
  unpin(pinId: string): boolean {
    const before = this.#pins.length;
    this.#pins = this.#pins.filter((p) => p.pinId !== pinId);
    return this.#pins.length !== before;
  }

  /** The pins in arrival order. A fresh array each read; never mutates. */
  pins(): PinEntry[] {
    return [...this.#pins];
  }
}

/**
 * Fold one raw topic message into the register — PURE against the register
 * (injectable clock for the received-at stamp). The wire carries either one
 * event or an array of events (charon produces per-batch); anything that is
 * not a `selection-change` carrying a guard-passing `pointer` is ignored.
 * Malformed JSON is ignored (the topic is additive-tolerant; a register must
 * never crash its star over a stray producer).
 */
export function handleTelemetryMessage(
  register: FocusRegister,
  rawValue: string | undefined,
  now: () => Date = () => new Date(),
): void {
  if (rawValue === undefined || rawValue === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return;
  }
  const events: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const ev of events) {
    if (ev === null || typeof ev !== "object") continue;
    const e = ev as { type?: unknown; pointer?: unknown; pinId?: unknown };
    if (e.type === "selection-change" && isBodyPointer(e.pointer)) {
      register.set(e.pointer, now().toISOString());
    } else if (
      // 029 (F6): the deliberate grain — same guard, append not LWW.
      e.type === "pointer-pin" &&
      typeof e.pinId === "string" &&
      e.pinId !== "" &&
      isBodyPointer(e.pointer)
    ) {
      register.pin(e.pinId, e.pointer, now().toISOString());
    }
  }
}

/** A running consumer; `stop()` disconnects it. */
export interface FocusConsumerHandle {
  stop: () => Promise<void>;
}

/** Resolve the broker bootstrap exactly as the heartbeat does. */
export function resolveBootstrap(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KAFKA_BOOTSTRAP;
  return raw !== undefined && raw.trim() !== ""
    ? raw.trim()
    : DEFAULT_BOOTSTRAP;
}

/**
 * Start the register's consumer. From LATEST (a register wants now, not
 * history — replaying stale focus would be worse than empty). A broker
 * fault logs once per attempt and never throws into the caller; the star
 * serves regardless.
 */
export function startFocusConsumer(
  register: FocusRegister,
  opts: { bootstrap?: string } = {},
): FocusConsumerHandle {
  const bootstrap = opts.bootstrap ?? resolveBootstrap();
  const kafka = new Kafka({
    clientId: "calliope-focus",
    brokers: [bootstrap],
    logLevel: logLevel.NOTHING,
  });
  const consumer: Consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
  let stopped = false;

  const run = async (): Promise<void> => {
    try {
      await consumer.connect();
      await consumer.subscribe({
        topic: TELEMETRY_TOPIC,
        fromBeginning: false,
      });
      await consumer.run({
        eachMessage: ({ message }) => {
          handleTelemetryMessage(register, message.value?.toString("utf8"));
          return Promise.resolve();
        },
      });
      process.stderr.write(
        `calliope-focus: consuming ${TELEMETRY_TOPIC} (bootstrap=${bootstrap})\n`,
      );
    } catch (err) {
      if (!stopped) {
        process.stderr.write(
          `calliope-focus: consumer unavailable (serving without live focus): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  };
  void run();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      try {
        await consumer.disconnect();
      } catch {
        // best-effort teardown — shutdown proceeds regardless.
      }
    },
  };
}
