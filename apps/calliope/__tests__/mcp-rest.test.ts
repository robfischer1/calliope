import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLog } from "@forge/stellar-core-ts";
import type { RequestRecord } from "@forge/stellar-core-ts";
import { RouteMux } from "@forge/stellar-core-ts/rest";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { makeBackend } from "../src/mcp/backend.js";
import {
  createCalliopeHttpServer,
  isRestPath,
  serverOptions,
} from "../src/mcp/http.js";
import { mountRestFace } from "../src/mcp/rest.js";
import { createServer } from "../src/mcp/server.js";
import type { Witness } from "../src/mcp/witness.js";

/**
 * The REST face: off by default, refused when the server has no door, and
 * (STELLAR_REST=1) the same verbs as the MCP door, witnessed.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function recording(): { witness: Witness; got: RequestRecord[] } {
  const got: RequestRecord[] = [];
  return {
    witness: {
      log: new RequestLog("calliope", {
        sink: (r) => {
          got.push(r);
        },
      }),
      close: () => Promise.resolve(),
    },
    got,
  };
}

const on = (k: string): string | undefined =>
  k === "STELLAR_REST" ? "1" : undefined;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("isRestPath", () => {
  it("claims the spec and /v1/, nothing else", () => {
    expect(isRestPath("/openapi.json")).toBe(true);
    expect(isRestPath("/v1/list_tags")).toBe(true);
    expect(isRestPath("/v1")).toBe(false);
    expect(isRestPath("/mcp")).toBe(false);
    expect(isRestPath(undefined)).toBe(false);
  });
});

describe("mountRestFace refusal paths", () => {
  it("mounts nothing when STELLAR_REST is not 1", async () => {
    const { witness } = recording();
    const mux = new RouteMux();
    let built = 0;
    for (const value of [undefined, "0", "true", ""]) {
      const rest = await mountRestFace({
        build: () => {
          built += 1;
          return new McpServer({ name: "x", version: "0" });
        },
        witness,
        mux,
        getenv: (k) => (k === "STELLAR_REST" ? value : undefined),
      });
      expect(rest).toBeUndefined();
    }
    expect(built).toBe(0);
    const base = await listen(
      createCalliopeHttpServer(
        "fixture",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mux,
      ),
    );
    expect((await fetch(`${base}/openapi.json`)).status).toBe(404);
  });

  it("refuses the mount when the server has no door", async () => {
    const { witness } = recording();
    await expect(
      mountRestFace({
        build: () => {
          const bare = new McpServer({ name: "x", version: "0" });
          bare.registerTool("ping", { description: "ping" }, () => ({
            content: [{ type: "text", text: "pong" }],
          }));
          return bare;
        },
        witness,
        mux: new RouteMux(),
        getenv: on,
      }),
    ).rejects.toThrow(/mounting REST: .*no door/);
  });

  it("refuses a second mount on one mux", async () => {
    const { witness } = recording();
    const backend = makeBackend("fixture");
    const mux = new RouteMux();
    const build = (): McpServer =>
      createServer(
        backend.client,
        serverOptions({ witness: witness.log, containers: backend.containers }),
      );
    const first = await mountRestFace({
      build,
      witness,
      mux,
      getenv: on,
    });
    closers.push(() => first?.close() ?? Promise.resolve());
    await expect(
      mountRestFace({
        build,
        witness,
        mux,
        getenv: on,
      }),
    ).rejects.toThrow(/mounting REST/);
  });
});

const onMux = (k: string): string | undefined =>
  k === "STELLAR_REST" || k === "STELLAR_REST_PLAINTEXT_ON_MUX"
    ? "1"
    : undefined;

describe("REST on (STELLAR_REST=1)", () => {
  it("refuses REST on the legacy plaintext MCP listener (404, no route)", async () => {
    const { witness } = recording();
    const backend = makeBackend("fixture");
    const mux = new RouteMux();
    const rest = await mountRestFace({
      build: () =>
        createServer(
          backend.client,
          serverOptions({
            witness: witness.log,
            containers: backend.containers,
          }),
        ),
      witness,
      mux,
      getenv: on,
    });
    closers.push(() => rest?.close() ?? Promise.resolve());
    const base = await listen(
      createCalliopeHttpServer(
        "fixture",
        backend.client,
        backend.documents,
        backend.revisions,
        backend.chaos,
        backend.tags,
        undefined,
        backend.containers,
        undefined,
        witness,
        undefined,
        mux,
      ),
    );
    for (const path of ["/openapi.json", "/v1/list_tags"]) {
      const resp = await fetch(`${base}${path}`);
      expect(resp.status).toBe(404);
      expect(await resp.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("serves the spec and refuses an unknown verb through the star's listener", async () => {
    const { witness, got } = recording();
    const backend = makeBackend("fixture");
    const mux = new RouteMux();
    const rest: RestMount | undefined = await mountRestFace({
      build: () =>
        createServer(
          backend.client,
          serverOptions({
            witness: witness.log,
            containers: backend.containers,
            chaos: backend.chaos,
            tags: backend.tags,
          }),
        ),
      witness,
      mux,
      getenv: onMux,
    });
    expect(rest).toBeDefined();
    closers.push(() => rest?.close() ?? Promise.resolve());
    const base = await listen(
      createCalliopeHttpServer(
        "fixture",
        backend.client,
        backend.documents,
        backend.revisions,
        backend.chaos,
        backend.tags,
        undefined,
        backend.containers,
        undefined,
        witness,
        undefined,
        mux,
      ),
    );

    const spec = await fetch(`${base}/openapi.json`);
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { openapi: string; paths: object };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    // An unknown verb is a refusal, never a 200 and never a hang.
    const unknown = await fetch(`${base}/v1/no_such_verb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);

    // A real verb is called and recorded by the witness: REST is not a back door.
    const before = got.length;
    const call = await fetch(`${base}/v1/list_tags`, {
      method: "GET",
    });
    expect(call.status).toBe(200);
    const verbs = got.slice(before).map((r) => r.verb);
    expect(verbs).toContain("list_tags");
    expect(verbs).toContain("rest.list_tags");

    // The MCP route still answers beside it.
    const mcp = await fetch(`${base}/mcp`, { method: "GET" });
    expect(mcp.status).toBe(405);
  });
});
