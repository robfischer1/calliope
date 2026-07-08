/**
 * Heartbeat publisher — the bun-side mirror of the Python stars'
 * `stellar_core.AsyncHeartbeatPublisher`.
 *
 * A background interval publishes this star's `{star, live, ready, metrics, ts}`
 * health to the `calliope._ops.heartbeat` topic on the Pontus broker (Redpanda,
 * `pontus:29092` on the pantheon net) every interval, so Nyx, operators — and
 * Hades's re-dial consumer — can read calliope's standing off the event backbone
 * rather than only by dialing it. The `_ops` topics are schemaless (no schema
 * registry): the payload is plain JSON.
 *
 * Degrades gracefully, like its Python cousin: a broker that never connects logs
 * once per failed beat and the server serves on; a publish fault never throws
 * into the HTTP request path. The producer is `kafkajs` (pure JS — it bundles
 * under `bun build --target=bun`, unlike the native `node-rdkafka`).
 */

import { Kafka, logLevel } from "kafkajs";
import type { Producer } from "kafkajs";

/** This star's identity in the heartbeat payload + topic (star.toml name). */
const STAR = "calliope";
/** The topic Nyx / operators / Hades read this star's liveness from. */
export const HEARTBEAT_TOPIC = `${STAR}._ops.heartbeat`;
/**
 * Beat cadence — frequent enough that a missed beat is a quick liveness signal,
 * sparse enough to be negligible load. Matches the Python `DEFAULT_INTERVAL_S`.
 */
export const DEFAULT_INTERVAL_MS = 30_000;
/** Pontus's internal listener on the pantheon net (the Python stars' default). */
const DEFAULT_BOOTSTRAP = "pontus:29092";

/** The heartbeat wire payload (schemaless JSON on the `_ops` topic). */
export interface HeartbeatPayload {
  star: string;
  live: boolean;
  ready: boolean;
  metrics: Record<string, number>;
  ts: string;
}

/** A running heartbeat; `stop()` clears the timer + disconnects the producer. */
export interface HeartbeatHandle {
  stop: () => Promise<void>;
}

/**
 * Build the heartbeat payload for a given instant. Pure — `now` is injected so
 * the shape (and the ISO timestamp) is testable without a wall clock.
 */
export function heartbeatPayload(now: Date): HeartbeatPayload {
  return {
    star: STAR,
    live: true,
    ready: true,
    metrics: {},
    ts: now.toISOString(),
  };
}

/**
 * Resolve the broker bootstrap: `PONTUS_BOOTSTRAP`, else `KAFKA_BOOTSTRAP`, else
 * the pantheon-net default (`pontus:29092`). Pure — the env is injected.
 */
export function resolveBootstrap(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PONTUS_BOOTSTRAP ?? env.KAFKA_BOOTSTRAP;
  return raw !== undefined && raw.trim() !== ""
    ? raw.trim()
    : DEFAULT_BOOTSTRAP;
}

/**
 * Start a background heartbeat publisher; returns a handle whose `stop()` ends
 * it. Beats immediately, then every `intervalMs`. A broker fault is logged (to
 * stderr) and the next beat retries after a forced reconnect — a missing
 * heartbeat must never stop the star from serving.
 */
export function startHeartbeat(
  opts: { intervalMs?: number; bootstrap?: string } = {},
): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const bootstrap = opts.bootstrap ?? resolveBootstrap();
  const kafka = new Kafka({
    clientId: `${STAR}-heartbeat`,
    brokers: [bootstrap],
    // kafkajs logs to stdout by default; keep it quiet — this module owns its
    // own stderr reporting, and stdout parity with the bin's convention matters.
    logLevel: logLevel.NOTHING,
  });
  const producer: Producer = kafka.producer({ allowAutoTopicCreation: true });

  let connected = false;
  let stopped = false;
  let inFlight = false;

  const beat = async (): Promise<void> => {
    // Skip if stopped, or if the previous beat is still connecting (a slow
    // broker retry must not stack overlapping publishes).
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (!connected) {
        await producer.connect();
        connected = true;
      }
      await producer.send({
        topic: HEARTBEAT_TOPIC,
        messages: [{ value: JSON.stringify(heartbeatPayload(new Date())) }],
      });
    } catch (err) {
      process.stderr.write(
        `calliope-heartbeat: publish failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      connected = false; // force a reconnect on the next beat
    } finally {
      inFlight = false;
    }
  };

  void beat(); // beat immediately, then on the interval
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  // Don't let the timer alone keep the process alive — the listening socket does.
  timer.unref();

  process.stderr.write(
    `calliope-heartbeat: publishing to ${HEARTBEAT_TOPIC} every ${String(intervalMs)}ms (bootstrap=${bootstrap})\n`,
  );

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      if (connected) {
        try {
          await producer.disconnect();
        } catch {
          // best-effort teardown — shutdown proceeds regardless.
        }
      }
    },
  };
}
