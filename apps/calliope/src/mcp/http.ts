#!/usr/bin/env bun
/**
 * Calliope's network entry point: the prose facet served as a constellation
 * star on its REST door (`/openapi.json`, `/v1/...`), the SAME server the stdio
 * bin serves ({@link createServer} over the env-selected {@link makeBackend}
 * backend); the tool definitions are reused, never forked.
 *
 * REST only (REST mesh P7, wonka68-rm39): no `/mcp`, no loopback listener. The
 * door is `STELLAR_REST_PLAINTEXT_PORT` (8207), which also answers `/live`,
 * `/ready` and `/metrics`. Each REST call runs on a fresh server built per
 * mount over ONE long-lived backend client.
 *
 * Backend: `pg` when `DATABASE_URL` is set (the sovereign store, the production
 * default), else the chaos substrate over `CHAOS_URL`, or the in-memory fixture
 * via `CALLIOPE_MCP_BACKEND=fixture`. On boot, also starts the op-contract
 * heartbeat publisher ({@link startHeartbeat}, from stellar-core-ts).
 */

import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import type { BodyClient } from "../types.js";
import type { ContainerFacet } from "../container-write.js";
import type { RevisionStore } from "../revision-store.js";
import {
  backendKind,
  initBackend,
  makeBackend,
  prepareBackend,
} from "./backend.js";
import { createServer } from "./server.js";
import type { ServerOptions } from "./server.js";
import type { ChaosFacet } from "../chaos-client.js";
import type { TagStore } from "../tag-store.js";
import {
  startHeartbeat,
  startTelemetry,
  telemetryConfigFromEnv,
} from "@forge/stellar-core-ts";
import type { HeartbeatOptions, RequestLog } from "@forge/stellar-core-ts";
import {
  SOURCE_STAR,
  consciousnessMetrics,
  makeConsciousnessPublisher,
  type NotePublisher,
} from "./consciousness-emit.js";
import { convergeMetrics } from "../converge-witness.js";
import { FocusRegister, startFocusConsumer } from "../focus-register.js";
import { makeErosProvider } from "../eros-provider.js";
import { reservedHeaders } from "@forge/stellar-core-ts/identitycore";
import { makeWitness } from "./witness.js";
import type { Witness } from "./witness.js";
import {
  loadPep,
  pepConfigFromEnv,
  startPepMetrics,
} from "@forge/stellar-core-ts/pep";
import type { Pep } from "@forge/stellar-core-ts/pep";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { mountRestFace } from "./rest.js";

/**
 * How this star beats: its name, and what it can say about itself each beat.
 *
 * The PUBLISHER is the core's since `@forge/stellar-core-ts` 0.12.0 — calliope
 * had hand-rolled the whole thing (`src/mcp/heartbeat.ts`, deleted), and its
 * own module doc called it "the bun-side mirror of the Python stars'
 * `stellar_core.AsyncHeartbeatPublisher`". The loop, the 30s cadence, the
 * process-scoped `boot_id`, the `STELLAR_REVISION` read, the broker and the
 * graceful degradation all live there now. What is left here is the only half
 * that was ever this star's: who it is, and how it is doing.
 *
 * `SOURCE_STAR` rather than a second `"calliope"` literal — it is this star's
 * `star.toml` name, which the consciousness producer already stamps on every
 * event. A heartbeat beating under one name while the consciousness plane
 * carried another would be attributed to two stars, and nothing downstream
 * could tell.
 *
 * `ready: true` unconditionally, which is exactly what this star has always
 * published: the HTTP listener is up by the time the beat starts, and there is
 * no probe behind it that could answer otherwise. A real readiness latch — the
 * store's health, the broker's — is the deferred half of the heartbeat
 * contract, in this star and in the core.
 *
 * Split out of `main()` and exported because `main()` is the bin entry and no
 * test drives it: stated inline there, every one of these decisions would be
 * stated untested.
 */
