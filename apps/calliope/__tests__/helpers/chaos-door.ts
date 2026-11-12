/**
 * A fake chaos REST door for tests: GET /openapi.json answers a document
 * carrying every verb the dial sends (all POST), and each /v1/<verb> call is
 * recorded and answered by the test's handler in the result envelope.
 */

export const CHAOS_VERBS = [
  "admit",
  "capture",
  "find_by_name",
  "find_by_value",
  "held_blobs",
  "history",
  "index_document",
  "materialize_edges",
  "quads_from",
  "quads_to",
  "register_graph",
  "resolve_node_refs",
  "resolve_nodes",
  "resolve_scalars",
];

/** A chaos document carrying every verb the dial sends, all POST. */
export const CHAOS_DOC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "chaos", version: "0" },
  paths: Object.fromEntries(
    CHAOS_VERBS.map((v) => [
      `/v1/${v}`,
      {
        post: {
          operationId: v,
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: `#/x-mcp-tools/${v}/inputSchema` },
              },
            },
          },
          responses: { "200": { description: "ok" } },
          "x-mcp-match": {},
          "x-mcp-safe": false,
          "x-mcp-tool": v,
        },
      },
    ]),
  ),
  "x-mcp-tools": Object.fromEntries(
    CHAOS_VERBS.map((v) => [
      v,
      { name: v, inputSchema: { type: "object", properties: {} } },
    ]),
  ),
});

/** One recorded REST call. */
export interface WireCall {
  url: string;
  verb: string;
  args: Record<string, unknown>;
}

const ENVELOPE = "application/vnd.stellar.result+json";

/** Install a global fetch serving the chaos door; returns the recorded calls. */
export function installChaosDoor(answer: (c: WireCall) => unknown): {
  calls: WireCall[];
} {
  const calls: WireCall[] = [];
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    if (input.endsWith("/openapi.json")) {
      return Promise.resolve(
        new Response(CHAOS_DOC, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
      );
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const call: WireCall = {
      url: input,
      verb: new URL(input).pathname.replace(/^\/v1\//, ""),
      args: (body === "" ? {} : JSON.parse(body)) as Record<string, unknown>,
    };
    calls.push(call);
    const out = answer(call);
    // A Response (a refusal, say) goes out as built; anything else is the
    // structured content of a 200 in the result envelope.
    if (out instanceof Response) return Promise.resolve(out);
    return Promise.resolve(
      new Response(JSON.stringify({ text: "", structuredContent: out }), {
        status: 200,
        headers: { "Content-Type": ENVELOPE, "X-Star": "chaos" },
      }),
    );
  }) as unknown as typeof fetch;
  return { calls };
}
