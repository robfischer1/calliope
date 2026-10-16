/**
 * The live refusal wire: stellar-core-go's mcpserve.ErrResult carries
 * `{code, detail}` in a TEXT content block only (structuredContent is
 * skipped on isError). A failed `expect` must still reach writeContainer
 * as code `conflict`, not as a generic wire_error.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  ChaosClientError,
  LiveChaosDial,
  refusalOf,
} from "../src/chaos-client.js";
import { writeContainer } from "../src/container-write.js";

const realFetch = globalThis.fetch;
let result: Record<string, unknown> = {};
let sent = "";

beforeEach(() => {
  globalThis.fetch = (_url, init) => {
    sent = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SLOT = "ab".repeat(32);
const live = () =>
  new LiveChaosDial({
    themisUrl: "http://themis:8200",
    chaosUrl: "http://chaos:8206",
  });

describe("refusalOf", () => {
  it("reads the text block, then structuredContent, else null", () => {
    const body = { code: "conflict", detail: "d" };
    expect(
      refusalOf([{ type: "text", text: JSON.stringify(body) }], undefined),
    ).toEqual(body);
    expect(refusalOf([], body)).toEqual(body);
    expect(refusalOf([{ type: "text", text: "plain words" }], undefined)).toBe(
      null,
    );
    expect(refusalOf([{ type: "image" }], 7)).toBe(null);
    expect(refusalOf([{ type: "text", text: "{}" }], undefined)).toBe(null);
    expect(refusalOf(undefined, undefined)).toBe(null);
  });
});

describe("a text-only conflict refusal on the wire", () => {
  it("surfaces as code conflict from admit", async () => {
    result = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "conflict",
            detail: `expect[0] s=${SLOT} predicate=tree_content g=* want=held have=rev:3`,
          }),
        },
      ],
    };
    const err = await live()
      .admit([], "notes")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChaosClientError);
    expect((err as ChaosClientError).code).toBe("conflict");
  });

  it("reaches writeContainer's mapping, naming the slot", async () => {
    result = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "conflict",
            detail: `expect[0] s=${SLOT} predicate=tree_content g=* want=held have=rev:3`,
          }),
        },
      ],
    };
    const err = await writeContainer(
      { blobs: new FixtureBlobStore(), dial: live() },
      "cd".repeat(32),
      [{ op: "update", slot: SLOT, oldBlobId: "999", text: "new" }],
    ).catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("conflict");
    expect((err as ChaosClientError).message).toContain(SLOT);
  });

  it("a non-conflict text refusal stays a wire_error", async () => {
    result = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "bad_args", detail: "x" }),
        },
      ],
    };
    const err = await live()
      .admit([], "notes")
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("wire_error");
  });
});

describe("resolveNodeRefs on the wire", () => {
  it("returns {label, kind} per token and drops malformed rows", async () => {
    result = {
      structuredContent: {
        [SLOT]: { label: "A", kind: "Note", location: null, owner: null },
        bad: null,
      },
    };
    expect(await live().resolveNodeRefs([SLOT])).toEqual({
      [SLOT]: { label: "A", kind: "Note" },
    });
    result = { structuredContent: [] };
    expect(await live().resolveNodeRefs([SLOT])).toEqual({});
  });

  it("keeps the echoed ref when the wire row carries it", async () => {
    result = {
      structuredContent: {
        [SLOT]: {
          ref: "styx://able-frost-casual",
          label: "A",
          kind: "Note",
          location: null,
          owner: null,
        },
      },
    };
    expect(await live().resolveNodeRefs(["styx://able-frost-casual"])).toEqual({
      [SLOT]: { ref: "styx://able-frost-casual", label: "A", kind: "Note" },
    });
  });

  it("keeps location and owner when the wire row carries them", async () => {
    result = {
      structuredContent: {
        [SLOT]: { label: "A", kind: "Note", location: "kg", owner: "rob" },
      },
    };
    expect(await live().resolveNodeRefs([SLOT])).toEqual({
      [SLOT]: { label: "A", kind: "Note", location: "kg", owner: "rob" },
    });
  });

  it("missing_ok: refs in input order as sent, misses apart, no token", async () => {
    result = {
      structuredContent: {
        refs: [
          {
            ref: "styx://able-frost-casual",
            label: "A",
            kind: "Note",
            location: null,
            owner: "rob",
          },
        ],
        missing: ["ghost-town-void"],
      },
    };
    expect(
      await live().resolveRefsEcho([
        "styx://able-frost-casual",
        "ghost-town-void",
      ]),
    ).toEqual({
      refs: [
        {
          ref: "styx://able-frost-casual",
          label: "A",
          kind: "Note",
          owner: "rob",
        },
      ],
      missing: ["ghost-town-void"],
    });
    expect(JSON.parse(sent)).toMatchObject({
      params: {
        name: "resolve_node_refs",
        arguments: {
          tokens: ["styx://able-frost-casual", "ghost-town-void"],
          missing_ok: true,
        },
      },
    });
  });

  it("missing_ok against a chaos that ignores it is a bad_result, not a silent miss", async () => {
    result = { structuredContent: { [SLOT]: { label: "A", kind: "Note" } } };
    const err = await live()
      .resolveRefsEcho(["able-frost-casual"])
      .catch((e: unknown) => e);
    expect((err as ChaosClientError).code).toBe("bad_result");
  });
});
