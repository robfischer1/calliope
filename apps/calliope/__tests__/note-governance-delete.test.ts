/**
 * delete_note / restore_note on a Governance note: nomos (and only nomos) may
 * hide and restore one; nobody may purge one. The caller is the verified peer
 * on the request's async context (or the gateway's stamp), never an argument.
 *
 * Synthetic data only: a FixtureChaosDial behind the real MCP server, each
 * call made under `runWithPeer` the way the door stamps it.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithPeer } from "@forge/stellar-core-ts";
import type { Peer } from "@forge/stellar-core-ts";
import { FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial } from "../src/chaos-client.js";
import { callerPrincipal, NOMOS_PRINCIPAL } from "../src/caller.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { createServer } from "../src/mcp/server.js";
import { GOVERNANCE_TYPE, hideableTypes } from "../src/mcp/delete-verbs.js";
import { NOTE_TYPES } from "../src/note-delete.js";
import { suppressedNotes } from "../src/note-suppress.js";
import { FixtureTagStore } from "../src/tag-store.js";

const SCOPE = "notes";

const star = (name: string, attest?: Peer["attest"]): Peer => ({
  spiffeId: `spiffe://notusmi.com/star/${name}`,
  kind: "star",
  name,
  ...(attest !== undefined ? { attest } : {}),
});
const NOMOS = star("nomos");
const HADES = star("hades");
const SESSION: Peer = {
  spiffeId: "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0",
  kind: "session",
  name: "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0",
};
const stamp = (principal: string): Record<string, unknown> => ({
  "hades/principal": principal,
  "hades/principal-type": "star",
});

interface Rig {
  mcp: Client;
  dial: FixtureChaosDial;
}

async function rig(): Promise<Rig> {
  const dial = new FixtureChaosDial();
  const server = createServer(new FixtureBodyClient(), {
    chaos: { dial, scope: SCOPE },
    containers: { blobs: new FixtureBlobStore(), dial },
    tags: new FixtureTagStore(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, dial };
}

interface Answer {
  isError: boolean;
  out: Record<string, unknown> & {
    notes?: { node_id: string; status: string }[];
  };
}

async function call(
  r: Rig,
  peer: Peer | undefined,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<Answer> {
  const res = await runWithPeer(peer, () =>
    r.mcp.callTool({
      name,
      arguments: args,
      ...(meta !== undefined ? { _meta: meta } : {}),
    }),
  );
  return {
    isError: res.isError === true,
    out: res.structuredContent as Answer["out"],
  };
}

async function governanceNote(r: Rig, title: string): Promise<string> {
  const res = await call(r, NOMOS, "create_note", {
    title,
    type: GOVERNANCE_TYPE,
  });
  expect(res.isError).toBe(false);
  return (res.out as { node_id: string }).node_id;
}

describe("callerPrincipal", () => {
  it("a certificate peer is its own SPIFFE id", () => {
    expect(callerPrincipal(undefined, NOMOS)).toBe(NOMOS_PRINCIPAL);
    expect(callerPrincipal(undefined, SESSION)).toBe(SESSION.spiffeId);
  });

  it("no peer, or a peer named by the network or a Cilium stamp, is nobody", () => {
    expect(callerPrincipal(undefined, undefined)).toBeUndefined();
    expect(
      callerPrincipal(undefined, star("nomos", "network")),
    ).toBeUndefined();
    expect(
      callerPrincipal(undefined, star("nomos", "cilium-stamp")),
    ).toBeUndefined();
  });

  it("the gateway speaks for its stamp; nothing else's stamp counts", () => {
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), HADES)).toBe(
      NOMOS_PRINCIPAL,
    );
    expect(
      callerPrincipal(stamp(NOMOS_PRINCIPAL), star("hades", "network")),
    ).toBe(NOMOS_PRINCIPAL);
    // An unstamped gateway call is nobody in particular, not hades.
    expect(callerPrincipal(undefined, HADES)).toBeUndefined();
    // A Cilium-named hades proves nothing; a foreign trust domain's hades is
    // only itself, never its stamp.
    expect(
      callerPrincipal(stamp(NOMOS_PRINCIPAL), star("hades", "cilium-stamp")),
    ).toBeUndefined();
    expect(
      callerPrincipal(stamp(NOMOS_PRINCIPAL), {
        ...HADES,
        spiffeId: "spiffe://other.td/star/hades",
      }),
    ).toBe("spiffe://other.td/star/hades");
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), SESSION)).toBe(
      SESSION.spiffeId,
    );
    expect(callerPrincipal(stamp(NOMOS_PRINCIPAL), star("athena"))).toBe(
      "spiffe://notusmi.com/star/athena",
    );
  });
});

describe("hideableTypes", () => {
  it("widens to Governance for nomos alone", () => {
    expect([...hideableTypes(NOMOS_PRINCIPAL)].sort()).toEqual([
      "Governance",
      "Note",
    ]);
    expect(hideableTypes(undefined)).toBe(NOTE_TYPES);
    expect(hideableTypes("spiffe://notusmi.com/star/athena")).toBe(NOTE_TYPES);
    expect(hideableTypes("nomos")).toBe(NOTE_TYPES);
  });
});

describe("delete_note on a Governance note", () => {
  it("nomos hides it, idempotently, and restore brings it back", async () => {
    const r = await rig();
    const g = await governanceNote(r, "skills/x/x.md");
    const before = await r.dial.placedEdges(g);

    const dry = await call(r, NOMOS, "delete_note", { ids: [g] });
    expect(dry.isError).toBe(false);
    expect(dry.out.notes).toEqual([{ node_id: g, status: "would_suppress" }]);
    expect((await suppressedNotes(r.dial, SCOPE)).has(g)).toBe(false);

    const hid = await call(r, NOMOS, "delete_note", {
      ids: [g],
      dry_run: false,
    });
    expect(hid.isError).toBe(false);
    expect(hid.out.notes).toEqual([{ node_id: g, status: "suppressed" }]);
    expect((await suppressedNotes(r.dial, SCOPE)).has(g)).toBe(true);

    const again = await call(r, NOMOS, "delete_note", {
      ids: [g],
      dry_run: false,
    });
    expect(again.out.notes).toEqual([
      { node_id: g, status: "already_suppressed" },
    ]);

    const back = await call(r, NOMOS, "restore_note", { ids: [g] });
    expect(back.isError).toBe(false);
    expect(back.out.notes).toEqual([{ node_id: g, status: "restored" }]);
    expect((await suppressedNotes(r.dial, SCOPE)).has(g)).toBe(false);
    expect(await r.dial.placedEdges(g)).toEqual(before);
  });

  it("nomos through the gateway's stamp hides it too", async () => {
    const r = await rig();
    const g = await governanceNote(r, "skills/y/y.md");
    const res = await call(
      r,
      HADES,
      "delete_note",
      { ids: [g], dry_run: false },
      stamp(NOMOS_PRINCIPAL),
    );
    expect(res.isError).toBe(false);
    expect(res.out.notes).toEqual([{ node_id: g, status: "suppressed" }]);
  });

  it("every other caller is refused not_a_note, writing nothing", async () => {
    const r = await rig();
    const g = await governanceNote(r, "skills/z/z.md");
    const admits = r.dial.admits.length;
    const callers: [Peer | undefined, Record<string, unknown> | undefined][] = [
      [undefined, undefined],
      [SESSION, undefined],
      [star("athena"), undefined],
      [star("nomos", "cilium-stamp"), undefined],
      [HADES, undefined],
      [HADES, stamp("spiffe://notusmi.com/star/athena")],
      // A non-gateway peer's own claim to be nomos is ignored.
      [SESSION, stamp(NOMOS_PRINCIPAL)],
    ];
    for (const [peer, meta] of callers) {
      for (const verb of ["delete_note", "restore_note"]) {
        const args =
          verb === "delete_note" ? { ids: [g], dry_run: false } : { ids: [g] };
        const res = await call(r, peer, verb, args, meta);
        expect(res.isError).toBe(true);
        expect(res.out.code).toBe("batch_refused");
        expect(String(res.out.detail)).toContain(
          `not_a_note: ${g} carries no hasType=Note edge`,
        );
      }
    }
    expect(r.dial.admits.length).toBe(admits);
  });

  it("purge never takes a Governance note, even from nomos", async () => {
    const r = await rig();
    const g = await governanceNote(r, "skills/p/p.md");
    const admits = r.dial.admits.length;
    const res = await call(r, NOMOS, "delete_note", {
      ids: [g],
      purge: true,
      dry_run: false,
    });
    expect(res.isError).toBe(true);
    expect(String(res.out.detail)).toContain(`not_a_note: ${g} `);
    expect(r.dial.admits.length).toBe(admits);
  });

  it("nomos's widening does not reach a type beyond Governance", async () => {
    const r = await rig();
    const res = await call(r, NOMOS, "create_note", {
      title: "m",
      type: "Memory",
    });
    const m = (res.out as { node_id: string }).node_id;
    const hid = await call(r, NOMOS, "delete_note", {
      ids: [m],
      dry_run: false,
    });
    expect(hid.isError).toBe(true);
    expect(String(hid.out.detail)).toContain(
      `not_a_note: ${m} carries no hasType=Note|Governance edge`,
    );
  });
});
