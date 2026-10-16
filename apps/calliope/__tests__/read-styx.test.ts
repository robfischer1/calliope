/**
 * calliope_read_container / calliope_read_containers accept a styx address
 * beside the 64-hex token. Chaos answers in addresses, so a caller that holds
 * only `able-frost-casual` reads by it; calliope resolves it to the token it
 * reads the tree with and never returns a token the caller did not send.
 *
 * A counting dial observes every claim: hex input never resolves, a styx
 * batch resolves in a fixed number of chaos calls whatever its size, and the
 * answer echoes the ref as sent.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { readContainers } from "../src/container-read.js";
import { writeContainer } from "../src/container-write.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { NODE_REF_RE, STYX_RE, resolveStyx } from "../src/styx.js";

class CountingBlobs extends FixtureBlobStore {
  fetches = 0;
  override getTexts(ids: string[]): Promise<Map<string, string>> {
    this.fetches += 1;
    return super.getTexts(ids);
  }
}

/** Counts every chaos round trip, resolution and tree read apart. */
class CountingDial extends FixtureChaosDial {
  echo = 0;
  legacy = 0;
  reads = 0;
  override resolveRefsEcho(
    ...a: Parameters<FixtureChaosDial["resolveRefsEcho"]>
  ): ReturnType<FixtureChaosDial["resolveRefsEcho"]> {
    this.echo += 1;
    return super.resolveRefsEcho(...a);
  }
  override resolveNodeRefs(
    ...a: Parameters<FixtureChaosDial["resolveNodeRefs"]>
  ): ReturnType<FixtureChaosDial["resolveNodeRefs"]> {
    this.legacy += 1;
    return super.resolveNodeRefs(...a);
  }
  override quadsFrom(
    ...a: Parameters<FixtureChaosDial["quadsFrom"]>
  ): ReturnType<FixtureChaosDial["quadsFrom"]> {
    this.reads += 1;
    return super.quadsFrom(...a);
  }
  override resolveScalars(
    ...a: Parameters<FixtureChaosDial["resolveScalars"]>
  ): ReturnType<FixtureChaosDial["resolveScalars"]> {
    this.reads += 1;
    return super.resolveScalars(...a);
  }
  get resolutions(): number {
    return this.echo + this.legacy;
  }
  reset(): void {
    this.echo = 0;
    this.legacy = 0;
    this.reads = 0;
  }
}

const FIRST = ["river", "mango", "cedar", "lunar", "ember"];
const SECOND = ["amber", "birch", "coral", "dune", "frond"];
/** A distinct three-word address for index i (1..124). */
const styxFor = (i: number): string =>
  `${FIRST[i % 5] ?? ""}-${SECOND[Math.floor(i / 5) % 5] ?? ""}-${
    ["tide", "moss", "reed", "salt", "wren"][Math.floor(i / 25) % 5] ?? ""
  }`;

async function world(n = 2) {
  const dial = new CountingDial();
  const blobs = new CountingBlobs();
  const facet = { blobs, dial };
  const nodes: { token: string; styx: string }[] = [];
  for (let i = 0; i < n; i++) {
    const res = await dial.admit(
      [opCreate("Note", `note ${String(i)}`)],
      "notes",
    );
    const token = res.minted[0];
    if (token === undefined) throw new Error("fixture minted nothing");
    const styx = i === 0 ? "able-frost-casual" : styxFor(i);
    dial.assignStyx(token, styx);
    await writeContainer(facet, token, [
      { op: "add", text: `one-${String(i)}`, position: "a0" },
      { op: "add", text: `two-${String(i)}`, position: "a1" },
    ]);
    nodes.push({ token, styx });
  }
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: "notes" },
    containers: facet,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  dial.reset();
  blobs.fetches = 0;
  return { dial, blobs, facet, nodes, mcp };
}

interface Batch {
  containers: { container: string; blocks: { text: string | null }[] }[];
  missing: string[];
}

describe("the styx grammar", () => {
  it("is hex64 or three words, bare or styx://", () => {
    for (const ok of ["able-frost-casual", "styx://able-frost-casual"]) {
      expect(STYX_RE.test(ok)).toBe(true);
      expect(NODE_REF_RE.test(ok)).toBe(true);
    }
    expect(NODE_REF_RE.test("a".repeat(64))).toBe(true);
    for (const bad of [
      "able-frost",
      "able-frost-casual-extra",
      "Able-frost-casual",
      "ab-frost-casual",
      "styx://",
      "a".repeat(63),
      "",
    ]) {
      expect(NODE_REF_RE.test(bad)).toBe(false);
    }
  });
});

