import { describe, expect, it } from "vitest";
import {
  ANCHORS_ROLE,
  FixtureChaosDial,
  decodeRpcBody,
  shapeFromTextBlocks,
  NOTE_ROOT_KIND,
  NOTE_ROOT_LABEL,
  ensureNotesRoot,
  isNodeToken,
  opAdd,
  opCreate,
} from "../src/chaos-client.js";

const SCOPE = "notes";

describe("op constructors — the court.py wire grammar, verbatim", () => {
  it("opCreate builds the mint op", () => {
    expect(opCreate("Note", "My Title")).toEqual({
      op: "createNode",
      kind: "Note",
      label: "My Title",
    });
  });

  it("opAdd builds literal and node edges", () => {
    expect(opAdd("aa", "hasName", { toLiteral: "x" })).toEqual({
      op: "addEdge",
      from_id: "aa",
      predicate: "hasName",
      to_literal: "x",
      to_node: null,
    });
    expect(opAdd("aa", "parent", { toNode: "bb" })).toEqual({
      op: "addEdge",
      from_id: "aa",
      predicate: "parent",
      to_literal: null,
      to_node: "bb",
    });
  });
});

describe("ensureNotesRoot", () => {
  it("mints the root on first ensure: createNode then hasName + anchorsRole", async () => {
    const dial = new FixtureChaosDial();
    const root = await ensureNotesRoot(dial, SCOPE, () => undefined);
    expect(isNodeToken(root)).toBe(true);
    expect(dial.admits).toHaveLength(2);
    const [mint, edges] = dial.admits;
    expect(mint?.ops).toEqual([opCreate(NOTE_ROOT_KIND, NOTE_ROOT_LABEL)]);
    expect(mint?.scope).toBe(SCOPE);
    expect(edges?.ops.map((o) => o.predicate)).toEqual([
      "hasName",
      ANCHORS_ROLE,
    ]);
  });

  it("returns the standing root without any admit", async () => {
    const dial = new FixtureChaosDial();
    const first = await ensureNotesRoot(dial, SCOPE, () => undefined);
    const before = dial.admits.length;
    const second = await ensureNotesRoot(dial, SCOPE, () => undefined);
    expect(second).toBe(first);
    expect(dial.admits.length).toBe(before);
  });

  it("a pre-existing root (seeded) is honored", async () => {
    const dial = new FixtureChaosDial();
    const token = "ab".repeat(32);
    dial.seed(NOTE_ROOT_KIND, NOTE_ROOT_LABEL, token);
    expect(await ensureNotesRoot(dial, SCOPE, () => undefined)).toBe(token);
    expect(dial.admits).toHaveLength(0);
  });

  it("a refused mint surfaces as admit_refused", async () => {
    const dial = new FixtureChaosDial();
    dial.refuseWith = [{ rule: "nope" }];
    await expect(
      ensureNotesRoot(dial, SCOPE, () => undefined),
    ).rejects.toThrowError(/mint refused/);
  });
});

describe("decodeRpcBody — both framings streamable-HTTP allows", () => {
  const VERB = "find_by_name";
  const ENVELOPE = { jsonrpc: "2.0", id: 1, result: { structuredContent: {} } };

  it("plain application/json parses as before", () => {
    expect(
      decodeRpcBody(JSON.stringify(ENVELOPE), "application/json", VERB),
    ).toEqual(ENVELOPE);
  });

  it("an SSE body is read, not thrown on — the Go-door regression", () => {
    // Bun's Response.json() threw `Failed to parse JSON` on exactly this,
    // which is what took every chaos-backed calliope read down 2026-08-14.
    const sse = `event: message\ndata: ${JSON.stringify(ENVELOPE)}\n\n`;
    expect(decodeRpcBody(sse, "text/event-stream", VERB)).toEqual(ENVELOPE);
  });

  it("content-type is matched case- and parameter-insensitively", () => {
    const sse = `event: message\ndata: ${JSON.stringify(ENVELOPE)}\n\n`;
    expect(
      decodeRpcBody(sse, "Text/Event-Stream; charset=utf-8", VERB),
    ).toEqual(ENVELOPE);
  });

  it("several data: lines in one event join with newlines", () => {
    // Split at a STRUCTURAL boundary, never mid-string: a newline inside a
    // JSON string literal is an illegal control character, so an arbitrary
    // midpoint split tests the splitter rather than the joiner.
    const sse =
      `event: message\n` +
      `data: {"jsonrpc":"2.0","id":1,\n` +
      `data: "result":{"structuredContent":{}}}\n\n`;
    expect(decodeRpcBody(sse, "text/event-stream", VERB)).toEqual(ENVELOPE);
  });

  it("the LAST event wins — a progress notification is not the answer", () => {
    const progress = { jsonrpc: "2.0", method: "notifications/progress" };
    const sse =
      `event: message\ndata: ${JSON.stringify(progress)}\n\n` +
      `event: message\ndata: ${JSON.stringify(ENVELOPE)}\n\n`;
    expect(decodeRpcBody(sse, "text/event-stream", VERB)).toEqual(ENVELOPE);
  });

  it("CRLF line endings are tolerated", () => {
    const sse = `event: message\r\ndata: ${JSON.stringify(ENVELOPE)}\r\n\r\n`;
    expect(decodeRpcBody(sse, "text/event-stream", VERB)).toEqual(ENVELOPE);
  });

  it("a trailing event with no blank line still counts", () => {
    const sse = `event: message\ndata: ${JSON.stringify(ENVELOPE)}`;
    expect(decodeRpcBody(sse, "text/event-stream", VERB)).toEqual(ENVELOPE);
  });

  it("an event-stream carrying no data: field fails loudly", () => {
    expect(() =>
      decodeRpcBody("event: message\n\n", "text/event-stream", VERB),
    ).toThrowError(/carried no data/);
  });
});

describe("shapeFromTextBlocks — a door that sends no structuredContent", () => {
  it("one text block is the payload", () => {
    // The exact live wire shape of find_by_value on the Go door.
    const content = [{ type: "text", text: '["019ff961"]' }];
    expect(shapeFromTextBlocks(content)).toEqual(["019ff961"]);
  });

  it("several text blocks are one JSON document each", () => {
    // The SDK emits one block per item; concatenating is not valid JSON.
    const content = [
      { type: "text", text: '{"a":1}' },
      { type: "text", text: '{"b":2}' },
    ];
    expect(shapeFromTextBlocks(content)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("non-text blocks are ignored", () => {
    const content = [
      { type: "image", data: "…" },
      { type: "text", text: "[1,2]" },
    ];
    expect(shapeFromTextBlocks(content)).toEqual([1, 2]);
  });

  it("no content, or no text blocks, is undefined — not a silent []", () => {
    expect(shapeFromTextBlocks(undefined)).toBeUndefined();
    expect(shapeFromTextBlocks([])).toBeUndefined();
    expect(shapeFromTextBlocks([{ type: "image", data: "…" }])).toBeUndefined();
  });
});
