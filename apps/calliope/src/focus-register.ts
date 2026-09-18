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

import {
  Consumer,
  MessagesStreamModes,
  stringDeserializers,
} from "@platformatic/kafka";
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
/** One register per star: the group id is what makes two replicas of
 *  this star share the topic's partitions rather than each fold every
 *  record. It does NOT decide where a redeploy starts — see
 *  {@link FOCUS_STREAM_MODE}. */
export const CONSUMER_GROUP = "calliope-focus-register";
/** From LATEST, on every boot. A register wants NOW, not history —
 *  replaying stale focus after a redeploy would put an old pointer in
 *  front of every session until the next selection, which is worse than
 *  an empty slot. The kafkajs consumer this replaced resumed from the
 *  group's committed offset (`fromBeginning: false`), which matched this
 *  intent only until the first commit. */
export const FOCUS_STREAM_MODE = MessagesStreamModes.LATEST;
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

/** A running consumer; `stop()` closes it. */
export interface FocusConsumerHandle {
  stop: () => Promise<void>;
}

/** One record as the register reads it: the value, deserialized to a
 *  string, or `undefined` for a null value (a tombstone, which the fold
 *  skips). */
export interface FocusMessage {
  readonly value: string | undefined;
}

/** The stream a consumer answers: the records, and a `close` that ends it
 *  — which has to happen BEFORE the consumer closes, or the client refuses
 *  to leave the group while a stream is open. */
export interface FocusStream extends AsyncIterable<FocusMessage> {
  close(): Promise<void>;
}

/** The half of a consumer this module drives — structural, not the
 *  client's own `Consumer` type, so a test injects a double and
 *  {@link openFocusConsumer} is the only line that names the client. */
export interface ConsumerLike {
  consume(options: {
    readonly topics: string[];
    readonly mode: typeof FOCUS_STREAM_MODE;
  }): Promise<FocusStream>;
  close(): Promise<void>;
}

/** The session timing this module DECLARES — kafkajs's defaults, which
 *  are what the fleet has run on. The client's own (60s session, 102s
 *  rebalance) would double the gap a redeploy leaves in live focus: a
 *  member that is killed rather than stopped holds the group until its
 *  session expires, and the replacement's join is refused (code 23,
 *  INCONSISTENT_GROUP_PROTOCOL, measured 2026-09-17 against a local
 *  broker) until then. */
export const FOCUS_SESSION_TIMEOUT_MS = 30_000;
export const FOCUS_REBALANCE_TIMEOUT_MS = 60_000;

/** The consumer options this module DECLARES, split out so a test asserts
 *  the wire settings are stated here rather than inherited from the
 *  client. String deserializers: the fold takes the value as text and
 *  hands it to the contract's decoder. The client logs through `debug`
 *  only, so there is no log level to silence — stdout stays the star's
 *  MCP transport's. */
export function focusConsumerOptions(
  bootstrap: string,
): ConstructorParameters<typeof Consumer<string, string, string, string>>[0] {
  return {
    clientId: "calliope-focus",
    groupId: CONSUMER_GROUP,
    bootstrapBrokers: [bootstrap],
    deserializers: stringDeserializers,
    sessionTimeout: FOCUS_SESSION_TIMEOUT_MS,
    rebalanceTimeout: FOCUS_REBALANCE_TIMEOUT_MS,
  };
}

/** Open this module's own consumer against `bootstrap`. Nothing is
 *  dialled until `consume`. */
export function openFocusConsumer(bootstrap: string): ConsumerLike {
  return new Consumer<string, string, string, string>(
    focusConsumerOptions(bootstrap),
  );
}

/** Anything with a best-effort close: a stream, a consumer. */
interface Closable {
  close(): Promise<void>;
}

/** Close what is open, swallowing a REFUSAL: a wedged stream or consumer
 *  must not stall a shutdown or the next attempt. Only the rejection is
 *  swallowed — `close` is called outside the try, so a seam that throws
 *  synchronously (a `close` that is not a function) is a broken double or
 *  a broken client, and that escapes rather than passing as "closed". */
async function closeQuietly(target: Closable | undefined): Promise<void> {
  if (target === undefined) return;
  const closing = target.close();
  try {
    await closing;
  } catch {
    // best-effort teardown — the caller proceeds regardless.
  }
}

/** How long a failed or ended subscription waits before the next attempt.
 *  Long enough not to hammer a broker that is down; short enough that a
 *  redeploy's refused join (see {@link FOCUS_SESSION_TIMEOUT_MS}) costs at
 *  most one extra interval of live focus. */