describe("read_container by styx", () => {
  it("reads the same blocks as the token, bare or styx://", async () => {
    const { mcp, nodes } = await world();
    const [n0] = nodes;
    if (n0 === undefined) throw new Error("no node");
    const byToken = await mcp.callTool({
      name: "read_container",
      arguments: { container: n0.token },
    });
    for (const ref of [n0.styx, `styx://${n0.styx}`]) {
      const res = await mcp.callTool({
        name: "read_container",
        arguments: { container: ref },
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual(byToken.structuredContent);
      expect(JSON.stringify(res)).not.toContain(n0.token);
    }
  });

  it("an unresolved styx is the unknown-node refusal, and reads nothing", async () => {
    const { mcp, dial } = await world();
    const res = await mcp.callTool({
      name: "read_container",
      arguments: { container: "never-minted-ghost" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "not_found" });
    expect(dial.reads).toBe(0);
    expect(dial.legacy).toBe(0);
  });

  it("a hex token never triggers resolution", async () => {
    const { mcp, dial, nodes } = await world();
    const res = await mcp.callTool({
      name: "read_container",
      arguments: { container: nodes[0]?.token },
    });
    expect(res.isError).toBeFalsy();
    expect(dial.resolutions).toBe(0);
  });

  it("refuses a malformed ref as bad_args", async () => {
    const { mcp } = await world();
    for (const container of ["able-frost", "Able-Frost-Casual", "xyz"]) {
      const res = await mcp.callTool({
        name: "read_container",
        arguments: { container },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ code: "bad_args" });
    }
  });
});

describe("read_containers by styx", () => {
  it("echoes each ref as sent: a mix of hex, bare and styx://", async () => {
    const { mcp, nodes } = await world(3);
    const [a, b, c] = nodes;
    if (a === undefined || b === undefined || c === undefined)
      throw new Error("no nodes");
    const sent = [b.token, `styx://${a.styx}`, c.styx];
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: sent },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Batch;
    expect(out.containers.map((x) => x.container)).toEqual(sent);
    expect(out.containers.map((x) => x.blocks[0]?.text)).toEqual([
      "one-1",
      "one-0",
      "one-2",
    ]);
    expect(out.missing).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(c.token);
  });

  it("an unknown styx lands in missing, in the order sent", async () => {
    const { mcp, nodes } = await world();
    const ghostHex = "f".repeat(64);
    const sent = ["ghost-town-void", nodes[0]?.styx, ghostHex];
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: sent },
    });
    const out = res.structuredContent as Batch;
    expect(out.containers.map((x) => x.container)).toEqual([nodes[0]?.styx]);
    expect(out.missing).toEqual(["ghost-town-void", ghostHex]);
  });

  it("only unknown styx: nothing is read", async () => {
    const { mcp, dial } = await world();
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: ["ghost-town-void"] },
    });
    expect(res.structuredContent).toEqual({
      containers: [],
      missing: ["ghost-town-void"],
    });
    expect(dial.reads).toBe(0);
  });

  it("a hex-only batch is byte-identical and resolves nothing", async () => {
    const { mcp, dial, facet, nodes } = await world(3);
    const tokens = nodes.map((n) => n.token).reverse();
    const ghost = "e".repeat(64);
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: [...tokens, ghost] },
    });
    expect(dial.resolutions).toBe(0);
    const direct = await readContainers(facet, [...tokens, ghost], {
      texts: true,
    });
    expect(JSON.stringify(res.structuredContent)).toBe(JSON.stringify(direct));
  });

  it("an address and the hex of the same node are two asks, two answers", async () => {
    const { mcp, nodes } = await world();
    const a = nodes[0];
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: { containers: [a?.token, a?.styx] },
    });
    const out = res.structuredContent as Batch;
    expect(out.containers.map((x) => x.container)).toEqual([a?.token, a?.styx]);
  });

  it("indistinguishable rows are still mapped to the right node", async () => {
    // Two nodes with the same label and kind: the dictionary rows match, so
    // the join alone cannot tell them apart. Each ref must still read its
    // own tree.
    const dial = new CountingDial();
    const blobs = new CountingBlobs();
    const facet = { blobs, dial };
    const made: { token: string; styx: string }[] = [];
    for (const [styx, text] of [
      ["alpha-bravo-charli", "first"],
      ["delta-echoes-foxtro", "second"],
    ] as const) {
      const res = await dial.admit([opCreate("Note", "twin")], "notes");
      const token = res.minted[0] ?? "";
      dial.assignStyx(token, styx);
      await writeContainer(facet, token, [{ op: "add", text, position: "a0" }]);
      made.push({ token, styx });
    }
    dial.reset();
    const got = await readContainers(
      facet,
      [
        ...(
          await resolveStyx(dial, made.map((m) => m.styx).reverse())
        ).tokens.values(),
      ],
      { texts: true },
    );
    expect(got.containers.map((c) => c.blocks[0]?.text)).toEqual([
      "second",
      "first",
    ]);
    const r = await resolveStyx(
      dial,
      made.map((m) => m.styx),
    );
    expect(r.tokens.get(made[0]?.styx ?? "")).toBe(made[0]?.token);
    expect(r.tokens.get(made[1]?.styx ?? "")).toBe(made[1]?.token);
  });

  it("joins on the echoed ref: twins resolve in two calls, none singly", async () => {
    const dial = new CountingDial();
    const made: { token: string; styx: string }[] = [];
    for (const styx of ["alpha-bravo-charli", "delta-echoes-foxtro"]) {
      const res = await dial.admit([opCreate("Note", "twin")], "notes");
      const token = res.minted[0] ?? "";
      dial.assignStyx(token, styx);
      made.push({ token, styx });
    }
    dial.reset();
    const r = await resolveStyx(
      dial,
      made.map((m) => m.styx),
    );
    expect(dial.echo).toBe(1);
    expect(dial.legacy).toBe(1);
    expect(r.tokens.get(made[0]?.styx ?? "")).toBe(made[0]?.token);
    expect(r.tokens.get(made[1]?.styx ?? "")).toBe(made[1]?.token);
  });

  it("a chaos that predates the echo: each ref is asked singly, still right", async () => {
    class PreEchoDial extends CountingDial {
      override async resolveNodeRefs(
        ...a: Parameters<FixtureChaosDial["resolveNodeRefs"]>
      ): ReturnType<FixtureChaosDial["resolveNodeRefs"]> {
        const rows = await super.resolveNodeRefs(...a);
        for (const row of Object.values(rows)) delete row.ref;
        return rows;
      }
    }
    const dial = new PreEchoDial();
    const made: { token: string; styx: string }[] = [];
    for (const styx of ["alpha-bravo-charli", "delta-echoes-foxtro"]) {
      const res = await dial.admit([opCreate("Note", "twin")], "notes");
      const token = res.minted[0] ?? "";
      dial.assignStyx(token, styx);
      made.push({ token, styx });
    }
    dial.reset();
    const r = await resolveStyx(
      dial,
      made.map((m) => m.styx),
    );
    expect(dial.legacy).toBe(3);
    expect(r.tokens.get(made[0]?.styx ?? "")).toBe(made[0]?.token);
    expect(r.tokens.get(made[1]?.styx ?? "")).toBe(made[1]?.token);
  });
});

describe("a fixed number of calls whatever the batch size", () => {
  async function counted(n: number, byStyx: boolean) {
    const { mcp, dial, blobs, nodes } = await world(n);
    const res = await mcp.callTool({
      name: "read_containers",
      arguments: {
        containers: nodes.map((x) => (byStyx ? x.styx : x.token)),
      },
    });
    expect((res.structuredContent as Batch).containers).toHaveLength(n);
    return {
      echo: dial.echo,
      legacy: dial.legacy,
      reads: dial.reads,
      fetches: blobs.fetches,
    };
  }

  it("N=1 and N=25 by styx: the same reads, at most 2 resolution calls", async () => {
    const one = await counted(1, true);
    const many = await counted(25, true);
    expect(many).toEqual(one);
    expect(many.echo + many.legacy).toBeLessThanOrEqual(2);
    expect(many.fetches).toBe(1);
  });

  it("by hex the reads are the same and resolution is zero", async () => {
    const hex = await counted(25, false);
    const styx = await counted(25, true);
    expect(hex.echo + hex.legacy).toBe(0);
    expect(hex.reads).toBe(styx.reads);
    expect(hex.fetches).toBe(styx.fetches);
  });
});
