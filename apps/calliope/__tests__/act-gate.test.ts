import { afterEach, describe, expect, it } from "vitest";
import { makeBackend } from "../src/mcp/backend.js";
import type { WriteAuthorship } from "../src/revision-store.js";
import { argsDigest } from "../src/args-digest.js";
import { ACT_ASSERTION_HEADER } from "../src/act-assertion.js";
import type { FetchLike } from "../src/act-assertion.js";
import { xfccService } from "../src/caller-author.js";
import {
  HEADER_ASSERTION_ACT,
  HEADER_ASSERTION_ARGS,
  HEADER_ASSERTION_AZP,
  HEADER_ASSERTION_JTI,
  assertionArgsSha256,
} from "../src/waypoint-assertion.js";
import { recordingWitness, serveDoor } from "./rest-door.js";
import { TD, mint, okFetch } from "./act-fixtures.js";

/**
 * The act-assertion gate on the SERVED door; everything is the real door.
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
  /** More headers, e.g. the ones the waypoint writes. */
  extra?: Record<string, string>;
}

async function door(
  env: Record<string, string> = ENV,
  actFetch: FetchLike = okFetch,
) {
  const backend = makeBackend("fixture");
  const revs = backend.revisions;
  if (revs === undefined) throw new Error("fixture backend has no revisions");
  const rows: WriteAuthorship[] = [];
  const orig = revs.recordAuthorship.bind(revs);
  revs.recordAuthorship = (r) => {
    rows.push(r);
    return orig(r);
  };
  const { witness } = recordingWitness();
  const { rest, base } = await serveDoor(
    {
      witness,
      client: backend.client,
      revisions: revs,
      chaos: backend.chaos,
      tags: backend.tags,
      containers: backend.containers,
      actFetch,
    },
    env,
  );
  closers.push(() => rest.close());
  const call = async (
    verb: string,
    args: Record<string, unknown>,
    o: CallOpts = {},
  ): Promise<{ status: number; text: string }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    Object.assign(headers, o.extra ?? {});
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

  it("attributes with no act env at all: flux sets none of it", async () => {
    // The door served as main() serves it, on the environment the cluster
    // gives it. 62e92ad removed this gate and flux dropped
    // STELLAR_KAIROS_JWKS_URL; either alone leaves write_authorship empty.
    const { call, rows } = await door({});
    const r = await call("create_note", { title: "N" });
    expect(r.status, r.text).toBe(200);
    // create_note lands several transactions; each is attributed.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.authored_by).toBe("human/robfischer1");
  });

  it("refuses every assertion when Kairos's keyset is unreachable; no-header calls still work", async () => {
    const { call, rows } = await door(ENV, () =>
      Promise.reject(new Error("econnrefused")),
    );
    const bad = await call("create_note", { title: "N" });
    expect(bad.status).toBe(503);
    const ok = await call("create_note", { title: "N" }, { token: false });
    expect(ok.status, ok.text).toBe(200);
    expect(rows).toHaveLength(0);
  });
});

/** What the prime waypoint writes for a verified Kairos token, as hades relays it. */
const ROB = "spiffe://notusmi.com/human/robfischer1";
const HADES_XFCC =
  "By=spiffe://notusmi.com/ns/prime/sa/calliope;Hash=ab;URI=spiffe://notusmi.com/ns/prime/sa/hades";
const waypoint = (sub: string, xfcc: string = HADES_XFCC) => ({
  "x-kairos-sub": sub,
  "x-kairos-txn": "t-1",
  "x-forwarded-client-cert": xfcc,
});

describe("caller author: the waypoint-verified human, with no act assertion", () => {
  it("attributes every write verb to the human the waypoint names", async () => {
    const { call, rows } = await door();
    const r = await call(
      "create_note",
      { title: "W" },
      { token: false, extra: waypoint(ROB) },
    );
    expect(r.status, r.text).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        authored_by: "human/robfischer1",
        via: "spiffe://notusmi.com/ns/prime/sa/hades",
        verb: "create_note",
        jti: "txn:t-1",
      });
    }
  });

  it("names no one without the waypoint's XFCC", async () => {
    const { call, rows } = await door();
    const r = await call(
      "create_note",
      { title: "X" },
      { token: false, extra: { "x-kairos-sub": ROB } },
    );
    expect(r.status, r.text).toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("records no row for a session, a star or another trust domain", async () => {
    const { call, rows } = await door();
    for (const sub of [
      "spiffe://notusmi.com/session/0b5c8f0e-1111-4222-8333-444455556666",
      "spiffe://notusmi.com/star/charon",
      "spiffe://evil.example/human/robfischer1",
      `${ROB}/extra`,
    ]) {
      const r = await call(
        "create_note",
        { title: "S" },
        { token: false, extra: waypoint(sub) },
      );
      expect(r.status, r.text).toBe(200);
    }
    expect(rows).toHaveLength(0);
  });

  it("a verified act assertion wins over the caller headers", async () => {
    const { call, rows } = await door();
    const r = await call(
      "create_note",
      { title: "A" },
      { extra: waypoint("spiffe://notusmi.com/human/someoneelse") },
    );
    expect(r.status, r.text).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.authored_by).toBe("human/robfischer1");
      expect(row.via).toBe("star/charon");
    }
  });
});

