import { afterEach, describe, expect, it } from "vitest";
import type { Peer } from "@forge/stellar-core-ts";
import type { RestHandler } from "@forge/stellar-core-ts/rest";
import { makeBackend } from "../src/mcp/backend.js";
import type { WriteAuthorship } from "../src/revision-store.js";
import { argsDigest } from "../src/args-digest.js";
import { ACT_ASSERTION_HEADER } from "../src/act-assertion.js";
import { actJwksFetch } from "../src/act-gate.js";
import { recordingWitness, serveDoor } from "./rest-door.js";
import { CHARON, TD, mint, okFetch } from "./act-fixtures.js";

/**
 * The act-assertion gate on the SERVED door. The peer is stamped by a wrap
 * outside the gate (a loopback request is never named by the Cilium stamp, so
 * a test cannot get one off the wire); everything else is the real door.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const ENV = {
  CALLIOPE_ACT_JWKS_URL: "http://kairos/jwks",
  CALLIOPE_ACT_ISSUER: "https://kairos.notusmi.com",
  CALLIOPE_ACT_TRUST_DOMAIN: TD,
};
// The adapter's method per verb: a destructiveHint verb is DELETE, else POST
// (stellar-core rest/table.ts methodFor; the hints are in server.ts and
// delete-verbs.ts).
const METHOD: Record<string, string> = {
  write_container: "DELETE",
  delete_note: "DELETE",
  set_properties: "DELETE",
  move_blocks: "DELETE",
};

interface CallOpts {
  /** false: send no header; a string: send this token. Default: a good one. */
  token?: string | false;
  headerName?: string;
  /** The args the token is minted over, when not the args sent. */
  mintedOver?: Record<string, unknown>;
  peer?: Peer | undefined;
}

async function door(env: Record<string, string> = ENV) {
  const backend = makeBackend("fixture");
  const revs = backend.revisions;
  if (revs === undefined) throw new Error("fixture backend has no revisions");
  const rows: WriteAuthorship[] = [];
  const orig = revs.recordAuthorship.bind(revs);
  revs.recordAuthorship = (r) => {
    rows.push(r);
    return orig(r);
  };
  const stamp: { peer: Peer | undefined } = { peer: CHARON };
  const { witness } = recordingWitness();
  const { rest, base } = await serveDoor(
    {
      witness,
      client: backend.client,
      revisions: revs,
      chaos: backend.chaos,
      tags: backend.tags,
      containers: backend.containers,
      actFetch: okFetch,
      restOuter: (next: RestHandler) => (req) =>
        next({ ...req, peer: stamp.peer }),
    },
    env,
  );
  closers.push(() => rest.close());
  const call = async (
    verb: string,
    args: Record<string, unknown>,
    o: CallOpts = {},
  ): Promise<{ status: number; text: string }> => {
    stamp.peer = "peer" in o ? o.peer : CHARON;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (o.token !== false) {
      headers[o.headerName ?? ACT_ASSERTION_HEADER] =
        o.token ?? mint(argsDigest(JSON.stringify(o.mintedOver ?? args)));
    }
    // dry_run:false rides the path as /live (rest/table.ts DANGEROUS).
    const live = verb === "delete_note" && args.dry_run === false;
    const r = await fetch(`${base}/v1/${verb}${live ? "/live" : ""}`, {
      method: METHOD[verb] ?? "POST",
      headers,
      body: JSON.stringify(args),
    });
    return { status: r.status, text: await r.text() };
  };
  const read = async (container: string): Promise<string> =>
    (await fetch(`${base}/v1/read_container?container=${container}`)).text();
  return { call, read, rows };
}

const hex = (t: string, key: string): string =>
  new RegExp(`"${key}\\\\?":\\\\?"([0-9a-f]{64})`).exec(t)?.[1] ?? "";

