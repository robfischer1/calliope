import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RestMount } from "@forge/stellar-core-ts/rest";
import { recordingWitness, serveDoor } from "./rest-door.js";

let rest: RestMount;
let base: string;

interface ListedTool {
  name: string;
  title?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

interface Spec {
  "x-mcp-tools"?: Record<string, ListedTool>;
}

/** The server's tools as a served spec carries them. */
const toolsOf = (doc: Spec): ListedTool[] =>
  Object.values(doc["x-mcp-tools"] ?? {});

/** The tools of the door this suite serves. */
async function listTools(): Promise<ListedTool[]> {
  const res = await fetch(`${base}/openapi.json`);
  return toolsOf((await res.json()) as Spec);
}

beforeEach(async () => {
  ({ rest, base } = await serveDoor({ witness: recordingWitness().witness }));
});

afterEach(async () => {
  await rest.close();
});

describe("calliope-mcp HTTP star — fixture-backed over a real socket", () => {
  it("serves the full verb surface via tools/list — the F3 fence", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      "blob_census",
      "container_history",
      "copy_reference",
      "create_note",
      "delete_note",
      "dissolve_note",
      "export_note",
      "file_revisions",
      "list_by_tag",
      "list_tags",
      "look",
      "materialize_note",
      "move_blocks",
      "read_container",
      "read_containers",
      "restore_note",
      "revision_deltas",
      "search",
      "set_properties",
      "tag_seed_read",
      "unpin",
      "write_container",
    ]);
  });

  it("every verb carries honest ToolAnnotations — the F10 map (B7's fence)", async () => {
    const MAP: Record<string, [boolean, boolean, boolean]> = {
      read_container: [true, false, true],
      read_containers: [true, false, true],
      blob_census: [false, true, false],

      container_history: [true, false, true],
      file_revisions: [true, false, true],
      revision_deltas: [true, false, true],
      list_by_tag: [true, false, true],
      list_tags: [true, false, true],
      export_note: [true, false, true],
      materialize_note: [true, false, true],
      copy_reference: [true, false, true],
      look: [true, false, true],
      search: [true, false, true],
      tag_seed_read: [true, false, true],

      unpin: [false, true, true],
      create_note: [false, false, true],
      dissolve_note: [false, false, true],
      set_properties: [false, true, true],
      delete_note: [false, true, true],
      restore_note: [false, false, true],
      write_container: [false, true, false],
      move_blocks: [false, true, false],
    };
    const tools = await listTools();
    expect(tools.length).toBe(Object.keys(MAP).length);
    for (const tool of tools) {
      const expected = MAP[tool.name];
      expect(expected, `unmapped verb ${tool.name}`).toBeDefined();
      if (!expected) continue;
      const a = tool.annotations;
      expect(a, `${tool.name} carries no annotations`).toBeDefined();
      expect(
        [
          a?.readOnlyHint ?? false,
          a?.destructiveHint ?? false,
          a?.idempotentHint ?? false,
        ],
        `${tool.name} hints`,
      ).toEqual(expected);
    }
  });

  it("serves no /mcp: the REST door is the only listener, probes beside it", async () => {
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${base}/live`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });
});

describe("the PRODUCTION boot shape (prebuilt client, F12 regression pin)", () => {
  it("serves the container surface when booted exactly as main() boots", async () => {
    const { makeBackend } = await import("../src/mcp/backend.js");
    const { FocusRegister } = await import("../src/focus-register.js");
    const backend = makeBackend("fixture");
    const served = await serveDoor({
      witness: recordingWitness().witness,
      client: backend.client,
      revisions: backend.revisions,
      chaos: backend.chaos,
      tags: backend.tags,
      focus: new FocusRegister(),
      containers: backend.containers,
    });
    try {
      const spec = await fetch(`${served.base}/openapi.json`);
      const names = toolsOf((await spec.json()) as Spec).map((t) => t.name);
      expect(names).toContain("write_container");
      expect(names).toContain("read_container");
      expect(names).toContain("container_history");
    } finally {
      await served.rest.close();
    }
  });
});
