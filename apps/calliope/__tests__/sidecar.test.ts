/**
 * The sidecar over the ONE backend (046 F14) — the ferry wire and /mcp
 * ride a LocalEngineStore; the fs backend is gone. Fixture engine (dial +
 * blob store), real working-tree directory: reads/writes hit the graph
 * fixtures AND project markdown to disk.
 */

import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { LocalEngineStore } from "../src/local-store.js";
import { resolvePayload } from "../src/mcp/babychaos.js";
import {
  createSidecarServer,
  parseArgs,
  type SidecarBackend,
} from "../src/mcp/sidecar.js";

let root: string;
let store: LocalEngineStore;
let server: Server;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sidecar-"));
  const facet = {
    blobs: new FixtureBlobStore(),
    dial: new FixtureChaosDial(),
  };
  store = new LocalEngineStore(root, facet, { pool: null, watch: false });
  const backend: SidecarBackend = {
    state: () => "ready",
    ports: () => ({ pg: 1, chaos: 2 }),
    ready: () => Promise.resolve(store),
    containers: () => facet,
    root: store.root,
  };
  server = createSidecarServer(backend);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== "object")
    throw new Error("no address");
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  store.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

async function healthAt(port: number): Promise<{ engine: string }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
  return (await res.json()) as { engine: string };
}