export function heartbeatOptions(): HeartbeatOptions {
  return {
    star: SOURCE_STAR,
    // Read PER BEAT, so a counter that moves between beats is reported as it
    // stands rather than as it was at boot.
    standing: () => ({
      ready: true,
      metrics: { ...consciousnessMetrics(), ...convergeMetrics() },
    }),
  };
}

/** The collaborators a server is built from (the MCP door's and REST's alike). */
export interface ServerDeps {
  revisions?: RevisionStore | undefined;
  chaos?: ChaosFacet | undefined;
  tags?: TagStore | undefined;
  focus?: FocusRegister | undefined;
  containers?: ContainerFacet | undefined;
  consciousness?: NotePublisher | undefined;
  witness?: RequestLog | undefined;
  pep?: Pep | undefined;
}

/** The {@link createServer} options for `deps`: one place, so MCP and REST serve one surface. */
export function serverOptions(deps: ServerDeps): ServerOptions {
  // Findability F4: the pg arm — eros-routed when CALLIOPE_EROS_URL is set;
  // absent, the search verb answers honest darkness (F2's contract).
  const search = makeErosProvider();
  return {
    ...(deps.revisions !== undefined ? { revisions: deps.revisions } : {}),
    ...(deps.chaos !== undefined ? { chaos: deps.chaos } : {}),
    ...(deps.tags !== undefined ? { tags: deps.tags } : {}),
    ...(deps.focus !== undefined ? { focus: deps.focus } : {}),
    ...(search !== undefined ? { search } : {}),
    // F12 audit finding: the container surface (F4/F5) was wired in
    // the BACKEND but never passed to the server — the fleet entry
    // points served body verbs only. With the families retired, the
    // container verbs ARE the write path; they ship from here.
    ...(deps.containers !== undefined ? { containers: deps.containers } : {}),
    ...(deps.consciousness !== undefined
      ? { consciousness: deps.consciousness }
      : {}),
    witness: deps.witness,
    pep: deps.pep,
  };
}

/** What {@link serveCalliope} is built from: the backend facets and the mesh. */
export interface ServeOptions extends Omit<ServerDeps, "witness"> {
  readonly kind?: ReturnType<typeof backendKind>;
  /** A built, initialised client (the pg backend); absent builds `kind`'s full backend. */
  readonly client?: BodyClient | undefined;
  /** The witness: its log records every call, and it is closed with the door. */
  readonly witness: Witness;
  /** Reads the environment (the REST port, the trust mode). Default: `process.env`. */
  readonly getenv?: ((name: string) => string | undefined) | undefined;
}

/**
 * Serve calliope: the REST door on `STELLAR_REST_PLAINTEXT_PORT`, the star's
 * ONLY listener (REST mesh P7, wonka68-rm39). There is no `/mcp` and no
 * loopback listener: every caller reaches calliope on the REST door, and the
 * door answers `/live`, `/ready` and `/metrics` itself. Rejects (nothing
 * served) when the port is unset or cannot be bound, or the server has no door.
 *
 * THE IDENTITY CORE LOADS FIRST, before anything is built. Lazily, a core that
 * cannot load (stellar-core-ts 0.17.0 read its wasm off disk, beside a one-file
 * bundle that does not carry it) took the process down on whichever call typed
 * a peer first, seconds into a pod that had already said "serving". Now boot
 * fails before the star serves, where the build lane's boot smoke sees it.
 */