describe("xfccService", () => {
  const bag = (v: string[]) => ({ getAll: () => v });
  it("reads the one URI of one element", () => {
    expect(xfccService(bag([HADES_XFCC]))).toBe(
      "spiffe://notusmi.com/ns/prime/sa/hades",
    );
    expect(xfccService(bag(['URI="spiffe://td/x"']))).toBe("spiffe://td/x");
  });
  it("refuses none, several, a chain, two URIs and a non-SPIFFE URI", () => {
    for (const v of [
      [],
      [HADES_XFCC, HADES_XFCC],
      [`${HADES_XFCC},${HADES_XFCC}`],
      ["URI=spiffe://a/b;URI=spiffe://c/d"],
      ["URI=https://example.com"],
      ["URI=spiffe://"],
    ]) {
      expect(xfccService(bag(v))).toBe("");
    }
  });
});

describe("act gate: the waypoint's verified assertion claims", () => {
  const CHARON_XFCC = "URI=spiffe://cluster.local/ns/prime/sa/charon-sa";
  const JTI = "00112233445566778899aabbccddeeff";
  const claims = (
    act: string,
    args: Record<string, unknown>,
    jti = JTI,
  ): Record<string, string> => ({
    "x-forwarded-client-cert": CHARON_XFCC,
    [HEADER_ASSERTION_ACT]: act,
    [HEADER_ASSERTION_JTI]: jti,
    [HEADER_ASSERTION_ARGS]: assertionArgsSha256(act, args),
    [HEADER_ASSERTION_AZP]: `spiffe://${TD}/human/robfischer1`,
  });

  it("digests the tool over its canonical arguments, as Kairos binds an approval", () => {
    expect(assertionArgsSha256("calliope_create_note", { title: "W" })).toBe(
      "0fd22484a77e818aa26544528ab6300cd35df275f7f5512b5c0d36e14c043537",
    );
  });

  it("runs a write whose claims match, as the human they name", async () => {
    const { call, rows } = await door();
    const args = { title: "W" };
    const r = await call("create_note", args, {
      token: false,
      extra: claims("calliope_create_note", args),
    });
    expect(r.status, r.text).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.authored_by).toBe("human/robfischer1");
      expect(row.via).toBe("spiffe://cluster.local/ns/prime/sa/charon-sa");
      expect(row.jti).toBe(JTI);
    }
  });

  it("refuses a spent jti, other arguments, another act and a missing claim", async () => {
    const { call, rows } = await door();
    const args = { title: "S" };
    const good = claims("calliope_create_note", args);
    expect(
      (await call("create_note", args, { token: false, extra: good })).status,
    ).toBe(200);
    const n = rows.length;
    const replay = await call("create_note", args, {
      token: false,
      extra: good,
    });
    expect(replay.status).toBe(401);
    expect(replay.text).toContain("act_assertion_replayed");
    const other = await call(
      "create_note",
      { title: "S2" },
      {
        token: false,
        extra: claims("calliope_create_note", args, "1".repeat(32)),
      },
    );
    expect(other.status).toBe(401);
    expect(other.text).toContain("args do not match");
    const act = await call("create_note", args, {
      token: false,
      extra: claims("calliope_write_container", args, "2".repeat(32)),
    });
    expect(act.status).toBe(403);
    const partial = Object.fromEntries(
      Object.entries(
        claims("calliope_create_note", args, "3".repeat(32)),
      ).filter(([k]) => k !== HEADER_ASSERTION_AZP),
    );
    const missing = await call("create_note", args, {
      token: false,
      extra: partial,
    });
    expect(missing.status).toBe(401);
    expect(rows).toHaveLength(n);
  });

  it("refuses claims beside a legacy assertion header, and on a read verb", async () => {
    const { call, rows } = await door();
    const args = { title: "L" };
    const both = await call("create_note", args, {
      extra: claims("calliope_create_note", args, "4".repeat(32)),
    });
    expect(both.status).toBe(401);
    const read = await call(
      "list_tags",
      {},
      {
        token: false,
        extra: claims("calliope_list_tags", {}, "5".repeat(32)),
      },
    );
    expect(read.status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it("injects dry_run:false for the /live path before the digest", async () => {
    const { call } = await door();
    const made = await call("create_note", { title: "D" }, { token: false });
    const id = hex(made.text, "node_id");
    expect(id).not.toBe("");
    const args = { ids: [id], dry_run: false };
    const r = await call("delete_note", args, {
      token: false,
      extra: claims("calliope_delete_note", args, "6".repeat(32)),
    });
    expect(r.status, r.text).toBe(200);
  });
});
