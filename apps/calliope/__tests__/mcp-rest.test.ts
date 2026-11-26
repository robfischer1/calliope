import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { RestRequest } from "@forge/stellar-core-ts/rest";
import { makeBackend } from "../src/mcp/backend.js";
import { serveCalliope, serverOptions } from "../src/mcp/http.js";
import { mountRestFace, spanned } from "../src/mcp/rest.js";
import { createServer } from "../src/mcp/server.js";
import { recordingWitness } from "./rest-door.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

const port0 = (k: string): string | undefined =>
  k === "STELLAR_REST_PLAINTEXT_PORT" ? "0" : undefined;

const doored = (): (() => McpServer) => {
  const { witness } = recordingWitness();
  const backend = makeBackend("fixture");
  return () =>
    createServer(
      backend.client,
      serverOptions({ witness: witness.log, containers: backend.containers }),
    );
};

describe("mountRestFace refusal paths", () => {
  it("refuses the mount with no REST port: the star never boots doorless", async () => {
    await expect(
      mountRestFace({ build: doored(), getenv: () => undefined }),
    ).rejects.toThrow(/STELLAR_REST_PLAINTEXT_PORT/);
  });
});

describe("the REST door", () => {
  it("serves the spec, refuses an unknown verb, and serves a real call", async () => {
    const { witness, got } = recordingWitness();
    const backend = makeBackend("fixture");
    const rest = await mountRestFace({
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
      getenv: port0,
    });
    closers.push(() => rest.close());
    const base = `http://127.0.0.1:${String(rest.plaintextAddress()?.port)}`;

    const spec = await fetch(`${base}/openapi.json`);
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { openapi: string; paths: object };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    const unknown = await fetch(`${base}/v1/no_such_verb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);

    const before = got.length;
    const call = await fetch(`${base}/v1/list_tags`);
    expect(call.status).toBe(200);
    expect(got.slice(before).map((r) => r.verb)).toContain("list_tags");

    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
  });

  it("the committed openapi.json is the document the star serves", async () => {
    const { witness } = recordingWitness();
    const rest = await serveCalliope({
      kind: "fixture",
      witness,
      getenv: port0,
    });
    closers.push(() => rest.close());
    const base = `http://127.0.0.1:${String(rest.plaintextAddress()?.port)}`;
    const res = await fetch(`${base}/openapi.json`);
    const served = (await res.json()) as unknown;
    const committed = JSON.parse(
      readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(committed).toEqual(served);
  });

  it("spanned passes the request and the answer through unchanged", async () => {
    const answer = { status: 201, headers: {}, body: "x" };
    const seen: string[] = [];
    const handler = spanned((req) => {
      seen.push(req.target);
      return Promise.resolve(answer);
    });
    const res = await handler({
      method: "GET",
      target: "/v1/look",
    } as unknown as RestRequest);
    expect(res).toBe(answer);
    expect(seen).toEqual(["/v1/look"]);
  });
});
