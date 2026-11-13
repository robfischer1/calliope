/**
 * The staircase a write arrives with rides calliope's chaos write (nemo38-s4g):
 * a write_container served on the REST door with a `Staircase` header sends
 * the same header, byte for byte, on the chaos `capture` it makes, so chaos
 * stores it on the container node in that transaction. A write that carried
 * none sends none. Nothing leaves the process: the chaos door is a stubbed
 * fetch behind the real ChaosRest / RestClient.
 *
 * The dial tees: every admit goes out as a direct capture over the stubbed
 * door (the request under test) and is then applied to the fixture dial, so
 * the container tree the verb reads stays coherent.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { FixtureBlobStore } from "../src/blob-store.js";
import {
  FixtureChaosDial,
  LiveChaosDial,
  type AdmitResult,
  type ChaosExpect,
  type ChaosOp,
} from "../src/chaos-client.js";
import { ChaosRest } from "../src/chaos-rest.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { recordingWitness, serveDoor } from "./rest-door.js";

const ENVELOPE = "application/vnd.stellar.result+json";

const CAPTURE_DOC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "chaos", version: "v1" },
  paths: {
    "/v1/capture": {
      post: {
        operationId: "capture",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/x-mcp-tools/capture/inputSchema" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
        "x-mcp-match": {},
        "x-mcp-safe": false,
        "x-mcp-tool": "capture",
      },
    },
  },
  "x-mcp-tools": {
    capture: {
      annotations: { idempotentHint: false, readOnlyHint: false },
      description: "capture",
      inputSchema: { type: "object", additionalProperties: true },
      name: "capture",
    },
  },
});

// Not re-marshalled: the spacing is what the signatures cover.
const STAIR = Buffer.from(
  `[ {"role":"principal", "sub":"spiffe://notusmi.com/human/rob"} ]`,
  "utf8",
).toString("base64url");

/** The Staircase header of each capture the chaos door was sent. */
function chaosDoor(): { rest: ChaosRest; captures: (string | null)[] } {
  const captures: (string | null)[] = [];
  const fake = (input: string, init?: RequestInit): Promise<Response> => {
    if (new URL(input).pathname === "/openapi.json") {
      return Promise.resolve(
        new Response(CAPTURE_DOC, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Star": "chaos" },
        }),
      );
    }
    captures.push(new Headers(init?.headers).get("Staircase"));
    return Promise.resolve(
      new Response(
        JSON.stringify({ text: "", structuredContent: { tx: 9, results: [] } }),
        {
          status: 200,
          headers: { "Content-Type": ENVELOPE, "X-Star": "chaos" },
        },
      ),
    );
  };
  return {
    rest: new ChaosRest("http://chaos:8209", 5_000, fake as typeof fetch),
    captures,
  };
}

class TeeDial extends FixtureChaosDial {
  constructor(private readonly live: LiveChaosDial) {
    super();
  }
  override async admit(
    ops: ChaosOp[],
    scope: string,
    expect?: ChaosExpect[],
  ): Promise<AdmitResult> {
    // The capture's reply is the stub's; only the request it sent is judged.
    await this.live.admit(ops, scope, expect).catch(() => undefined);
    return super.admit(ops, scope, expect);
  }
}

const open: RestMount[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

async function rig() {
  const door = chaosDoor();
  const dial = new TeeDial(
    new LiveChaosDial({
      chaosRest: door.rest,
      directCapture: true,
      themisRestUrl: "http://themis.invalid:8203",
    }),
  );
  const { rest, base } = await serveDoor({
    witness: recordingWitness().witness,
    client: new FixtureBodyClient(),
    chaos: { dial, scope: "notes" },
    containers: { blobs: new FixtureBlobStore(), dial },
  });
  open.push(rest);
  const minted = await dial.admit(
    [{ op: "createNode", kind: "Note", label: "c" }],
    "notes",
  );
  door.captures.length = 0;
  return { base, door, container: minted.minted[0] ?? "" };
}

async function write(
  base: string,
  container: string,
  text: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(`${base}/v1/write_container`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      container,
      ops: [{ op: "add", text, position: "5" }],
      tenant: "notes",
    }),
  });
  await res.text();
  return res.status;
}

describe("write_container forwards the request's staircase to chaos", () => {
  it("the capture carries the Staircase header the write arrived with", async () => {
    const { base, door, container } = await rig();
    expect(await write(base, container, "one", { Staircase: STAIR })).toBe(200);
    expect(door.captures.length).toBeGreaterThan(0);
    for (const s of door.captures) expect(s).toBe(STAIR);
  });

  it("a write that carried none sends none", async () => {
    const { base, door, container } = await rig();
    expect(await write(base, container, "two", {})).toBe(200);
    expect(door.captures.length).toBeGreaterThan(0);
    for (const s of door.captures) expect(s).toBeNull();
  });

  it("a malformed Staircase is dropped, and the write still lands", async () => {
    const { base, door, container } = await rig();
    expect(await write(base, container, "three", { Staircase: "%%%" })).toBe(
      200,
    );
    for (const s of door.captures) expect(s).toBeNull();
  });
});
