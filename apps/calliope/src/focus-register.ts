/**
 * 028 ("Look At This" F5) — the focus register: the broadcast-register half
 * of the attention pointer. One Rob, one focus, N sessions — so N sessions
 * are N READERS of one value, and routing dissolves (the reason the
 * `claude://` push scheme died in discovery).
 *
 * The register is written from the telemetry the editor ALREADY emits:
 * charon's /telemetry route produces A15 events onto
 * `aglaia.writing.deltas.v1` (charon `apps/server/src/lib/broker.ts`), ONE
 * EVENT PER MESSAGE, and since theia 059 a `selection-change` event carries
 * the capture-time-resolved `pointer`. This module consumes that topic and
 * folds pointers into a last-write-wins slot. No new pipe, no new endpoint.
 *
 * ON THE CONTRACT. The topic name and the decode come from
 * `@forge/stellar-core-ts/kafkatopics` — the same generated reader the
 * producer's records are built against, so "what charon writes" and "what
 * this folds" are one statement rather than two that have to be kept in
 * step by hand.
 *
 * TOLERANT BY DESIGN, AND THAT SURVIVED THE SWAP. This register switches on
 * three of the seven `type` values theia mints and IGNORES the rest; `type`
 * is an OPEN string in the schema (the `checkpoints.kind` precedent), so a
 * theia variant that has not shipped yet decodes cleanly here and falls
 * through the switch rather than breaking the star. Nothing in this module
 * throws into the consumer loop: a record the contract refuses is skipped
 * and the partition moves on — a register must never wedge its star over a
 * stray producer.
 *
 * Degrades like the core's heartbeat publisher (`stellar-core-ts` `ops.ts`,
 * which this star's own `mcp/heartbeat.ts` became): a broker that never
 * connects logs to stderr and the star serves on — the register just stays at
 * its last known value (or empty). Reading NEVER mutates.
 */

import { Kafka, logLevel } from "kafkajs";
import type { Consumer } from "kafkajs";
import {
  TOPIC_AGLAIA_WRITING_DELTAS,
  decodeWritingDeltaEvent,
} from "@forge/stellar-core-ts/kafkatopics";
import type { WritingDeltaEvent } from "@forge/stellar-core-ts/kafkatopics";
import type { BodyPointer } from "./types.js";
import { isBodyPointer } from "./types.js";

/** The A15 writing-telemetry topic (the producer side lives in charon).
 *  The contract's own constant — never a literal. */
export const TELEMETRY_TOPIC = TOPIC_AGLAIA_WRITING_DELTAS;
/** One register per star; the group id makes redeploys resume cleanly. */
export const CONSUMER_GROUP = "calliope-focus-register";
/** Redpanda's internal listener on the pantheon net (heartbeat's default). */
const DEFAULT_BOOTSTRAP = "redpanda:29092";

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

  /** 030 (F7): opting out of live focus retires the ambient slot. Pins —
   *  deliberate intent — are untouched by design. */
  clearFocus(): void {
    this.#current = null;
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
 * Fold ONE topic message into the register — PURE against the register
 * (injectable clock for the received-at stamp).
 *
 * One message is one event. charon's producer maps each event in a browser
 * batch to its own record (`broker.ts`, `messages: [...]` one per event), so
 * a JSON array never reaches this function; the fold used to branch on
 * `Array.isArray` for a shape no producer on this topic has ever written,
 * and that dead leniency is gone.
 *
 * Read through the contract's generated `decodeWritingDeltaEvent`, which
 * refuses a record missing the envelope's required fields and leaves `type`
 * an OPEN string. NEVER THROWS: a record the contract refuses — malformed
 * JSON, a missing field, a `pointer` that is not one — is skipped, and the
 * consumer commits past it rather than wedging the partition. An event
 * whose `type` this register does not switch on is not an error at all; it
 * decodes fine and falls through, which is how a new theia variant reaches
 * the topic without breaking this star.
 */
export function handleTelemetryMessage(
  register: FocusRegister,
  rawValue: string | undefined,
  now: () => Date = () => new Date(),
): void {
  if (rawValue === undefined || rawValue === "") return;
  let event: WritingDeltaEvent;
  try {
    event = decodeWritingDeltaEvent(JSON.parse(rawValue));
  } catch {
    return;
  }
  // `isBodyPointer` still guards the VARIANT: the contract types
  // `pointer.kind` as an open string (a future kind is a widening, not a
  // rewrite), and this register only understands `kind: "body"`. A pointer
  // kind it does not know is tolerated and ignored, never thrown on.
  if (event.type === "selection-change" && isBodyPointer(event.pointer)) {
    register.set(event.pointer, now().toISOString());
  } else if (
    // 029 (F6): the deliberate grain — same guard, append not LWW.
    event.type === "pointer-pin" &&
    event.pinId !== null &&
    event.pinId !== "" &&
    isBodyPointer(event.pointer)
  ) {
    register.pin(event.pinId, event.pointer, now().toISOString());
  } else if (event.type === "pointer-live-clear") {
    // 030 (F7): the ambient opt-out retires the slot; pins survive.
    register.clearFocus();
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
