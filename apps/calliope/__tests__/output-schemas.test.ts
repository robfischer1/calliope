/**
 * F17 batch 2a — every calliope fleet verb publishes an output schema and
 * answers structuredContent that matches it.
 *
 * Over the fixture rig, through a real MCP client: the client validates each
 * successful structuredContent against the schema the server advertised, so a
 * schema that drifts from an answer fails here, not on the gateway.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobGc, FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FocusRegister } from "../src/focus-register.js";
import { FixtureRevisionStore } from "../src/revision-store.js";
import { createServer } from "../src/mcp/server.js";
import { compileOutputSchema } from "../src/mcp/output-schemas.js";
import { FixtureTagStore } from "../src/tag-store.js";

/** The 20 verbs the gateway served without a schema, as calliope names them. */
const VERBS = [
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
  "read_container",
  "read_containers",
  "restore_note",
  "revision_deltas",
  "search",
  "set_properties",
  "unpin",
  "write_container",
] as const;

const SCHEMA_DIR = new URL("../src/mcp/output-schema/", import.meta.url);

const POINTER = {
  kind: "body" as const,
  node: "n1",
  section: "s1",
  offsetFrom: 0,
  offsetTo: 5,
  text: "hello",
  ts: "2026-10-07T00:00:00Z",
};

async function rig(): Promise<Client> {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const revisions = new FixtureRevisionStore();
  await revisions.importRevision({
    id: 1,
    schema_type: "FileRevision",
    repo: "vault",
    commit_sha: "c".repeat(40),
    file_path: "a.md",
    prior_file_path: null,
    change_type: "modify",
    authorship: "ai",
    summary: null,
    summary_model: null,
    summary_generated_at: null,
    git_blob_sha: "bd9587b0",
    parent_blob_sha: null,
    captured_at: "2026-05-27T10:39:48.080Z",
  });
  // The archive's `summary_generated_at` is the text cast of a timestamptz.
  await revisions.importRevision({
    id: 2,
    schema_type: "FileRevision",
    repo: "vault",
    commit_sha: "d".repeat(40),
    file_path: "b.md",
    prior_file_path: null,
    change_type: "modify",
    authorship: "ai",
    summary: "s",
    summary_model: "m",
    summary_generated_at: "2026-05-27 06:39:48.5-04",
    git_blob_sha: "bd9587b1",
    parent_blob_sha: null,
    captured_at: "2026-05-27T10:39:48.080Z",
  });
  await revisions.importDelta({
    id: 1,
    revision_id: 1,
    op: "add",
    subject: "a",
    predicate: "mentions",
    object: null,
  });
  const focus = new FocusRegister();
  focus.set(POINTER, "2026-10-07T00:00:01Z");
  focus.pin("pin-1", POINTER, "2026-10-07T00:00:02Z");
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial, gc: new FixtureBlobGc(blobs) },
    tags: new FixtureTagStore(),
    revisions,
    focus,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

type Answer = Record<string, unknown>;

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Answer> {
  const r = await mcp.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
  expect(r.structuredContent, name).toBeDefined();
  return r.structuredContent as Answer;
}