describe("act gate: the six write verbs, attributed", () => {
  it("persists authored_by and via on each verb", async () => {
    const { call, read, rows } = await door();
    const mk = async (title: string): Promise<string> => {
      const r = await call("create_note", { title });
      expect(r.status, r.text).toBe(200);
      return hex(r.text, "node_id");
    };
    const a = await mk("A");
    const b = await mk("B");
    expect(a).not.toBe("");
    const verbs = (): Set<string> => new Set(rows.map((r) => r.verb));

    let r = await call("set_properties", {
      container_id: a,
      properties: [{ predicate: "k", values: [{ literal: "v" }] }],
    });
    expect(r.status, r.text).toBe(200);

    r = await call("write_container", {
      container: a,
      ops: [{ op: "add", text: "hello", position: "a0" }],
    });
    expect(r.status, r.text).toBe(200);

    const slot = hex(await read(a), "slot");
    expect(slot).not.toBe("");
    r = await call("move_blocks", { from: a, to: b, slots: [slot] });
    expect(r.status, r.text).toBe(200);

    r = await call("delete_note", { ids: [a] });
    expect(r.status, r.text).toBe(200);
    r = await call("delete_note", { ids: [a], dry_run: false });
    expect(r.status, r.text).toBe(200);
    r = await call("restore_note", { ids: [a] });
    expect(r.status, r.text).toBe(200);

    expect([...verbs()].sort()).toEqual([
      "create_note",
      "delete_note",
      "move_blocks",
      "restore_note",
      "set_properties",
      "write_container",
    ]);
    for (const row of rows) {
      expect(row.authored_by).toBe("human/robfischer1");
      expect(row.via).toBe("star/charon");
      expect(row.jti).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("no header: unattributed, as before", async () => {
    const { call, rows } = await door();
    const r = await call("create_note", { title: "U" }, { token: false });
    expect(r.status, r.text).toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("no header from a non-charon peer is untouched too", async () => {
    const { call, rows } = await door();
    const r = await call(
      "create_note",
      { title: "U2" },
      { token: false, peer: undefined },
    );
    expect(r.status, r.text).toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("the same header from a non-charon peer is refused, nothing written", async () => {
    const { call, rows } = await door();
    for (const peer of [
      undefined,
      { ...CHARON, spiffeId: `spiffe://${TD}/star/nomos`, name: "nomos" },
    ]) {
      const r = await call("create_note", { title: "S" }, { peer });
      expect(r.status).toBe(403);
      expect(r.text).toContain("act_assertion_forbidden");
    }
    expect(rows).toHaveLength(0);
  });

  it("refuses a replay of a good assertion, and args changed after minting", async () => {
    const { call, rows } = await door();
    const args = { title: "R" };
    const token = mint(argsDigest(JSON.stringify(args)));
    expect((await call("create_note", args, { token })).status).toBe(200);
    const n = rows.length;
    const replay = await call("create_note", args, { token });
    expect(replay.status).toBe(401);
    expect(replay.text).toContain("act_assertion_replayed");
    const swapped = await call(
      "create_note",
      { title: "R2" },
      { mintedOver: args },
    );
    expect(swapped.status).toBe(401);
    expect(rows).toHaveLength(n);
  });

  it("refuses a bad token, an empty header and a non-write path", async () => {
    const { call, rows } = await door();
    for (const token of ["", "x.y.z", "not a token"]) {
      expect(
        (await call("create_note", { title: "B" }, { token })).status,
      ).toBe(401);
    }
    // A good token still has no business on a read verb.
    const r = await call("list_tags", {}, {});
    expect(r.status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it("is case-insensitive in the header name (the HTTP layer's job)", async () => {
    const { call, rows } = await door();
    const r = await call(
      "create_note",
      { title: "C" },
      { headerName: "X-Charon-Act-Assertion" },
    );
    expect(r.status, r.text).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses every assertion when the config is unset; no-header calls still work", async () => {
    const { call, rows } = await door({});
    const bad = await call("create_note", { title: "N" });
    expect(bad.status).toBe(503);
    const ok = await call("create_note", { title: "N" }, { token: false });
    expect(ok.status, ok.text).toBe(200);
    expect(rows).toHaveLength(0);
  });
});

describe("actJwksFetch: Kairos's JWKS over its mTLS door", () => {
  const plain = okFetch;
  it("an https:// keyset with no fetch given is read through the door, built on first use", async () => {
    let built = 0;
    const seen: string[] = [];
    const door = () => {
      built += 1;
      return (u: string) => {
        seen.push(u);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("{}"),
        });
      };
    };
    const f = actJwksFetch("https://kairos:8301/jwks", undefined, door);
    expect(f).toBeDefined();
    expect(built).toBe(0);
    const signal = new AbortController().signal;
    await f?.("https://kairos:8301/jwks", { signal });
    await f?.("https://kairos:8301/jwks", { signal });
    expect(built).toBe(1);
    expect(seen).toEqual([
      "https://kairos:8301/jwks",
      "https://kairos:8301/jwks",
    ]);
  });
  it("a caller's own fetch wins over the door", () => {
    const f = actJwksFetch("https://kairos:8301/jwks", plain, () => {
      throw new Error("the door must not be built");
    });
    expect(f).toBe(plain);
  });
  it("an http:// keyset keeps the plain fetch (undefined: the global)", () => {
    expect(
      actJwksFetch("http://kairos/jwks", undefined, () => {
        throw new Error("the door must not be built");
      }),
    ).toBeUndefined();
  });
});
