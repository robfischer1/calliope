/**
 * aglaia's two backend reads and writes that used to live in charon (Charon
 * parity rows 19 and 20): the tag-style seed and the writing-telemetry ingest.
 * Ported from charon `routes/seed.ts`, `routes/telemetry.ts` and
 * `lib/broker.ts`; calliope is aglaia's backend and already the topic's
 * consumer (`focus-register.ts`), so both ends of the A15 stream now sit in
 * one star.
 *
 * THE SEED. A `tag_styles` list (the `tag=hue:icon` grammar `@forge/aglaia`
 * parses) that a browser merges UNDER the user's own setting. Its tag names
 * are personal, so it lives in OpenBao, not in theia's bundle: an
 * ExternalSecret renders it into this star's env as AGLAIA_TAG_SEED. Read per
 * call, so a rotated Secret reaches the answer the moment the pod restarts
 * with it, and a test sets it without re-importing anything. No seed is
 * `not_found`, charon's 404: the browser renders uncoloured pills.
 *
 * THE INGEST. A browser batch of typed events, produced onto
 * `aglaia.writing.deltas.v1`, one message per event, in ONE producer call.
 * THE REFUSAL SPLIT IS LOAD-BEARING: `bad_args` (malformed, or an event that
 * breaks the topic's contract) tells the client to DROP the batch;
 * `backend_unavailable` (the broker did not take it) tells the client to KEEP
 * it and replay. A contract violation answered as retryable would be replayed
 * forever and wedge the ingest path. Every record is built before any is sent,
 * so a refused batch produced nothing: the batch is all-or-nothing on the
 * contract, and at-least-once on the broker (a replay after a send that did
 * land is a duplicate the consumers already tolerate by eventId).
 *
 * THE KEY. The kit still declares the topic unkeyed (`record` answers
 * `key: null`), so this module keys on `nodeId` (one node's events keep their
 * order on one partition) and falls back to `eventId`; never `""`, which is a
 * real key every record would hash to one partition.
 *
 * Identity is not read here: who may call either verb is the edge's policy,
 * not a check in this star.
 */

import { Producer, stringSerializers } from "@platformatic/kafka";
import {
  KafkaTopicsError,
  TOPIC_AGLAIA_WRITING_DELTAS,
  decodeWritingDeltaEvent,
  record,
} from "@forge/stellar-core-ts/kafkatopics";
import { resolveBootstrap } from "./focus-register.js";

/** The env key the ExternalSecret-backed Secret is mounted under. */
export const TAG_SEED_ENV = "AGLAIA_TAG_SEED";

/** The A15 writing-telemetry topic: the contract's own constant. */
export const TELEMETRY_TOPIC = TOPIC_AGLAIA_WRITING_DELTAS;

/** Batches are bounded so a runaway client cannot wedge the star. */
export const MAX_BATCH = 500;

/** A refusal as this module builds it (refusal.ts puts it on the wire). */
export interface AglaiaRefusal {
  code: "not_found" | "bad_args" | "backend_unavailable";
  detail: string;
}

export function isAglaiaRefusal(v: unknown): v is AglaiaRefusal {
  return typeof v === "object" && v !== null && "code" in v && "detail" in v;
}

/** The seed, or `not_found` when none is configured. */
export function readTagSeed(
  env: NodeJS.ProcessEnv = process.env,
): { tag_styles: string } | AglaiaRefusal {
  const seed = env[TAG_SEED_ENV]?.trim() ?? "";
  if (seed === "") {
    return {
      code: "not_found",
      detail: `no tag seed configured (${TAG_SEED_ENV} is unset)`,
    };
  }
  return { tag_styles: seed };
}

/** One message as the producer takes it. */
export interface TelemetryMessage {
  topic: string;
  key: string | undefined;
  value: string | undefined;
}

/**
 * Build the contract's records for a batch, the pure half. Throws
 * `KafkaTopicsError` on the first event that breaks the contract, having
 * sent nothing. `type` stays an OPEN string in the decoder, so a theia
 * variant this fleet has not shipped yet relays through untouched.
 */
export function telemetryRecords(events: unknown[]): TelemetryMessage[] {
  return events.map((event) => {
    const decoded = decodeWritingDeltaEvent(event);
    const rec = record(TELEMETRY_TOPIC, decoded);
    return {
      topic: rec.topic,
      key: rec.key ?? (decoded.nodeId || decoded.eventId),
      value: rec.value ?? undefined,
    };
  });
}

/** The half of a producer this module drives (a test hands in a double). */
export interface TelemetryProducerLike {
  send(options: { messages: TelemetryMessage[] }): Promise<unknown>;
}

/** The producer options this module declares. Topic creation is
 *  thalassa's, never a producer side effect; no compression. */
export function telemetryProducerOptions(
  bootstrap: string,
): ConstructorParameters<typeof Producer<string, string, string, string>>[0] {
  return {
    clientId: "calliope-telemetry",
    bootstrapBrokers: [bootstrap],
    serializers: stringSerializers,
    autocreateTopics: false,
  };
}

/** The client-backed producer. Nothing is dialled until the first batch;
 *  a failed send rejects that call and the next one dials again. */
export function createTelemetryProducer(
  bootstrap: string = resolveBootstrap(),
): TelemetryProducerLike {
  return new Producer<string, string, string, string>(
    telemetryProducerOptions(bootstrap),
  );
}

/** What an accepted batch answers. */
export interface IngestAnswer {
  accepted: number;
  topic: string;
}

/**
 * Validate and produce one batch. The records are built BEFORE the send, so
 * a contract refusal never depends on whether the broker is reachable (the
 * same bad batch must not answer drop one day and replay the next).
 */
export async function ingestBatch(
  producer: TelemetryProducerLike,
  events: unknown,
): Promise<IngestAnswer | AglaiaRefusal> {
  if (!Array.isArray(events) || events.length === 0) {
    return { code: "bad_args", detail: "expected a non-empty events array" };
  }
  if (events.length > MAX_BATCH) {
    return {
      code: "bad_args",
      detail: `batch exceeds ${String(MAX_BATCH)} events`,
    };
  }
  let messages: TelemetryMessage[];
  try {
    messages = telemetryRecords(events);
  } catch (err) {
    if (err instanceof KafkaTopicsError) {
      return {
        code: "bad_args",
        detail: `event breaks ${TELEMETRY_TOPIC}: ${err.message}`,
      };
    }
    throw err;
  }
  try {
    await producer.send({ messages });
  } catch (err) {
    return {
      code: "backend_unavailable",
      detail: `broker unavailable, keep the batch and replay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { accepted: messages.length, topic: TELEMETRY_TOPIC };
}
