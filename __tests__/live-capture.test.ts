import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveUraniaCapture,
  contentHash,
  nameHash,
} from "../src/mcp/live-capture.js";
import {
  HAS_PART,
  ORDER_KEY,
  TEXT,
  UraniaBodyClient,
} from "../src/urania-client.js";
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

  it("resolve() reshapes materialize_edges to calliope triples", async () => {
    // resolve() now calls materialize_edges — the no-LWW read whose edges carry
    // the RESOLVED predicate NAME (not a hash). Two hasPart edges both survive
    // (where materialize would collapse them); an off-model predicate is dropped.
    stub.restore();
    const note = nameHash("calliope:note");
    const s0 = nameHash("calliope:s0");
    const s1 = nameHash("calliope:s1");
    const calls: { verb: string; args: Record<string, unknown> }[] = [];
    const edgesResult = {
      result: {
        structuredContent: {
          id: note,
          edges: [
            { predicate: "hasPart", value: s0, is_node: true },
            { predicate: "hasPart", value: s1, is_node: true },
            { predicate: "text", value: "body prose", is_node: false },
            // a predicate outside calliope's body model is dropped
            { predicate: "servesObjective", value: "x", is_node: false },
          ],
        },
      },
    };
    const fake: typeof fetch = (_input, init) => {
      const req = JSON.parse(bodyText(init)) as JsonRpcRequest;
      calls.push({ verb: req.params.name, args: req.params.arguments });
      const response: Pick<Response, "json"> = {
        json: () => Promise.resolve(edgesResult),
      };
      return Promise.resolve(response as Response);
    };
    globalThis.fetch = vi.fn(fake);

    const cap = new LiveUraniaCapture();
    const triples = await cap.resolve(note);
    expect(calls[0]?.verb).toBe("materialize_edges"); // not materialize
    expect(calls[0]?.args).toEqual({ node: note });
    // both hasPart edges survive — no LWW collapse
    expect(triples).toContainEqual({ from: note, predicate: "hasPart", to: s0 });
    expect(triples).toContainEqual({ from: note, predicate: "hasPart", to: s1 });
    expect(triples).toContainEqual({
      from: note,
      predicate: "text",
      to: "body prose",
    });
    expect(triples).toHaveLength(3); // off-model predicate dropped
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

/**
 * A stateful fetch fake that emulates urania's substrate over the wire: it
 * applies `capture` ops into a current-fact set (retraction-aware, like
 * `current_facts`) and serves `materialize_edges` for a node — resolving scalar
 * objects back to their interned values and flagging `is_node`. Drives the FULL
 * body round-trip (UraniaBodyClient -> LiveUraniaCapture -> wire) without a
 * network, proving the corrected resolve() reads a multi-section body back.
 */
function uraniaSubstrateFetch(): { restore: () => void } {
  const original = globalThis.fetch;
  // current facts keyed "s|p|o|g" -> {s,p,o}; scalars keyed content-hash -> value.
  const facts = new Map<string, { s: string; p: string; o: string }>();
  const scalars = new Map<string, string>();
  // reverse predicate name-hash (hex) -> name, for the body-model predicates.
  const predName = new Map<string, string>(
    [HAS_PART, TEXT, ORDER_KEY, HAS_TYPE_TEST].map((n) => [nameHash(n), n]),
  );

  const apply = (ops: WireOp[]): void => {
    for (const op of ops) {
      if (op.op === "intern" && op.value !== undefined) {
        scalars.set(contentHash(op.value), op.value);
      } else if (op.op === "addEdge" || op.op === "removeEdge") {
        const s = op.s ?? "";
        const p = op.p ?? "";
        const o = op.o ?? "";
        const key = `${s}|${p}|${o}`;
        if (op.op === "addEdge") {
          facts.set(key, { s, p, o });
        } else {
          facts.delete(key);
        }
      }
    }
  };

  const edgesFor = (node: string): UraniaEdgeWire[] => {
    const out: UraniaEdgeWire[] = [];
    for (const f of facts.values()) {
      if (f.s !== node) continue;
      const name = predName.get(f.p) ?? f.p;
      if (scalars.has(f.o)) {
        out.push({ predicate: name, value: scalars.get(f.o) ?? "", is_node: false });
      } else {
        out.push({ predicate: name, value: f.o, is_node: true });
      }
    }
    return out;
  };

  const fake: typeof fetch = (_input, init) => {
    const req = JSON.parse(bodyText(init)) as JsonRpcRequest;
    let structured: Record<string, unknown> = { result: { ok: true } };
    if (req.params.name === "capture") {
      apply(req.params.arguments.ops as WireOp[]);
    } else if (req.params.name === "materialize_edges") {
      const node = req.params.arguments.node as string;
      structured = { id: node, edges: edgesFor(node) };
    }
    const response: Pick<Response, "json"> = {
      json: () => Promise.resolve({ result: { structuredContent: structured } }),
    };
    return Promise.resolve(response as Response);
  };
  globalThis.fetch = vi.fn(fake);
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** One edge as the substrate fake emits it (mirrors urania materialize_edges). */
interface UraniaEdgeWire {
  predicate: string;
  value: string;
  is_node: boolean;
}

const HAS_TYPE_TEST = "hasType";

describe("body round-trip over materialize_edges (write 3 -> read 3 in order)", () => {
  const prev = process.env.CALLIOPE_URANIA_WIRED;
  let sub: ReturnType<typeof uraniaSubstrateFetch>;
  beforeEach(() => {
    process.env.CALLIOPE_URANIA_WIRED = "1";
    sub = uraniaSubstrateFetch();
  });
  afterEach(() => {
    sub.restore();
    if (prev === undefined) delete process.env.CALLIOPE_URANIA_WIRED;
    else process.env.CALLIOPE_URANIA_WIRED = prev;
  });

  it("saveBody of 3 sections then readBody returns 3 in order", async () => {
    const client = new UraniaBodyClient(new LiveUraniaCapture());
    const note = nameHash("calliope:note");
    await client.saveBody(note, [
      { text: "first" },
      { text: "second" },
      { text: "third" },
    ]);
    const body = await client.readBody(note);
    expect(body.map((s) => s.text)).toEqual(["first", "second", "third"]);
    expect(body).toHaveLength(3); // proves the multi-hasPart read (no LWW)
  });
});
