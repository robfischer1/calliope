import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveUraniaCapture,
  contentHash,
  nameHash,
} from "../src/mcp/live-capture.js";
import type { UraniaOp } from "../src/urania-client.js";

/**
 * Reference hashes computed by moirae's Python urania contract
 * (`urania_client.py`: name_hash / content_hash). The TS transport MUST match
 * these byte-for-byte or it writes a graph clotho can't read.
 */
const REF = {
  name: {
    moirae: "585e0303b9dced9b8aadfba60bdf4c6726c16c7dfc2aa58617d8b629163279f9",
    hasPart: "2926375c2e3c9d99737522b355e34880c9e7306cfa7ef93dc1a9c71a0f30a90b",
    text: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1",
    order_key:
      "036be663d1caf71aaf0b5b67637b3dccf0c58ec2be2758ea267cd151003d797a",
    hasType: "f48bcc3e5bd894115e273f6ef0660c870af36d5866e9c9128c67761f6c1e918b",
  },
  content: {
    section: "0614bc1c1a1ac920fa0d30fcbee4d8147a11b6d201dfa9cede795b7d04e698c3",
    hello: "f75dbf40dc72ce5028cf82f1cf95a0cfe6b2e66542c449a692960be0f0cd2151",
    empty: "b8c9e440ead3ddaccf7cc7e879d512a263272270df2d5504c0c3d1f85d16f9d9",
  },
};

describe("urania content-addressing contract (matches moirae Python)", () => {
  it("name_hash matches the reference for each predicate", () => {
    expect(nameHash("moirae")).toBe(REF.name.moirae);
    expect(nameHash("hasPart")).toBe(REF.name.hasPart);
    expect(nameHash("text")).toBe(REF.name.text);
    expect(nameHash("order_key")).toBe(REF.name.order_key);
    expect(nameHash("hasType")).toBe(REF.name.hasType);
  });

  it("content_hash matches the reference (value \\x1f '' \\x1f '')", () => {
    expect(contentHash("section")).toBe(REF.content.section);
    expect(contentHash("Hello, world.")).toBe(REF.content.hello);
    expect(contentHash("")).toBe(REF.content.empty);
  });
});

/** Capture each JSON-RPC POST so the wire ops can be asserted. */
interface CapturedCall {
  url: string;
  method: string;
  verb: string;
  args: Record<string, unknown>;
}

/** Read a fetch init.body as the JSON-RPC string it always is in this client. */
function bodyText(init: RequestInit | undefined): string {
  const b = init?.body;
  return typeof b === "string" ? b : "";
}

interface JsonRpcRequest {
  method: string;
  params: { name: string; arguments: Record<string, unknown> };
}

function stubFetch(): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url; // Request
  };
  const fake: typeof fetch = (input, init) => {
    const req = JSON.parse(bodyText(init)) as JsonRpcRequest;
    calls.push({
      url: urlOf(input),
      method: req.method,
      verb: req.params.name,
      args: req.params.arguments,
    });
    // Minimal FastMCP-shaped success envelope.
    const response: Pick<Response, "json"> = {
      json: () =>
        Promise.resolve({
          result: { structuredContent: { result: { ok: true } } },
        }),
    };
    return Promise.resolve(response as Response);
  };
  globalThis.fetch = vi.fn(fake);
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

interface WireOp {
  op: string;
  s?: string;
  p?: string;
  o?: string;
  g?: string;
  value?: string;
}

