/**
 * Backend selection for Calliope-MCP: pick the {@link BodyClient} the tool
 * handlers run against, from the environment.
 *
 *  - default / `"urania"`: a wired {@link UraniaBodyClient} over
 *    {@link LiveUraniaCapture}, writing the chaos substrate directly (env:
 *    `CHAOS_URL`; legacy `URANIA_URL` honored). Post-D1-cut, urania is a lens
 *    and serves no capture — the substrate is chaos. Preserved unchanged when
 *    `CALLIOPE_WRITE_VIA_HADES` is off.
 *  - `"hades"`: a wired {@link UraniaBodyClient} over {@link HadesCapture} —
 *    the F2 gateway-auth path (Charon → Hades → calliope-mcp). Selected
 *    automatically when `CALLIOPE_WRITE_VIA_HADES=1` / `CHARON_URL` is set, or
 *    explicitly via `CALLIOPE_MCP_BACKEND=hades`. Writes carry
 *    `authored_by = human` via the gateway `SET ROLE human` seam.
 *  - `"fixture"`: an in-memory {@link FixtureBodyClient} — for a safe
 *    standalone/dev server and for the tool tests.
 *
 * The live wire is gated by `CALLIOPE_URANIA_WIRED` inside
 * {@link UraniaBodyClient} (the lib's existing seam) — this factory sets it on
 * for the live backends so the injected transport is honored.
 */

import { Pool } from "pg";
import type { BodyClient } from "../types.js";
import type { DocumentStore } from "../document-store.js";
import { FixtureDocumentStore, PgDocumentStore } from "../document-store.js";
import type { RevisionStore } from "../revision-store.js";
import {
  type ChaosFacet,
  FixtureChaosDial,
  LiveChaosDial,
  notesScope,
} from "../chaos-client.js";
import { FixtureRevisionStore, PgRevisionStore } from "../revision-store.js";
import { FixtureBodyClient } from "../fixture-client.js";
import { UraniaBodyClient } from "../urania-client.js";
import { PgBodyClient } from "../pg-client.js";
import { LiveUraniaCapture } from "./live-capture.js";
import { HadesCapture, hadesEnabled } from "./hades-capture.js";
import { IndexingBodyClient, UraniaIndexClient } from "./index-push.js";

/** How the MCP reaches the body model. */
export type BackendKind = "urania" | "hades" | "fixture" | "pg";

/** Read the configured backend kind (default: pg when DATABASE_URL is set —
 * the C2 sovereign store — else live urania, or hades if enabled). */
export function backendKind(env: NodeJS.ProcessEnv = process.env): BackendKind {
  const explicit = env.CALLIOPE_MCP_BACKEND;
  if (explicit === "fixture") return "fixture";
  if (explicit === "hades") return "hades";
  if (explicit === "urania") return "urania";
  if (explicit === "pg") return "pg";
  // Auto-select the sovereign store when configured (C2 — the facet carve).
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") return "pg";
  // Auto-select hades when the env flag is set (CALLIOPE_WRITE_VIA_HADES or CHARON_URL).
  if (
    hadesEnabled(env) ||
    (env.CHARON_URL !== undefined && env.CHARON_URL !== "")
  )
    return "hades";
  return "urania";
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
 * assembled prose to urania's similarity index (the write-side body push). A
 * no-op wrap when no urania endpoint is configured, so tests and the fixture
 * backend stay push-free.
 */
function withIndexPush(client: BodyClient, env: NodeJS.ProcessEnv): BodyClient {
  const url = indexUrl(env);
  return url === undefined
    ? client
    : new IndexingBodyClient(client, new UraniaIndexClient(url));
}

/**
 * Build the {@link BodyClient} for the configured backend.
 *
 * - `"urania"`: direct engine-service via {@link LiveUraniaCapture} (clotho-parity).
 * - `"hades"`: gateway-auth path via {@link HadesCapture} (F2; `CHARON_URL`).
 * - `"fixture"`: in-memory {@link FixtureBodyClient} (dev/test).
 *
 * The directly-persisting backends (`pg`, `urania`) are wrapped with
 * {@link withIndexPush}; `hades` is not — its write is delegated over the
 * gateway to the server-side calliope-mcp, which performs the push itself.
 */
export function makeBodyClient(
  kind: BackendKind = backendKind(),
  env: NodeJS.ProcessEnv = process.env,
): BodyClient {
  if (kind === "fixture") {
    return new FixtureBodyClient();
  }
  if (kind === "pg") {
    // The sovereign store (C2). Schema bootstrap is async — the entrypoints
    // await initBodyClient() before serving (fail-fast on an unreachable db).
    return withIndexPush(
      new PgBodyClient(new Pool({ connectionString: env.DATABASE_URL })),
      env,
    );
  }
  // The UraniaBodyClient guards its transport behind CALLIOPE_URANIA_WIRED; the
  // live server opts in for both live backends.
  env.CALLIOPE_URANIA_WIRED = "1";
  if (kind === "hades") {
    // Gateway path: the write routes to the server-side calliope-mcp, which
    // does the index push as part of its own persistence — no push here.
    return new UraniaBodyClient(new HadesCapture(env.CHARON_URL, env));
  }
  // Default: clotho-parity direct urania engine-service.
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
  // Unwrap the index-push decorator: the production pg client is ALWAYS
  // wrapped, and the schema bootstrap must reach the bare store (found live
  // 2026-07-12 — the A11 tombstone migration never applied at boot).
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
}

/** Build the body client AND its facet stores from one backend selection. */
export function makeBackend(
  kind: BackendKind = backendKind(),
  env: NodeJS.ProcessEnv = process.env,
): Backend {
  if (kind === "fixture") {
    return {
      client: new FixtureBodyClient(),
      documents: new FixtureDocumentStore(),
      revisions: new FixtureRevisionStore(),
      chaos: { dial: new FixtureChaosDial(), scope: notesScope(env) },
    };
  }
  if (kind === "pg") {
    // ONE pool for every facet — the sovereign store is one database.
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    return {
      client: withIndexPush(new PgBodyClient(pool), env),
      documents: new PgDocumentStore(pool),
      revisions: new PgRevisionStore(pool),
      chaos: { dial: new LiveChaosDial(), scope: notesScope(env) },
    };
  }
  return { client: makeBodyClient(kind, env) };
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
}

// CI rake (2026-07-12): build.yml paths-ignore means an EMPTY commit spawns
// no run — a rebuild trigger needs a real diff outside md/.forgejo/infra.