describe("F17 batch 2a — calliope's output schemas", () => {
  it("ships one schema file per verb, named by the bare verb; the $id carries the gateway name", () => {
    const files = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(".schema.json"))
      .sort();
    expect(files).toEqual(VERBS.map((v) => `${v}.schema.json`).sort());
    for (const file of files) {
      const doc = JSON.parse(
        readFileSync(new URL(file, SCHEMA_DIR), "utf8"),
      ) as { type?: string; $id?: string };
      expect(doc.type, file).toBe("object");
      expect(doc.$id, file).toMatch(
        new RegExp(
          `/tool-output/calliope_${file.replace(".schema.json", "")}/v1$`,
        ),
      );
    }
  });

  it("advertises an object-rooted outputSchema on every one", async () => {
    const mcp = await rig();
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const verb of VERBS) {
      const tool = byName.get(verb);
      expect(tool, `${verb} is not registered`).toBeDefined();
      expect(tool?.outputSchema?.type, verb).toBe("object");
    }
  });

  it("answers structuredContent that the advertised schema accepts", async () => {
    const mcp = await rig();
    const seen = new Set<string>();
    const run = async (name: string, args: Record<string, unknown>) => {
      seen.add(name);
      return call(mcp, name, args);
    };

    const note = await run("create_note", { title: "Schema note" });
    const id = note.node_id as string;
    expect(note.created).toBe(true);

    const wrote = await run("write_container", {
      container: id,
      ops: [{ op: "add", text: "alpha #beta", position: "a0" }],
    });
    expect(wrote.noop).toBe(false);
    const [block] = (await run("read_container", { container: id })).blocks as {
      slot: string;
    }[];
    await run("write_container", {
      container: id,
      slot: block?.slot,
      replacements: [{ find: "alpha", replace: "gamma", expected_count: 1 }],
    });
    await run("write_container", {
      container: id,
      ops: [{ op: "add", text: "alpha #beta", position: "a0" }],
    });

    await run("read_containers", { containers: [id] });
    await run("container_history", { container: id });
    await run("export_note", { container_id: id });
    await run("materialize_note", { container_id: id });
    await run("copy_reference", { node_id: id });
    await run("set_properties", {
      container_id: id,
      properties: [{ predicate: "status", values: [{ literal: "open" }] }],
      tags: ["#schema"],
    });
    await run("list_by_tag", { tag: "schema" });
    await run("list_tags", {});
    await run("dissolve_note", {
      source_path: "Brain Soup/Idea.md",
      blocks: [{ text: "# Idea" }],
    });

    await run("search", { query: "idea" });
    await run("file_revisions", {});
    await run("revision_deltas", { revision_id: 1 });
    await run("blob_census", {});

    const looked = await run("look", {});
    expect(looked.pins).toHaveLength(1);
    await run("unpin", { pin_id: "pin-1" });

    const dry = await run("delete_note", { ids: [id] });
    expect(dry.mode).toBe("suppress");
    await run("delete_note", { ids: [id], purge: true });
    await run("delete_note", { ids: [id], dry_run: false });
    await run("restore_note", { ids: [id] });

    expect([...seen].sort()).toEqual([...VERBS].sort());
  });

  it("emits the revision stamps as date-times the client accepts", async () => {
    const mcp = await rig();
    const answer = await call(mcp, "file_revisions", { id: 2 });
    const [row] = answer.revisions as Record<string, unknown>[];
    expect(row?.summary_generated_at).toBe("2026-05-27T06:39:48.5-04:00");
    expect(row?.captured_at).toBe("2026-05-27T10:39:48.080Z");
  });

  it("answers every refusal as an isError {code, detail}, nothing else", async () => {
    const mcp = await rig();
    const refusals: [string, Record<string, unknown>, string][] = [
      ["copy_reference", { node_id: "f".repeat(64) }, "not_found"],
      ["export_note", { source_path: "nope" }, "not_found"],
      ["materialize_note", { source_path: "nope" }, "not_found"],
      ["unpin", { pin_id: "never" }, "not_found"],
      ["create_note", { title: "T", parent: "a".repeat(64) }, "bad_args"],
      [
        "set_properties",
        { container_id: "e".repeat(64), properties: [] },
        "not_a_note",
      ],
      [
        "write_container",
        {
          container: "c".repeat(64),
          ops: [{ op: "add", text: "x", position: "a0" }],
          replacements: [{ find: "a", replace: "b", expected_count: 0 }],
        },
        "bad_args",
      ],
    ];
    for (const [name, args, code] of refusals) {
      const r = await mcp.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(Object.keys(r.structuredContent as object).sort(), name).toEqual([
        "code",
        "detail",
      ]);
      expect(r.structuredContent, name).toMatchObject({ code });
    }
  });

  it("describes no refusal in a schema, and names the fleet form where it says so", () => {
    for (const file of readdirSync(SCHEMA_DIR)) {
      if (!file.endsWith(".schema.json")) continue;
      const { description } = JSON.parse(
        readFileSync(new URL(file, SCHEMA_DIR), "utf8"),
      ) as { description: string };
      expect(description, file).toContain(
        "isError result {code, detail} (refusal.schema.json)",
      );
      expect(description, file).not.toContain("{error, detail}");
    }
  });

  it("pins the unpin answer and the not_found wording of the miss verbs", async () => {
    const mcp = await rig();
    const ok = await mcp.callTool({
      name: "unpin",
      arguments: { pin_id: "pin-1" },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: "text", text: "unpinned pin-1" }]);
    const { tools } = await mcp.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)?.description;
    expect(desc("unpin")).toContain("answers a not_found refusal;");
    expect(desc("export_note")).toContain("a miss is a not_found refusal.");
    expect(desc("materialize_note")).toContain(
      "A miss is a not_found refusal.",
    );
    expect(desc("copy_reference")).toContain(
      "Unknown node → a not_found refusal.",
    );
  });
});

describe("date-time fields compile to what the authority says", () => {
  const doc = {
    type: "object",
    properties: {
      at: { type: "string", format: "date-time" },
      maybe: { type: ["string", "null"], format: "date-time" },
      or_empty: {
        type: "string",
        anyOf: [{ format: "date-time" }, { maxLength: 0 }],
      },
      nested: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              ts: { type: "string", format: "date-time", description: "d" },
            },
            required: ["ts"],
          },
        ],
      },
    },
    required: ["at", "maybe", "or_empty", "nested"],
  };
  const schema = compileOutputSchema(doc);

  it("accepts Z, +00:00 and Eastern offsets, and the empty string where the form allows it", () => {
    for (const at of [
      "2026-10-17T19:42:41-04:00",
      "2026-01-02T03:04:05.250000-05:00",
      "2026-10-17T12:00:00+00:00",
      "2026-10-17T12:00:00Z",
    ]) {
      const ok = schema.safeParse({
        at,
        maybe: at,
        or_empty: at,
        nested: { ts: at },
      });
      expect(ok.success, at).toBe(true);
    }
    expect(
      schema.safeParse({
        at: "2026-10-17T19:42:41-04:00",
        maybe: null,
        or_empty: "",
        nested: null,
      }).success,
    ).toBe(true);
  });

  it("advertises format date-time with no Z-only pattern, and keeps the anyOf form", () => {
    const rendered = z.toJSONSchema(schema, { io: "output" });
    const text = JSON.stringify(rendered);
    expect(text).not.toContain("pattern");
    const props = rendered.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.at).toMatchObject({ type: "string", format: "date-time" });
    expect(props.maybe).toMatchObject({ format: "date-time" });
    expect(props.or_empty).toEqual({
      type: "string",
      anyOf: [{ format: "date-time" }, { maxLength: 0 }],
    });
    expect(JSON.stringify(props.nested)).toContain(
      '"ts":{"type":"string","format":"date-time","description":"d"}',
    );
  });
});

describe("the advertised schemas keep the authority's date-time fields", () => {
  it("lists format date-time on look and file_revisions with no Z-only pattern", async () => {
    const mcp = await rig();
    const { tools } = await mcp.listTools();
    for (const verb of ["look", "file_revisions"]) {
      const text = JSON.stringify(
        tools.find((t) => t.name === verb)?.outputSchema,
      );
      expect(text, verb).toContain('"format":"date-time"');
      expect(text, verb).not.toContain("pattern");
    }
  });
});
