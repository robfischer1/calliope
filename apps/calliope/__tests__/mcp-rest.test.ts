import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { RestRequest } from "@forge/stellar-core-ts/rest";
import { makeBackend } from "../src/mcp/backend.js";
import { serverOptions } from "../src/mcp/http.js";
import { mountRestFace, spanned } from "../src/mcp/rest.js";
import { createServer } from "../src/mcp/server.js";
import { recordingWitness } from "./rest-door.js";

/**
 * The REST face: the star's only listener (REST mesh P7, rm39). Refused when
 * the server has no door or the REST port is unset; otherwise the same verbs,
 * witnessed.
 */

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
  it("refuses the mount when the server has no door", async () => {
    const { witness } = recordingWitness();
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
        getenv: port0,
      }),
    ).rejects.toThrow(/mounting REST: .*no door/);
  });

  it("refuses the mount with no REST port: the star never boots doorless", async () => {
    const { witness } = recordingWitness();
    await expect(
      mountRestFace({ build: doored(), witness, getenv: () => undefined }),
    ).rejects.toThrow(/STELLAR_REST_PLAINTEXT_PORT/);
  });
});

describe("the REST door", () => {
  it("serves the spec, refuses an unknown verb, and witnesses a real call", async () => {
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
      witness,
      getenv: port0,
    });
    closers.push(() => rest.close());
    const base = `http://127.0.0.1:${String(rest.plaintextAddress()?.port)}`;

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
    const call = await fetch(`${base}/v1/list_tags`);
    expect(call.status).toBe(200);
    const verbs = got.slice(before).map((r) => r.verb);
    expect(verbs).toContain("list_tags");
    expect(verbs).toContain("rest.list_tags");

    // No MCP route beside it.
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
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