async function bodyAt(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/body`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verb: "read_body", args: { node_id: "x.md" } }),
  });
}

async function ferry(verb: string, args: unknown): Promise<Response> {
  return fetch(`${base}/body`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verb, args }),
  });
}

describe("parseArgs", () => {
  it("parses root and port with a 0 default", () => {
    expect(parseArgs(["--root", "/x", "--port", "8321"])).toEqual({
      root: "/x",
      port: 8321,
      parentGuard: false,
    });
    expect(parseArgs(["--root", "/x", "--parent-guard"])).toEqual({
      root: "/x",
      port: 0,
      parentGuard: true,
    });
    expect(parseArgs([])).toEqual({
      root: undefined,
      port: 0,
      parentGuard: false,
    });
  });
});

describe("the ferry wire", () => {
  it("GET /health reports the engine backend", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      backend: string;
      engine: string;
      engine_ports: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe("engine");
    expect(body.engine).toBe("ready");
    expect(body.engine_ports).toEqual({ pg: 1, chaos: 2 });
  });

  it("write_body lands in the engine AND projects the working tree", async () => {
    const write = await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "alpha\n\nbeta" }],
    });
    expect(write.status).toBe(200);
    // The projection: markdown on disk, readable without the app.
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe(
      "alpha\n\nbeta",
    );
    const read = await ferry("read_body", { node_id: "note.md" });
    expect(read.status).toBe(200);
    const { sections } = (await read.json()) as {
      sections: { id: string; text: string; orderKey: string }[];
    };
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta"]);
    // Engine identity: the section id is a durable slot token, not a
    // generational file hash.
    expect(sections[0]?.id).toBeTruthy();
  });

  it("an external edit ingests on read — the working tree is authoritative", async () => {
    await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "from the app" }],
    });
    await writeFile(path.join(root, "note.md"), "from obsidian", "utf8");
    const read = await ferry("read_body", { node_id: "note.md" });
    const { sections } = (await read.json()) as {
      sections: { text: string }[];
    };
    expect(sections.map((s) => s.text)).toEqual(["from obsidian"]);
  });

  it("apply_section_ops went LIVE — engine slots carry durable identity", async () => {
    await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "alpha" }],
    });
    const read = await ferry("read_body", { node_id: "note.md" });
    const { sections } = (await read.json()) as {
      sections: { id: string }[];
    };
    const res = await ferry("apply_section_ops", {
      node_id: "note.md",
      ops: [{ op: "update", section_id: sections[0]?.id, text: "ALPHA" }],
    });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe("ALPHA");
  });

  it("history is the graph: revisions list and reconstruct", async () => {
    await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "v1" }],
    });
    await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "v2" }],
    });
    const revisions = await ferry("read_body_revisions", {
      node_id: "note.md",
    });
    expect(revisions.status).toBe(200);
    const body = (await revisions.json()) as {
      revisions: { revision: string; kind: string }[];
    };
    expect(body.revisions.length).toBeGreaterThanOrEqual(2);
    const oldest = body.revisions[body.revisions.length - 1];
    const at = await ferry("read_body_at", {
      node_id: "note.md",
      revision: oldest?.revision ?? "",
    });
    expect(at.status).toBe(200);
    const reconstructed = (await at.json()) as {
      sections: { text: string }[];
    };
    expect(reconstructed.sections.map((s) => s.text)).toEqual(["v1"]);
  });

  it("unsupported and unknown verbs answer 4xx without crashing", async () => {
    const unknown = await ferry("no_such_verb", {});
    expect(unknown.status).toBe(400);
  });

  it("answers the CORS preflight the webview sends", async () => {
    const res = await fetch(`${base}/body`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
  });

  it("binds loopback paths only — traversal 400s", async () => {
    const res = await ferry("read_body", { node_id: "../escape.md" });
    expect(res.status).toBe(400);
  });

  // ── 024/F1: copy_reference — the path form ───────────────────────────────
  it("copy_reference answers the compound with the path as the id half", async () => {
    await ferry("write_body", {
      node_id: "Brain Soup/idea.md",
      sections: [{ text: "x" }],
    });
    const res = await ferry("copy_reference", {
      node_id: "Brain Soup/idea.md",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      compound: string;
      title: string;
      id: string;
      address_form: string;
    };
    expect(body.compound).toBe("[[idea]] (Brain Soup/idea.md)");
    expect(body.title).toBe("idea");
    expect(body.id).toBe("Brain Soup/idea.md");
    expect(body.address_form).toBe("path");
  });

  it("copy_reference strips .markdown too and addresses a not-yet-written path", async () => {
    const res = await ferry("copy_reference", { node_id: "fresh.markdown" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { compound: string };
    expect(body.compound).toBe("[[fresh]] (fresh.markdown)");
  });

  it("copy_reference refuses escaping and non-markdown paths like every verb", async () => {
    expect(
      (await ferry("copy_reference", { node_id: "../out.md" })).status,
    ).toBe(400);
    expect(
      (await ferry("copy_reference", { node_id: "binary.png" })).status,
    ).toBe(400);
  });

  // ── tags: the computed walk of the working tree ──────────────────────────
  it("list_tags / list_by_tag read the projected tree", async () => {
    await ferry("write_body", {
      node_id: "a.md",
      sections: [{ text: "hello #focus world" }],
    });
    await ferry("write_body", {
      node_id: "b.md",
      sections: [{ text: "#focus and #calm" }],
    });
    const tags = (await (await ferry("list_tags", {})).json()) as {
      tags: { tag: string; count: number }[];
    };
    expect(tags.tags).toContainEqual({ tag: "#focus", count: 2 });
    const byTag = (await (
      await ferry("list_by_tag", { tag: "#calm" })
    ).json()) as { tag: string; node_ids: string[] };
    expect(byTag).toEqual({ tag: "#calm", node_ids: ["b.md"] });
  });

  // ── search without the engine's postgres: honest darkness ────────────────
  it("search names its dark arms when no index pool is wired", async () => {
    const res = await ferry("search", { query: "anything" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: unknown[];
      armsQueried: string[];
      armsDark: string[];
    };
    expect(body.hits).toEqual([]);
    expect(body.armsQueried).toEqual([]);
    expect(body.armsDark).toEqual(["fts", "semantic"]);
  });

  it("refuses an empty search query with bad_request", async () => {
    expect((await ferry("search", { query: " " })).status).toBe(400);
  });
});

describe("the boot gate", () => {
  it("requests wait for the engine instead of failing during boot", async () => {
    let releaseStore!: (s: LocalEngineStore) => void;
    const gate = new Promise<LocalEngineStore>((res) => {
      releaseStore = res;
    });
    const backend: SidecarBackend = {
      state: () => "booting",
      ports: () => null,
      ready: () => gate,
      containers: () => undefined,
      root,
    };
    const gated = createSidecarServer(backend);
    await new Promise<void>((resolve) => {
      gated.listen(0, "127.0.0.1", resolve);
    });
    const address = gated.address();
    if (address === null || typeof address !== "object")
      throw new Error("no address");
    try {
      const health = await healthAt(address.port);
      expect(health.engine).toBe("booting"); // health never blocks
      const pending = bodyAt(address.port);
      releaseStore(store);
      const res = await pending;
      expect(res.status).toBe(200); // waited, then served
    } finally {
      await new Promise((resolve) => gated.close(resolve));
    }
  });
});

describe("the sidecar MCP endpoint", () => {
  async function mcp(payload: unknown): Promise<unknown> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line !== undefined ? line.slice(5) : text) as unknown;
  }

  it("serves the body surface, look, search AND the container verbs", async () => {
    const listed = (await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as { result?: { tools?: { name: string }[] } };
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("read_body");
    expect(names).toContain("write_body");
    expect(names).toContain("look");
    expect(names).toContain("search");
    // F13/F14: one engine — the container surface serves locally too.
    expect(names).toContain("write_container");
    expect(names).toContain("read_container");
    expect(names).toContain("container_history");
    // chaos-gated fleet verbs stay absent — no gate on the desktop
    expect(names).not.toContain("create_note");
  });

  it("round-trips a body read over MCP against the engine", async () => {
    await ferry("write_body", {
      node_id: "agent.md",
      sections: [{ text: "hello agent" }],
    });
    const called = (await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_body", arguments: { node_id: "agent.md" } },
    })) as {
      result?: { structuredContent?: { sections?: { text: string }[] } };
    };
    const sections = called.result?.structuredContent?.sections ?? [];
    expect(sections.map((s) => s.text)).toEqual(["hello agent"]);
  });

  it("look answers the honest empty register", async () => {
    const called = (await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "look", arguments: {} },
    })) as {
      result?: { structuredContent?: { focus: unknown; pins: unknown[] } };
    };
    expect(called.result?.structuredContent?.focus).toBeNull();
    expect(called.result?.structuredContent?.pins).toEqual([]);
  });
});

describe("resolvePayload (unchanged from F13)", () => {
  it("null without the layout, paths with it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "payload-"));
    try {
      expect(resolvePayload({ CALLIOPE_BABYCHAOS_DIR: dir })).toBeNull();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(dir, "pg", "bin"), { recursive: true });
      await writeFile(path.join(dir, "pg", "bin", "initdb"), "", "utf8");
      await writeFile(path.join(dir, "chaosstore"), "", "utf8");
      const payload = resolvePayload({ CALLIOPE_BABYCHAOS_DIR: dir });
      expect(payload?.pgBin).toBe(path.join(dir, "pg", "bin"));
      expect(payload?.chaosstore).toBe(path.join(dir, "chaosstore"));
      expect(resolvePayload({})).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