export async function serveCalliope(o: ServeOptions): Promise<RestMount> {
  reservedHeaders();
  // One backend for the server's lifetime; a caller that needs async init (the
  // pg backend) builds and inits the client itself and passes it in. With no
  // client, the FULL backend of `kind`, so the fixture path serves every verb.
  let deps: ServerDeps = { ...o, witness: o.witness.log };
  let client = o.client;
  if (client === undefined) {
    const backend = makeBackend(o.kind ?? backendKind());
    client = backend.client;
    deps = {
      ...deps,
      revisions: o.revisions ?? backend.revisions,
      chaos: o.chaos ?? backend.chaos,
      tags: o.tags ?? backend.tags,
      containers: o.containers ?? backend.containers,
    };
  }
  // Every server carries a register (an empty one answers { focus: null }).
  const focus = o.focus ?? new FocusRegister();
  const body = client;
  let rest: RestMount;
  try {
    rest = await mountRestFace({
      build: () => createServer(body, serverOptions({ ...deps, focus })),
      witness: o.witness,
      getenv: o.getenv,
    });
  } catch (err) {
    await o.witness.close();
    throw err;
  }
  return {
    ...rest,
    // The sink's producer lives and dies with the door that feeds it.
    close: async () => {
      await rest.close();
      await o.witness.close();
    },
  };
}

async function main(): Promise<void> {
  // FIRST, and bounded. stellar-core-ts 0.5.0's sender resolves its config from
  // OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_SERVICE_NAME, both of which this star's
  // deployment already sets — an empty endpoint disables export rather than
  // erroring, and startTelemetry cannot outlive its budget, so this cannot stop
  // the door from binding. Before initBackend because a span is only useful if
  // the provider exists when the first request lands.
  const telemetryShutdown = await startTelemetry(telemetryConfigFromEnv());

  const kind = backendKind();
  // The endpoint PEP (Constellation Mesh F7): witness by default, enforce on
  // STELLAR_PEP_MODE=enforce. FAIL-CLOSED BOOT: a missing or unparseable
  // composed sidecar throws here, before the backend is touched or the door binds, and main's catch
  // exits non-zero. Nothing is listening yet, so nothing is served unguarded.
  // stellar_pep_decisions_total rides the OTLP metrics pipeline (a no-op with
  // no OTEL destination), and STELLAR_PDP_URL arms the policy-plane consult.
  const pepMetrics = startPepMetrics(SOURCE_STAR);
  const pep = loadPep({
    ...pepConfigFromEnv(SOURCE_STAR),
    onDecision: pepMetrics.record,
  });
  const backend = await prepareBackend(kind);
  await initBackend(backend);
  // Stream of Consciousness pass 4: ONE producer for the process (the
  // servers are per-request; the broker connection is not).
  const consciousness = makeConsciousnessPublisher(process.env);
  // 028 ("Look At This" F5): one register for the process, written by the
  // focus consumer (`startFocusConsumer`, kafkatopics), read by every
  // stateless request's `look`.
  const focusRegister = new FocusRegister();
  const focusConsumer = startFocusConsumer(focusRegister);
  // The witness: one record per inbound tools/call, to the log stream and to
  // calliope._ops.calls when KAFKA_BOOTSTRAP names a broker.
  const witness = makeWitness();
  // The REST door is the star's only listener; a refused mount throws and the
  // process exits before it serves half a door.
  const rest = await serveCalliope({
    kind,
    client: backend.client,
    revisions: backend.revisions,
    chaos: backend.chaos,
    tags: backend.tags,
    focus: focusRegister,
    containers: backend.containers,
    consciousness,
    witness,
    pep,
  });
  // stderr only — keep stdout clean (parity with the stdio bin's convention).
  process.stderr.write(
    `calliope serving (backend=${kind}) door=${String(rest.plaintextAddress()?.port)}\n`,
  );

  // Publish liveness to the telemetry bus (stellar-core-ts `startHeartbeat`,
  // the op-contract heartbeat) now that we serve.
  const heartbeat = startHeartbeat(heartbeatOptions());

  const shutdown = (): void => {
    void heartbeat.stop();
    void focusConsumer.stop();
    // Flush what the batch processor is holding; a SIGTERM'd pod otherwise
    // drops its last window of spans, which is exactly the window that
    // explains why it was terminated.
    void telemetryShutdown();
    void pepMetrics.shutdown();
    void rest.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run only when invoked as the bin, not when imported by a test — compare the
// resolved entry path (argv[1]) against this module's URL (ESM "is main").
const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `calliope-mcp-http: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
