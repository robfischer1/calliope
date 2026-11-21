import { Client, Pool } from "pg";
import { dbLogin } from "@forge/stellar-core-ts";
import type { DbLogin, DbLoginOptions } from "@forge/stellar-core-ts";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import { PgDocumentStore } from "../document-store.js";
import { NotesDocumentStore } from "../notes-document-store.js";
import type { RevisionStore } from "../revision-store.js";
import {
  type ChaosFacet,
  FixtureChaosDial,
  LiveChaosDial,
  notesScope,
} from "../chaos-client.js";
import {
  BlobStore,
  FixtureBlobGc,
  FixtureBlobStore,
  PgBlobGc,
} from "../blob-store.js";
import type { ContainerFacet } from "../container-write.js";
import { FixtureTagStore, PgTagStore, type TagStore } from "../tag-store.js";
import { FixtureRevisionStore, PgRevisionStore } from "../revision-store.js";
import { attributing } from "../attributing-dial.js";
import { FixtureBodyClient } from "../fixture-client.js";
import { UraniaBodyClient } from "../urania-client.js";
import { PgBodyClient } from "../pg-client.js";
import { LiveUraniaCapture } from "./live-capture.js";
import { HadesCapture, hadesEnabled } from "./hades-capture.js";
import {
  fanOutPushers,
  IndexingBodyClient,
  UraniaIndexClient,
} from "./index-push.js";
import type { IndexPusher } from "./index-push.js";

/** How the MCP reaches the body model. */
export type BackendKind = "urania" | "hades" | "fixture" | "pg";

/** Read the configured backend kind (default: pg — the sovereign store IS the
 * body store post-cutover (F2); urania survives as an explicit opt-in only,
 * and hades still auto-selects on its env flags). */
export function backendKind(env: NodeJS.ProcessEnv = process.env): BackendKind {
  const explicit = env.CALLIOPE_MCP_BACKEND;
  if (explicit === "fixture") return "fixture";
  if (explicit === "hades") return "hades";
  if (explicit === "urania") return "urania";
  if (explicit === "pg") return "pg";
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") return "pg";
  if (
    hadesEnabled(env) ||
    (env.CHARON_URL !== undefined && env.CHARON_URL !== "")
  )
    return "hades";
  return "pg";
}

/**
 * The sovereign store's connection string, or a loud refusal. `new Pool({})`
 * with an undefined connectionString silently falls back to libpq defaults —
 * a third wrong store — so absence throws here, at construction.
 */
function pgConnectionString(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "calliope: DATABASE_URL is required for the pg backend (the sovereign " +
        "store is the default since the F2 cutover). Set it, or select a " +
        "backend explicitly via CALLIOPE_MCP_BACKEND.",
    );
  }
  return url;
}

/**
 * The sovereign store's pool. With no `login` it is the bare DATABASE_URL,
 * exactly as before F7; with one (from {@link prepareBackend}) it is whatever
 * STELLAR_DB_AUTH asked for — in svid mode a stripped DSN and a pg Client
 * that presents the star's CURRENT SVID on every new connection
 * (stellar-core-ts dbauth).
 */
export function pgPool(
  env: NodeJS.ProcessEnv,
  login?: DbLogin<typeof Client>,
): Pool {
  return new Pool(login ?? { connectionString: pgConnectionString(env) });
}

/**
 * The urania endpoint the write-side body push targets (B): an explicit
 * `CALLIOPE_INDEX_URL`, else the same urania/chaos URL the direct backend uses.
 * Absent (e.g. the fixture/test env) → no push wrapping.
 */
function indexUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.CALLIOPE_INDEX_URL ?? env.URANIA_URL ?? env.CHAOS_URL;
  return url !== undefined && url !== "" ? url : undefined;
}

/**
 * Wrap a directly-persisting body client so every write also pushes the
 * assembled prose to the configured projections — urania's similarity index.
 * A no-op wrap when none is configured, so tests and the fixture backend stay
 * push-free.
 */
function withIndexPush(client: BodyClient, env: NodeJS.ProcessEnv): BodyClient {
  const pushers: IndexPusher[] = [];
  const url = indexUrl(env);
  if (url !== undefined) pushers.push(new UraniaIndexClient(url));
  if (pushers.length === 0) return client;
  const pusher = pushers.length === 1 ? pushers[0] : fanOutPushers(pushers);
  return pusher === undefined ? client : new IndexingBodyClient(client, pusher);
}

