#!/usr/bin/env bun

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
import { startTelemetry, telemetryConfigFromEnv } from "@forge/stellar-core-ts";
import type { RequestLog } from "@forge/stellar-core-ts";
import {
  makeConsciousnessPublisher,
  type NotePublisher,
} from "./consciousness-emit.js";
import { FocusRegister, startFocusConsumer } from "../focus-register.js";
import { makeErosProvider } from "../eros-provider.js";
import { makeWitness } from "./witness.js";
import type { Witness } from "./witness.js";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { mountRestFace } from "./rest.js";
import { createTelemetryProducer } from "../aglaia-ingest.js";
import type { TelemetryProducerLike } from "../aglaia-ingest.js";
import { MemoryJtiStore, actConfigFromEnv } from "../act-assertion.js";

/** The collaborators a server is built from (the MCP door's and REST's alike). */
export interface ServerDeps {
  revisions?: RevisionStore | undefined;
  chaos?: ChaosFacet | undefined;
  tags?: TagStore | undefined;
  focus?: FocusRegister | undefined;
  containers?: ContainerFacet | undefined;
  consciousness?: NotePublisher | undefined;
  witness?: RequestLog | undefined;
  telemetry?: TelemetryProducerLike | undefined;
}

/** The {@link createServer} options for `deps`: one place, so MCP and REST serve one surface. */
export function serverOptions(deps: ServerDeps): ServerOptions {
  const search = makeErosProvider();
  return {
    ...(deps.revisions !== undefined ? { revisions: deps.revisions } : {}),
    ...(deps.chaos !== undefined ? { chaos: deps.chaos } : {}),
    ...(deps.tags !== undefined ? { tags: deps.tags } : {}),
    ...(deps.focus !== undefined ? { focus: deps.focus } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(deps.containers !== undefined ? { containers: deps.containers } : {}),
    ...(deps.consciousness !== undefined
      ? { consciousness: deps.consciousness }
      : {}),
    witness: deps.witness,
    ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
  };
}

/** What {@link serveCalliope} is built from: the backend facets and the mesh. */
export interface ServeOptions extends Omit<ServerDeps, "witness"> {
  readonly kind?: ReturnType<typeof backendKind>;
  /** A built, initialised client (the pg backend); absent builds `kind`'s full backend. */
  readonly client?: BodyClient | undefined;
  /** The witness: its log records every call, and it is closed with the door. */
  readonly witness: Witness;
  /** Reads the environment (the REST port, the act config). Default: `process.env`. */
  readonly getenv?: ((name: string) => string | undefined) | undefined;
}

/**
 * Serve calliope: the REST door on `STELLAR_REST_PLAINTEXT_PORT`, the star's
 * ONLY listener (REST mesh P7, wonka68-rm39). There is no `/mcp` and no
 * loopback listener: every caller reaches calliope on the REST door, and the
 * door answers `/live`, `/ready` and `/metrics` itself. Rejects (nothing
 * served) when the port is unset or cannot be bound, or the server has no door.
 */
export async function serveCalliope(o: ServeOptions): Promise<RestMount> {
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
  const focus = o.focus ?? new FocusRegister();
  const body = client;
  const env = o.getenv ?? ((k: string) => process.env[k]);
  const act = {
    jti: deps.revisions ?? new MemoryJtiStore(),
    config: actConfigFromEnv({
      CALLIOPE_ACT_JWKS_URL: env("CALLIOPE_ACT_JWKS_URL"),
      STELLAR_KAIROS_JWKS_URL: env("STELLAR_KAIROS_JWKS_URL"),
      CALLIOPE_ACT_ISSUER: env("CALLIOPE_ACT_ISSUER"),
      CALLIOPE_ACT_TRUST_DOMAIN: env("CALLIOPE_ACT_TRUST_DOMAIN"),
    }),
  };
  let rest: RestMount;
  try {
    rest = await mountRestFace({
      build: () => createServer(body, serverOptions({ ...deps, focus })),
      getenv: o.getenv,
      act,
    });
  } catch (err) {
    await o.witness.close();
    throw err;
  }
  return {
    ...rest,
    close: async () => {
      await rest.close();
      await o.witness.close();
    },
  };
}

async function main(): Promise<void> {
  const telemetryShutdown = await startTelemetry(telemetryConfigFromEnv());

  const kind = backendKind();
  const backend = await prepareBackend(kind);
  await initBackend(backend);
  const consciousness = makeConsciousnessPublisher(process.env);
  const focusRegister = new FocusRegister();
  const focusConsumer = startFocusConsumer(focusRegister);
  const witness = makeWitness();
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
    telemetry: createTelemetryProducer(),
  });
  process.stderr.write(
    `calliope serving (backend=${kind}) door=${String(rest.plaintextAddress()?.port)}\n`,
  );

  const shutdown = (): void => {
    void focusConsumer.stop();
    void telemetryShutdown();
    void rest.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `calliope-mcp-http: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
