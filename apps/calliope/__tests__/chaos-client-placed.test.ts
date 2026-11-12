/**
 * The placed reads delete_note retracts by: materialize_edges full (each
 * outbound fact with its scope) and quads_to full (each inbound node fact
 * with its scope), on the live and the desktop dial, plus the graph pin
 * opRemove carries. fetch is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LiveChaosDial,
  chaosRows,
  graphToken,
  opRemove,
  placedGraph,
  scopeHash,
} from "../src/chaos-client.js";
import { LocalChaosDial, toCaptureOps } from "../src/local-admit.js";
import { installChaosDoor, type WireCall } from "./helpers/chaos-door.js";

const NODE = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const G = "cc".repeat(32);

let calls: WireCall[] = [];
let reply: unknown = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  reply = null;
  calls = installChaosDoor(() => reply).calls;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const live = () =>
  new LiveChaosDial({
    themisUrl: "http://themis:8203",
    chaosUrl: "http://chaos:8209",
  });

describe("graphToken / opRemove's pin", () => {
  it("keeps a token and hashes a name", () => {
    expect(graphToken(G)).toBe(G);
    expect(graphToken("notes")).toBe(scopeHash("notes"));
  });

  it("opRemove carries graph only when given", () => {
    expect(opRemove(NODE, "p", { toLiteral: "v" }, G)).toEqual({
      op: "removeEdge",
      from_id: NODE,
      predicate: "p",
      to_literal: "v",
      to_node: null,
      graph: G,
    });
    expect("graph" in opRemove(NODE, "p", { toLiteral: "v" })).toBe(false);
  });

  it("the desktop translation honours the pin", () => {
    const [op] = toCaptureOps(
      [opRemove(NODE, "p", { toNode: OTHER }, G)],
      "notes",
    );
    expect(op).toMatchObject({ op: "removeEdge", g: G });
  });
});

describe("LiveChaosDial.placedEdges", () => {
  it("asks materialize_edges for the full form and maps every domain", async () => {
    reply = {
      edges: [
        { predicate: "hasName", value: "A", is_node: false, graph: "notes" },
        { predicate: "parent", value: OTHER, is_node: true, graph: G },
        {
          predicate: "tree_content",
          value: "17",
          is_node: false,
          domain: "blob",
          graph: G,
        },
      ],
    };
    expect(await live().placedEdges(NODE)).toEqual([
      {
        subject: NODE,
        predicate: "hasName",
        value: "A",
        isNode: false,
        domain: "scalar",
        graph: scopeHash("notes"),
      },
      {
        subject: NODE,
        predicate: "parent",
        value: OTHER,
        isNode: true,
        domain: "node",
        graph: G,
      },
      {
        subject: NODE,
        predicate: "tree_content",
        value: "17",
        isNode: false,
        domain: "blob",
        graph: G,
      },
    ]);
    expect(calls).toEqual([
      {
        url: "http://chaos:8209/v1/materialize_edges",
        verb: "materialize_edges",
        args: { node: NODE, full: true },
      },
    ]);
  });

  it("keeps an empty graph empty, so a retraction rides the batch scope", async () => {
    reply = {
      edges: [{ predicate: "hasName", value: "A", is_node: false, graph: "" }],
    };
    const [edge] = await live().placedEdges(NODE);
    expect(edge?.graph).toBe("");
    expect(placedGraph("")).toBe("");
    expect(placedGraph("notes")).toBe(scopeHash("notes"));
    expect(placedGraph(G)).toBe(G);
  });

  it("answers empty on a reply without edges", async () => {
    reply = { nope: true };
    expect(await live().placedEdges(NODE)).toEqual([]);
    reply = null;
    expect(await live().placedEdges(NODE)).toEqual([]);
  });
});

describe("LiveChaosDial.referrers", () => {
  it("asks quads_to for the full form and keeps node facts onto the node", async () => {
    reply = [
      {
        s: OTHER,
        predicate: "related",
        o: NODE,
        o_domain: "node",
        g: G,
        graph: "notes",
      },
      // A scalar sharing the bytes is a different identity.
      { s: OTHER, predicate: "x", o: NODE, o_domain: "scalar", g: G },
      // A node fact onto something else is not ours.
      { s: OTHER, predicate: "y", o: OTHER, o_domain: "node", g: G },
    ];
    expect(await live().referrers(NODE)).toEqual([
      {
        subject: OTHER,
        predicate: "related",
        value: NODE,
        isNode: true,
        domain: "node",
        graph: G,
      },
    ]);
    expect(calls).toEqual([
      {
        url: "http://chaos:8209/v1/quads_to",
        verb: "quads_to",
        args: { objects: [NODE], full: true },
      },
    ]);
  });

  it("keeps an empty g empty", async () => {
    reply = [
      { s: OTHER, predicate: "related", o: NODE, o_domain: "node", g: "" },
    ];
    const [edge] = await live().referrers(NODE);
    expect(edge?.graph).toBe("");
  });

  it("answers empty on a non-array reply", async () => {
    reply = { rows: [] };
    expect(await live().referrers(NODE)).toEqual([]);
  });
});

describe("chaos list reads — the bare array and the F17 {items} object", () => {
  const TOKEN = "dd".repeat(32);
  const QUAD = {
    s: OTHER,
    predicate: "related",
    o: NODE,
    o_domain: "node",
    g: G,
  };

  it("chaosRows reads both shapes and nothing else", () => {
    expect(chaosRows([1])).toEqual([1]);
    expect(chaosRows({ items: [1] })).toEqual([1]);
    expect(chaosRows({ items: [] })).toEqual([]);
    expect(chaosRows({ items: [1], more: 2 })).toBeNull();
    expect(chaosRows({ rows: [] })).toBeNull();
    expect(chaosRows(null)).toBeNull();
  });

  it("findByValue reads a wrapped answer like a bare one", async () => {
    reply = [TOKEN];
    const bare = await live().findByValue("notes", "hasType", "Note");
    reply = { items: [TOKEN] };
    const wrapped = await live().findByValue("notes", "hasType", "Note");
    expect(bare).toEqual([TOKEN]);
    expect(wrapped).toEqual(bare);
    reply = { items: [] };
    expect(await live().findByValue("notes", "hasType", "Note")).toEqual([]);
  });

  it("findByValue keeps only tokens, and answers empty on any other reply", async () => {
    reply = { items: [TOKEN, "not-a-token"] };
    expect(await live().findByValue("notes", "hasType", "Note")).toEqual([
      TOKEN,
    ]);
    reply = { rows: [TOKEN] };
    expect(await live().findByValue("notes", "hasType", "Note")).toEqual([]);
    reply = null;
    expect(await live().findByValue("notes", "hasType", "Note")).toEqual([]);
  });

  it("referrers reads a wrapped quads_to answer like a bare one", async () => {
    reply = [QUAD];
    const bare = await live().referrers(NODE);
    reply = { items: [QUAD] };
    expect(await live().referrers(NODE)).toEqual(bare);
    expect(bare).toHaveLength(1);
  });

  it("findByName reads a bare array and {items} to the same literal tokens", async () => {
    reply = [TOKEN, "not-a-token"];
    expect(await live().findByName("note", "x")).toEqual([TOKEN]);
    reply = { items: [TOKEN, "not-a-token"] };
    expect(await live().findByName("note", "x")).toEqual([TOKEN]);
    reply = { items: [] };
    expect(await live().findByName("note", "x")).toEqual([]);
    reply = { items: [TOKEN], more: 1 };
    expect(await live().findByName("note", "x")).toEqual([]);
    expect(calls.map((c) => c.verb)).toEqual(Array(4).fill("find_by_name"));
  });

  it("quadsFrom reads a bare array and {items} to the same literal rows", async () => {
    const row = [NODE, "related", OTHER, G];
    const want = [{ s: NODE, p: "related", o: OTHER, g: G }];
    reply = [row];
    expect(await live().quadsFrom([NODE], null, null)).toEqual(want);
    reply = { items: [row] };
    expect(await live().quadsFrom([NODE], null, null)).toEqual(want);
    reply = { items: [] };
    expect(await live().quadsFrom([NODE], null, null)).toEqual([]);
  });
});

describe("LocalChaosDial delegates the placed reads to its chaos door", () => {
  const VERB_DOC = (verb: string) => ({
    post: { operationId: verb, "x-mcp-tool": verb },
  });

  it("placedEdges and referrers ride the loopback REST door", async () => {
    const posted: string[] = [];
    globalThis.fetch = ((url: string, init?: { method?: string }) => {
      const { pathname, href } = new URL(url);
      const json = { "content-type": "application/json", "X-Star": "chaos" };
      if (pathname === "/openapi.json") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              openapi: "3.1.0",
              paths: {
                "/v1/materialize_edges": VERB_DOC("materialize_edges"),
                "/v1/quads_to": VERB_DOC("quads_to"),
              },
            }),
            { status: 200, headers: json },
          ),
        );
      }
      posted.push(`${init?.method ?? "GET"} ${href}`);
      return Promise.resolve(
        new Response(JSON.stringify(reply), { status: 200, headers: json }),
      );
    }) as unknown as typeof globalThis.fetch;
    const dial = new LocalChaosDial("http://127.0.0.1:9999");
    reply = { edges: [{ predicate: "p", value: "v", graph: G }] };
    expect(await dial.placedEdges(NODE)).toEqual([
      {
        subject: NODE,
        predicate: "p",
        value: "v",
        isNode: false,
        domain: "scalar",
        graph: G,
      },
    ]);
    reply = [{ s: OTHER, predicate: "q", o: NODE, o_domain: "node", g: G }];
    expect(await dial.referrers(NODE)).toHaveLength(1);
    expect(posted).toEqual([
      "POST http://127.0.0.1:9999/v1/materialize_edges",
      "POST http://127.0.0.1:9999/v1/quads_to",
    ]);
  });
});
