import { afterEach, describe, expect, it } from "vitest";
import { makeBackend } from "../src/mcp/backend.js";
import type { WriteAuthorship } from "../src/revision-store.js";
import { onBehalfOf } from "../src/act-assertion.js";
import { callerSubject, xfccService } from "../src/caller-author.js";
import {
  HEADER_ASSERTION_ACT,
  HEADER_ASSERTION_ARGS,
  HEADER_ASSERTION_AZP,
  HEADER_ASSERTION_JTI,
  assertionArgsSha256,
} from "../src/waypoint-assertion.js";
import { recordingWitness, serveDoor } from "./rest-door.js";
import { TD } from "./act-fixtures.js";

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
  /** More headers, e.g. the ones the waypoint writes. */
  extra?: Record<string, string>;
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
  // The subject each chaos admit runs under: what a direct capture forwards
  // as on_behalf_of (direct-capture.test.ts pins that hop).
  const subjects: string[] = [];
  const dial = backend.chaos?.dial;
  if (dial === undefined) throw new Error("fixture backend has no chaos dial");
  const admit = dial.admit.bind(dial);
  dial.admit = (...a: Parameters<typeof admit>) => {
    subjects.push(onBehalfOf());
    return admit(...a);
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
  return { call, read, rows, subjects };
}

const hex = (t: string, key: string): string =>
  new RegExp(`"${key}\\\\?":\\\\?"([0-9a-f]{64})`).exec(t)?.[1] ?? "";

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
      { extra: waypoint(ROB) },
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
      { extra: { "x-kairos-sub": ROB } },
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
        { extra: waypoint(sub) },
      );
      expect(r.status, r.text).toBe(200);
    }
    expect(rows).toHaveLength(0);
  });
});

describe("on_behalf_of subject: every verified path reaches the chaos admit", () => {
  const SUBJECT = `spiffe://${TD}/human/robfischer1`;

  it("the waypoint's x-kairos-sub: the human it names", async () => {
    const { call, subjects } = await door();
    const r = await call(
      "create_note",
      { title: "W" },
      { extra: waypoint(ROB) },
    );
    expect(r.status, r.text).toBe(200);
    expect(subjects.length).toBeGreaterThan(0);
    for (const s of subjects) expect(s).toBe(ROB);
  });

  it("the waypoint's assertion claims: the azp human", async () => {
    const { call, subjects } = await door();
    const args = { title: "C" };
    const r = await call("create_note", args, {
      extra: {
        "x-forwarded-client-cert":
          "URI=spiffe://cluster.local/ns/prime/sa/charon-sa",
        [HEADER_ASSERTION_ACT]: "calliope_create_note",
        [HEADER_ASSERTION_JTI]: "ffeeddccbbaa99887766554433221100",
        [HEADER_ASSERTION_ARGS]: assertionArgsSha256(
          "calliope_create_note",
          args,
        ),
        [HEADER_ASSERTION_AZP]: SUBJECT,
      },
    });
    expect(r.status, r.text).toBe(200);
    expect(subjects.length).toBeGreaterThan(0);
    for (const s of subjects) expect(s).toBe(SUBJECT);
  });

  it("a waypoint-verified session or star: its own subject, and no authorship row", async () => {
    const { call, rows, subjects } = await door();
    for (const sub of [
      "spiffe://notusmi.com/session/0b5c8f0e-1111-4222-8333-444455556666",
      "spiffe://notusmi.com/star/charon",
    ]) {
      subjects.length = 0;
      const r = await call(
        "create_note",
        { title: `S ${sub}` },
        { extra: waypoint(sub) },
      );
      expect(r.status, r.text).toBe(200);
      expect(subjects.length).toBeGreaterThan(0);
      for (const s of subjects) expect(s).toBe(sub);
    }
    expect(rows).toHaveLength(0);
  });

  it("another trust domain or a malformed subject names no one", async () => {
    const { call, subjects } = await door();
    for (const sub of [
      "spiffe://evil.example/human/robfischer1",
      "spiffe://notusmi.com/",
      "spiffe://notusmi.com/session//x",
      "spiffe://notusmi.com/session/a b",
    ]) {
      const r = await call(
        "create_note",
        { title: "E" },
        { extra: waypoint(sub) },
      );
      expect(r.status, r.text).toBe(200);
    }
    expect(subjects.length).toBeGreaterThan(0);
    for (const s of subjects) expect(s).toBe("");
  });

  it("an unverified x-kairos-sub (no waypoint XFCC) names no one", async () => {
    const { call, subjects } = await door();
    const r = await call(
      "create_note",
      { title: "U" },
      { extra: { "x-kairos-sub": ROB } },
    );
    expect(r.status, r.text).toBe(200);
    expect(subjects.length).toBeGreaterThan(0);
    for (const s of subjects) expect(s).toBe("");
  });
});

