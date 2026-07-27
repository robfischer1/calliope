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

import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import type { Producer } from "kafkajs";

/** This star's identity in the heartbeat payload + topic (star.toml name). */
const STAR = "calliope";

/**
 * A new id per PROCESS, minted once at module load.
 *
 * The fleet's deploy signal. Nothing in the heartbeat said which *instance* was
 * beating, so "calliope restarted" — the moment a deploy actually lands — was
 * not observable at all; a reader could only infer it by watching the
 * cumulative metrics counters run backwards, which needs per-star history and
 * has to be reimplemented by every consumer that wants the edge.
 *
 * Module scope, not per-publisher: a process has exactly one boot. Minting it
 * inside `startHeartbeat` would make a publisher rebuilt on reconnect look like
 * a restart — a false deploy edge, which is worse than no edge because a
 * consumer would act on it.
 *
 * `.hex`-shaped (dashes stripped) for wire parity with the Python publisher's
 * `uuid.uuid4().hex`.
 */
export const BOOT_ID = randomUUID().replaceAll("-", "");

/**
 * Env var carrying the git sha this image was built from. The shared build
 * workflow stamps it as an `ENV` layer on the star's own image (alongside the
 * `org.opencontainers.image.revision` label) precisely because a process cannot
 * read its own image labels without the docker daemon.
 */
const REVISION_ENV = "STELLAR_REVISION";
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
  boot_id: string;
  /** Omitted entirely when the image is unstamped — never written as null. */
  revision?: string;
}

/** A running heartbeat; `stop()` clears the timer + disconnects the producer. */
export interface HeartbeatHandle {
  stop: () => Promise<void>;
}

/**
 * Resolve the git sha this image was built from, or `undefined` if unstamped.
 * Pure — the env is injected, matching `resolveBootstrap`.
 *
 * `undefined` rather than a placeholder: an unstamped image is a real state
 * (built before the build began stamping, or built by hand), and a reader must
 * be able to tell "running an unknown revision" from "running one called
 * unknown".
 */
export function revision(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[REVISION_ENV];
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

/**
 * Build the heartbeat payload for a given instant. Pure — `now` and the env are
 * injected so the shape (and the ISO timestamp) is testable without a wall
 * clock or a mutated process env.
 *
 * `boot_id` and `revision` describe the PROCESS, not its health, so they are
 * read here rather than threaded through call sites.
 *
 * `revision` is OMITTED when unstamped rather than written as null, so an image
 * built before the build began stamping produces the exact payload it always
 * did.
 */
export function heartbeatPayload(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatPayload {
  const payload: HeartbeatPayload = {
    star: STAR,
    live: true,
    ready: true,
    metrics: {},
    ts: now.toISOString(),
    boot_id: BOOT_ID,
  };
  const rev = revision(env);
  if (rev !== undefined) payload.revision = rev;
  return payload;
}

/**
 * Resolve the broker bootstrap: `KAFKA_BOOTSTRAP` — the canonical unprefixed
 * fleet key the services catalog injects — else the pantheon-net default
 * (`pontus:29092`). Pure — the env is injected.
 *
 * `PONTUS_BOOTSTRAP` was a second definition of the same fleet fact that
 * OUTRANKED the canonical key (one-definition F3). Nothing ever set it — not the
 * infra catalog, not any container — so it was a dead alias whose only possible
 * effect was to let a stray value silently beat the fleet's definition.
 */
export function resolveBootstrap(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KAFKA_BOOTSTRAP;
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