/** Build the {@link BodyClient} for the configured backend. */
export function makeBodyClient(
  kind: BackendKind = backendKind(),
  env: NodeJS.ProcessEnv = process.env,
): BodyClient {
  if (kind === "fixture") {
    return new FixtureBodyClient();
  }
  if (kind === "pg") {
    return withIndexPush(
      new PgBodyClient(new Pool({ connectionString: pgConnectionString(env) })),
      env,
    );
  }
  env.CALLIOPE_URANIA_WIRED = "1";
  if (kind === "hades") {
    return new UraniaBodyClient(new HadesCapture(env.CHARON_URL, env));
  }
  return withIndexPush(
    new UraniaBodyClient(
      new LiveUraniaCapture(env.CHAOS_URL ?? env.URANIA_URL),
    ),
    env,
  );
}

/**
 * Async backend initialization: bootstrap the sovereign store's schema when
 * the pg backend is selected (idempotent), a no-op otherwise. Entrypoints
 * await this BEFORE serving so an unreachable/unbootstrappable database
 * fails the boot loudly instead of failing the first request.
 */
export async function initBodyClient(client: BodyClient): Promise<void> {
  if (client instanceof IndexingBodyClient) {
    await initBodyClient(client.inner);
    return;
  }
  if (client instanceof PgBodyClient) {
    await client.ensureSchema();
  }
}

/** The full backend a server runs against: the body client + optional facets. */
export interface Backend {
  client: BodyClient;
  /**
   * The document store (C3). Present on the pg backend (the sovereign store —
   * one pool shared with the body client) and the fixture backend (in-memory);
   * absent on the substrate-direct backends, which have no document home.
   */
  documents?: DocumentStore;
  /** The revision store (C4) — same presence rule as `documents`. */
  revisions?: RevisionStore;
  /** The graph-write muscle (C8) — same presence rule as `documents`. */
  chaos?: ChaosFacet;
  /** The container surface (041 F4) — the blob store + the dial, the
   *  write path's facet. Same presence rule as `documents`. */
  containers?: ContainerFacet;
  /** The tag mirror (C9) — same presence rule as `documents`. */
  tags?: TagStore;
}

/** Build the body client AND its facet stores from one backend selection. */
export function makeBackend(
  kind: BackendKind = backendKind(),
  env: NodeJS.ProcessEnv = process.env,
  login?: DbLogin<typeof Client>,
): Backend {
  if (kind === "fixture") {
    const client = new FixtureBodyClient();
    const revisions = new FixtureRevisionStore();
    const dial = attributing(new FixtureChaosDial(), revisions);
    const scope = notesScope(env);
    const tags = new FixtureTagStore();
    return {
      client,
      documents: new NotesDocumentStore(client, dial, scope, tags),
      revisions,
      chaos: { dial, scope },
      containers: (() => {
        const blobs = new FixtureBlobStore();
        return { blobs, dial, gc: new FixtureBlobGc(blobs) };
      })(),
      tags,
    };
  }
  if (kind === "pg") {
    const pool = pgPool(env, login);
    const client = withIndexPush(new PgBodyClient(pool), env);
    const revisions = new PgRevisionStore(pool);
    const dial = attributing(new LiveChaosDial(), revisions);
    const scope = notesScope(env);
    const tags = new PgTagStore(pool);
    return {
      client,
      documents: new NotesDocumentStore(client, dial, scope, tags),
      revisions,
      chaos: { dial, scope },
      containers: { blobs: new BlobStore(pool), dial, gc: new PgBlobGc(pool) },
      tags,
    };
  }
  return { client: makeBodyClient(kind, env) };
}

/**
 * {@link makeBackend} with the database login resolved first — what a running
 * star calls. The pg backend's login comes from STELLAR_DB_AUTH
 * (stellar-core-ts `dbLogin`): unset or "kairos" is the DSN as delivered;
 * "svid" waits (bounded) for the workload identity, so a fresh pod that beats
 * SPIRE to its first connect pauses instead of crashing. `opts` is the
 * test seam (the identity source, the wait).
 */
export async function prepareBackend(
  kind: BackendKind = backendKind(),
  env: NodeJS.ProcessEnv = process.env,
  opts: DbLoginOptions = {},
): Promise<Backend> {
  if (kind !== "pg") return makeBackend(kind, env);
  const login = await dbLogin(pgConnectionString(env), Client, {
    ...opts,
    env,
  });
  return makeBackend(kind, env, login);
}

/** Async init for a {@link Backend}: bootstrap every pg-backed schema. */
export async function initBackend(backend: Backend): Promise<void> {
  await initBodyClient(backend.client);
  if (backend.documents instanceof PgDocumentStore) {
    await backend.documents.ensureSchema();
  }
  if (backend.revisions instanceof PgRevisionStore) {
    await backend.revisions.ensureSchema();
  }
  if (backend.tags instanceof PgTagStore) {
    await backend.tags.ensureSchema();
  }
}