describe("callerSubject", () => {
  const bag = (h: Record<string, string[]>) => ({
    getAll: (n: string) => h[n.toLowerCase()] ?? [],
  });
  const S = "spiffe://notusmi.com/session/abc";
  it("answers the one verified subject of this trust domain", () => {
    expect(
      callerSubject(
        bag({ "x-kairos-sub": [S], "x-forwarded-client-cert": [HADES_XFCC] }),
        "notusmi.com",
      ),
    ).toBe(S);
  });
  it("refuses no XFCC, two subjects, an empty trust domain and an overlong id", () => {
    const x = { "x-forwarded-client-cert": [HADES_XFCC] };
    expect(callerSubject(bag({ "x-kairos-sub": [S] }), "notusmi.com")).toBe(
      undefined,
    );
    expect(
      callerSubject(bag({ ...x, "x-kairos-sub": [S, S] }), "notusmi.com"),
    ).toBe(undefined);
    expect(callerSubject(bag({ ...x, "x-kairos-sub": [S] }), "")).toBe(
      undefined,
    );
    const long = `spiffe://notusmi.com/session/${"a".repeat(240)}`;
    expect(
      callerSubject(bag({ ...x, "x-kairos-sub": [long] }), "notusmi.com"),
    ).toBe(undefined);
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
    expect((await call("create_note", args, { extra: good })).status).toBe(200);
    const n = rows.length;
    const replay = await call("create_note", args, {
      extra: good,
    });
    expect(replay.status).toBe(401);
    expect(replay.text).toContain("act_assertion_replayed");
    const other = await call(
      "create_note",
      { title: "S2" },
      {
        extra: claims("calliope_create_note", args, "1".repeat(32)),
      },
    );
    expect(other.status).toBe(401);
    expect(other.text).toContain("args do not match");
    const act = await call("create_note", args, {
      extra: claims("calliope_write_container", args, "2".repeat(32)),
    });
    expect(act.status).toBe(403);
    const partial = Object.fromEntries(
      Object.entries(
        claims("calliope_create_note", args, "3".repeat(32)),
      ).filter(([k]) => k !== HEADER_ASSERTION_AZP),
    );
    const missing = await call("create_note", args, {
      extra: partial,
    });
    expect(missing.status).toBe(401);
    expect(rows).toHaveLength(n);
  });

  it("refuses claims on a read verb", async () => {
    const { call, rows } = await door();
    const read = await call(
      "list_tags",
      {},
      { extra: claims("calliope_list_tags", {}, "5".repeat(32)) },
    );
    expect(read.status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it("injects dry_run:false for the /live path before the digest", async () => {
    const { call } = await door();
    const made = await call("create_note", { title: "D" });
    const id = hex(made.text, "node_id");
    expect(id).not.toBe("");
    const args = { ids: [id], dry_run: false };
    const r = await call("delete_note", args, {
      extra: claims("calliope_delete_note", args, "6".repeat(32)),
    });
    expect(r.status, r.text).toBe(200);
  });
});