export const FOCUS_RETRY_DELAY_MS = 15_000;

/** stderr, not stdout: a bun star's stdout is its MCP transport. */
function stderrLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** An error's message, for a log line that must never itself throw. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve the broker bootstrap exactly as the heartbeat does. */
export function resolveBootstrap(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KAFKA_BOOTSTRAP;
  return raw !== undefined && raw.trim() !== ""
    ? raw.trim()
    : DEFAULT_BOOTSTRAP;
}

/**
 * Start the register's consumer. From LATEST ({@link FOCUS_STREAM_MODE}),
 * and FOR THE LIFE OF THE PROCESS: a subscription that cannot be opened, or
 * a stream that ends or dies, is logged and retried after
 * {@link FOCUS_RETRY_DELAY_MS}, with a fresh consumer each time. The kafkajs
 * consumer this replaced tried once and, on a fault, served without live
 * focus until the next redeploy — which is exactly the window a redeploy
 * itself opens (the outgoing pod holds the group until its session
 * expires), so the one-shot could lose the register on every rollout.
 *
 * Nothing here throws into the caller; the star serves regardless, the
 * register staying at its last value (or empty). `stop()` ends the stream,
 * closes the consumer and cancels any pending retry — a stream that ends
 * because it was stopped is not reported as a fault.
 */
export function startFocusConsumer(
  register: FocusRegister,
  opts: {
    bootstrap?: string;
    /** Open a consumer — one per attempt. Default: {@link openFocusConsumer}
     *  against `bootstrap`. A test's factory hands back doubles. */
    openConsumer?: () => ConsumerLike;
    /** Where the consumer's own diagnostics go. Default: one line to stderr. */
    log?: (line: string) => void;
    retryDelayMs?: number;
  } = {},
): FocusConsumerHandle {
  const bootstrap = opts.bootstrap ?? resolveBootstrap();
  const openConsumer =
    opts.openConsumer ?? ((): ConsumerLike => openFocusConsumer(bootstrap));
  const log = opts.log ?? stderrLog;
  const retryDelayMs = opts.retryDelayMs ?? FOCUS_RETRY_DELAY_MS;

  // A function, not a bare flag: `stop()` flips it from another closure,
  // which TypeScript's narrowing cannot see — a `let` read after the loop
  // condition types as `false` forever, and the lint rightly calls every
  // later check on it unnecessary. A call is never narrowed.
  let stopRequested = false;
  const stopped = (): boolean => stopRequested;
  // What the current attempt holds open; a release closes the stream
  // first, because the client refuses to leave the group while a stream is
  // open.
  let consumer: Closable | undefined;
  let stream: Closable | undefined;
  let wake: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Sleep `retryDelayMs`, or less if `stop()` arrives first. */
  const pause = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      retryTimer = setTimeout(resolve, retryDelayMs);
    });

  /** Release whatever the current attempt opened. Never throws. */
  const release = async (): Promise<void> => {
    const s = stream;
    const c = consumer;
    stream = undefined;
    consumer = undefined;
    await closeQuietly(s);
    await closeQuietly(c);
  };

  const run = async (): Promise<void> => {
    while (!stopped()) {
      try {
        const opened = openConsumer();
        consumer = opened;
        const records = await opened.consume({
          topics: [TELEMETRY_TOPIC],
          mode: FOCUS_STREAM_MODE,
        });
        stream = records;
        log(
          `calliope-focus: consuming ${TELEMETRY_TOPIC} (bootstrap=${bootstrap})`,
        );
        for await (const message of records) {
          handleTelemetryMessage(register, message.value);
        }
        if (!stopped()) {
          log(
            `calliope-focus: stream ended (reconnecting in ${String(retryDelayMs)}ms)`,
          );
        }
      } catch (err) {
        if (!stopped()) {
          log(
            `calliope-focus: consumer unavailable (serving without live focus; retrying in ${String(retryDelayMs)}ms): ${reason(err)}`,
          );
        }
      }
      await release();
      if (stopped()) return;
      await pause();
    }
  };
  void run();

  return {
    stop: async (): Promise<void> => {
      stopRequested = true;
      // Unconditional: clearTimeout(undefined) is a no-op, and a pending
      // retry left armed after stop is a timer nothing will ever answer.
      clearTimeout(retryTimer);
      wake?.();
      await release();
    },
  };
}