describe("LiveUraniaCapture — calliope op → urania wire op translation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("POSTs a tools/call to ${URANIA_URL}/mcp", async () => {
    const cap = new LiveUraniaCapture("http://nas01:8202");
    await cap.capture([
      { op: "createNode", id: nameHash("calliope:s1"), hasType: "section" },
    ]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe("http://nas01:8202/mcp");
    expect(stub.calls[0]?.method).toBe("tools/call");
  });

  it("createNode -> intern + addEdge hasType scalar(section), in moirae g", async () => {
    const sid = nameHash("calliope:s1");
    const cap = new LiveUraniaCapture();
    await cap.capture([{ op: "createNode", id: sid, hasType: "section" }]);

    const ops = stub.calls[0]?.args.ops as WireOp[];
    expect(stub.calls[0]?.verb).toBe("capture");
    expect(ops).toContainEqual({ op: "intern", value: "section" });
    expect(ops).toContainEqual({
      op: "addEdge",
      s: sid,
      p: REF.name.hasType,
      o: REF.content.section,
      g: REF.name.moirae,
    });
  });

  it("addEdge text/order_key intern the literal; hasPart is a node edge", async () => {
    const note = nameHash("calliope:note");
    const sid = nameHash("calliope:s1");
    const ops: UraniaOp[] = [
      { op: "addEdge", from: sid, predicate: "text", to: "Hello, world." },
      { op: "addEdge", from: sid, predicate: "order_key", to: "N" },
      { op: "addEdge", from: note, predicate: "hasPart", to: sid },
    ];
    const cap = new LiveUraniaCapture();
    await cap.capture(ops);

    const wire = stub.calls[0]?.args.ops as WireOp[];
    // text literal interned + edge at its content-hash
    expect(wire).toContainEqual({ op: "intern", value: "Hello, world." });
    expect(wire).toContainEqual({
      op: "addEdge",
      s: sid,
      p: REF.name.text,
      o: REF.content.hello,
      g: REF.name.moirae,
    });
    // order_key literal interned + edge
    expect(wire).toContainEqual({ op: "intern", value: "N" });
    expect(wire).toContainEqual({
      op: "addEdge",
      s: sid,
      p: REF.name.order_key,
      o: contentHash("N"),
      g: REF.name.moirae,
    });
    // hasPart points at the section NODE (no intern, object is the node id)
    expect(wire).toContainEqual({
      op: "addEdge",
      s: note,
      p: REF.name.hasPart,
      o: sid,
      g: REF.name.moirae,
    });
    expect(wire.some((o) => o.op === "intern" && o.value === sid)).toBe(false);
  });

  it("removeEdge on a literal retracts at the content-hash (no intern)", async () => {
    const sid = nameHash("calliope:s1");
    const cap = new LiveUraniaCapture();
    await cap.capture([
      { op: "removeEdge", from: sid, predicate: "order_key", to: "N" },
    ]);
    const wire = stub.calls[0]?.args.ops as WireOp[];
    expect(wire).toContainEqual({
      op: "removeEdge",
      s: sid,
      p: REF.name.order_key,
      o: contentHash("N"),
      g: REF.name.moirae,
    });
    expect(wire.some((o) => o.op === "intern")).toBe(false);
  });

  it("resolve() reshapes materialize attrs to calliope triples", async () => {
    // Override fetch to return a materialize-shaped result.
    stub.restore();
    const note = nameHash("calliope:note");
    const sid = nameHash("calliope:s1");
    const materializeResult = {
      result: {
        structuredContent: {
          id: note,
          attrs: [
            { p: REF.name.hasPart, value: sid, is_node: true },
            { p: REF.name.text, value: "body prose", is_node: false },
            // an unknown predicate is dropped
            { p: nameHash("unknown"), value: "x", is_node: false },
          ],
        },
      },
    };
    const fake: typeof fetch = () => {
      const response: Pick<Response, "json"> = {
        json: () => Promise.resolve(materializeResult),
      };
      return Promise.resolve(response as Response);
    };
    globalThis.fetch = vi.fn(fake);

    const cap = new LiveUraniaCapture();
    const triples = await cap.resolve(note);
    expect(triples).toContainEqual({
      from: note,
      predicate: "hasPart",
      to: sid,
    });
    expect(triples).toContainEqual({
      from: note,
      predicate: "text",
      to: "body prose",
    });
    expect(triples).toHaveLength(2); // unknown predicate dropped
  });

  it("dedups duplicate facts within one batch (urania PK is s,p,o,g,tx)", async () => {
    const sid = nameHash("calliope:s1");
    const cap = new LiveUraniaCapture();
    await cap.capture([
      { op: "addEdge", from: sid, predicate: "order_key", to: "N" },
      { op: "addEdge", from: sid, predicate: "order_key", to: "N" },
    ]);
    const wire = stub.calls[0]?.args.ops as WireOp[];
    const edges = wire.filter(
      (o) => o.op === "addEdge" && o.p === REF.name.order_key,
    );
    expect(edges).toHaveLength(1);
    const interns = wire.filter((o) => o.op === "intern" && o.value === "N");
    expect(interns).toHaveLength(1);
  });

  it("mintSectionId yields a 64-hex urania node id", () => {
    const cap = new LiveUraniaCapture();
    const id = cap.mintSectionId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(cap.mintSectionId()).not.toBe(id);
  });
});
