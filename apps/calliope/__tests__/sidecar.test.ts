import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBodyClient } from "../src/fs-client.js";
import { createSidecarServer, parseArgs } from "../src/mcp/sidecar.js";

let root: string;
let server: Server;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sidecar-"));
  server = createSidecarServer(new FsBodyClient(root));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== "object")
    throw new Error("no address");
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

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
  it("GET /health reports the served root", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backend: string };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe("fs");
  });

  it("read_body / write_body round-trip over HTTP", async () => {
    await writeFile(path.join(root, "note.md"), "alpha\n\nbeta", "utf8");
    const read = await ferry("read_body", { node_id: "note.md" });
    expect(read.status).toBe(200);
    const { sections } = (await read.json()) as {
      sections: { id: string; text: string; orderKey: string }[];
    };
    // The user grain: a file is ONE section, blank lines never chunk.
    expect(sections.map((s) => s.text)).toEqual(["alpha\n\nbeta"]);

    const write = await ferry("write_body", {
      node_id: "note.md",
      sections: sections.map((s) => ({ text: s.text })),
    });
    expect(write.status).toBe(200);
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe(
      "alpha\n\nbeta",
    );
  });

  it("apply_section_ops is not served by the fs backend (0.14 de-inference)", async () => {
    await writeFile(path.join(root, "note.md"), "alpha", "utf8");
    const read = await ferry("read_body", { node_id: "note.md" });
    const { sections } = (await read.json()) as {
      sections: { id: string }[];
    };
    const res = await ferry("apply_section_ops", {
      node_id: "note.md",
      ops: [{ op: "update", section_id: sections[0]?.id, text: "ALPHA" }],
    });
    expect(res.status).toBe(500);
    const err = (await res.json()) as { error: string };
    expect(err.error).toMatch(/does not support/);
    // Nothing written — the editor degrades to whole-body writes instead.
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe("alpha");
  });

  it("unsupported and unknown verbs answer 4xx/5xx without crashing", async () => {
    const unknown = await ferry("no_such_verb", {});
    expect(unknown.status).toBe(400);
  });

  it("F13: the revision verbs went LIVE — history serves from the .grace/ revlog", async () => {
    // This assertion used to be its inverse ("does not support") — the
    // drawer was dark on the fs backend by design until Rob's 2026-08-10
    // revlog decision. The sidecar dispatch never changed; the optional
    // client methods lit it up.
    await ferry("write_body", {
      node_id: "note.md",
      sections: [{ text: "history seed" }],
    });
    const revisions = await ferry("read_body_revisions", {
      node_id: "note.md",
    });
    expect(revisions.status).toBe(200);
    const body = (await revisions.json()) as {
      revisions: { revision: string; kind: string }[];
    };
    expect(body.revisions.length).toBeGreaterThan(0);
    const at = await ferry("read_body_at", {
      node_id: "note.md",
      revision: body.revisions[0]?.revision ?? "",
    });
    expect(at.status).toBe(200);
    const reconstructed = (await at.json()) as {
      sections: { text: string }[];
    };
    expect(reconstructed.sections.length).toBe(1);
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
    await mkdir(path.join(root, "Brain Soup"), { recursive: true });
    await writeFile(path.join(root, "Brain Soup", "idea.md"), "x", "utf8");
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
    // the path is the identity — a reference may precede the first write
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
});

// ── 031 ("Look At This" F12): the local MCP endpoint ─────────────────────────

describe("the sidecar MCP endpoint (031 / Look At This F12)", () => {
  async function mcp(payload: unknown, sessionInit = true): Promise<unknown> {
    if (sessionInit) {
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      });
    }
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    // streamable-http answers SSE-framed or plain JSON; take the data line
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line !== undefined ? line.slice(5) : text) as unknown;
  }

  it("serves the fs-supported body surface plus look over MCP", async () => {
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
    // chaos-gated verbs stay absent — no graph on the sidecar
    expect(names).not.toContain("create_note");
  });

  it("round-trips a body read over MCP against the served directory", async () => {
    await writeFile(path.join(root, "agent.md"), "hello agent", "utf8");
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
