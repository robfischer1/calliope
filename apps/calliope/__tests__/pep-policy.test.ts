import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoSidecarError, loadAcl, parseAcl } from "../src/mcp/pep/acl.js";
import type { Acl } from "../src/mcp/pep/acl.js";
import { consumerOf, decide } from "../src/mcp/pep/decide.js";
import type { Decision } from "../src/mcp/pep/decide.js";
import { enforced, refusal } from "../src/mcp/pep/enforce.js";
import { resolveMode } from "../src/mcp/pep/pep.js";
import { parseToml } from "../src/mcp/pep/toml.js";
import { peerFor, sidecarWith } from "./helpers/pep.js";

/**
 * The endpoint PEP's pure half, mirroring stellar-core-go `policy/*_test.go`
 * case for case. `fixtures/pep/decisions.json` and `fixtures/pep/sidecars/` are
 * the Go repo's `policy/testdata`, copied verbatim: the cross-port case set a
 * port replays.
 */

interface WantDecision {
  verdict: string;
  reason: string;
  contract?: string;
  principal?: string;
  principal_type?: string;
}
interface DecisionCase {
  name: string;
  star: string;
  sidecar: string | { toml: string } | null;
  peer_spiffe_id?: string;
  untyped_certificate?: boolean;
  meta?: Record<string, unknown>;
  verb: string;
  want: WantDecision;
}
interface AclCase {
  name: string;
  sidecar?: string;
  toml?: string;
  error?: boolean;
  entries?: number;
  all_approved?: boolean;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/pep/decisions.json", import.meta.url),
    "utf8",
  ),
) as { acl_cases: AclCase[]; decision_cases: DecisionCase[] };

const sidecarPath = (name: string): string =>
  new URL(`./fixtures/pep/sidecars/${name}.orbit.toml`, import.meta.url)
    .pathname;

const dec = (d: Partial<Decision>): Decision => ({
  verdict: "deny",
  reason: "no_edge",
  contract: "",
  principal: "",
  principalType: "",
  ...d,
});

describe("TestDecisionFixtures: the cross-port decision cases", () => {
  function aclFor(c: DecisionCase): Acl | undefined {
    if (c.sidecar === null) return undefined;
    if (typeof c.sidecar === "string") {
      return loadAcl(c.star, sidecarPath(c.sidecar));
    }
    return parseAcl(c.star, c.sidecar.toml);
  }

  it("replays every case", () => {
    expect(fixtures.decision_cases.length).toBeGreaterThan(20);
  });

  it.each(fixtures.decision_cases.map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      const peer = c.untyped_certificate
        ? peerFor("untyped")
        : peerFor(c.peer_spiffe_id);
      expect(
        decide(aclFor(c), { peer, meta: c.meta, verb: c.verb }),
      ).toEqual<Decision>({
        verdict: c.want.verdict as Decision["verdict"],
        reason: c.want.reason as Decision["reason"],
        contract: c.want.contract ?? "",
        principal: c.want.principal ?? "",
        principalType: c.want.principal_type ?? "",
      });
    },
  );
});

describe("TestACLFixtures: the cross-port ACL cases", () => {
  it.each(fixtures.acl_cases.map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      const parse = (): Acl =>
        c.sidecar !== undefined
          ? loadAcl(c.sidecar, sidecarPath(c.sidecar))
          : parseAcl("teststar", c.toml ?? "");
      if (c.error === true) {
        expect(parse).toThrow();
        return;
      }
      const acl = parse();
      expect(acl.size).toBe(c.entries);
      expect(acl.allApproved()).toBe(c.all_approved);
    },
  );
});

describe("TestLoadACLFaultsAreDistinguishable", () => {
  it("absent is NoSidecarError; unreadable is not; unparseable says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "calliope-pep-"));
    expect(() => loadAcl("urania", join(dir, "orbit.toml"))).toThrow(
      NoSidecarError,
    );
    // A directory reads as an error, not absence.
    let unreadable: unknown;
    try {
      loadAcl("urania", dir);
    } catch (err) {
      unreadable = err;
    }
    expect(unreadable).toBeInstanceOf(Error);
    expect(unreadable).not.toBeInstanceOf(NoSidecarError);
    expect(() => parseAcl("urania", "[[produces]\n")).toThrow(
      /^urania: orbit sidecar does not parse: /,
    );
  });
});

describe("TestEntryCarriesItsBlock", () => {
  it("a grant carries every field of its block, not just the verbs", () => {
    const acl = loadAcl("urania", sidecarPath("urania"));
    expect(acl.star).toBe("urania");
    const e = acl.entry("athena");
    expect(e).toMatchObject({
      consumer: "athena",
      contract: "urania-athena",
      version: "0",
      status: "generated",
    });
    expect([...(e?.verbs ?? [])].sort()).toEqual(["neighbors", "shapes"]);
    // chaos is a consumes block on urania, never a grant
    expect(acl.entry("chaos")).toBeUndefined();
  });
});

describe("TestEnforced", () => {
  const acl = parseAcl(
    "urania",
    readFileSync(sidecarWith("generated"), "utf8"),
  );
  it.each([
    [
      "approved edge",
      "athena",
      dec({ verdict: "allow", reason: "edge_allows" }),
      "allow",
      "edge_allows",
    ],
    [
      "generated edge",
      "themis",
      dec({ verdict: "allow", reason: "edge_allows" }),
      "deny",
      "edge_not_approved",
    ],
    [
      "nobody asked",
      "",
      dec({ verdict: "consult", reason: "pdp_not_consulted" }),
      "deny",
      "pdp_not_consulted",
    ],
    [
      "no edge",
      "chaos",
      dec({ verdict: "deny", reason: "no_edge" }),
      "deny",
      "no_edge",
    ],
    [
      "unidentified",
      "",
      dec({ verdict: "deny", reason: "unidentified" }),
      "deny",
      "unidentified",
    ],
  ] as const)("%s", (_name, consumer, input, verdict, reason) => {
    const got = enforced(acl, consumer, input);
    expect([got.verdict, got.reason]).toEqual([verdict, reason]);
  });
});

describe("TestACLApproved", () => {
  it("approved: athena only", () => {
    const acl = parseAcl(
      "urania",
      readFileSync(sidecarWith("generated"), "utf8"),
    );
    expect(acl.approved("athena")).toBe(true);
    expect(acl.approved("themis")).toBe(false);
    expect(acl.approved("chaos")).toBe(false);
  });
});

describe("TestRefusalNamesTheFix", () => {
  const cases = [
    [
      "no_edge",
      "chaos",
      "spiffe://notusmi.com/star/chaos",
      "spiffe://notusmi.com/star/chaos",
      "foundry-dies/orbits/urania-chaos.toml",
    ],
    [
      "verb_not_on_edge",
      "athena",
      "x",
      "x",
      "foundry-dies/orbits/urania-athena.toml",
    ],
    [
      "edge_not_approved",
      "themis",
      "x",
      "x",
      "foundry-dies/orbits/urania-themis.toml",
    ],
    [
      "no_acl",
      "athena",
      "x",
      "x",
      "the star's orbit sidecar (ConfigMap orbit-urania), composed from foundry-dies/orbits/urania-athena.toml",
    ],
    [
      "unidentified",
      "",
      "",
      "unidentified",
      "dial the star's mTLS port (plaintext port + 1) presenting a SPIFFE SVID",
    ],
    [
      "pdp_not_consulted",
      "",
      "x",
      "x",
      "foundry-dies/policy/authz_grants/data.json",
    ],
  ] as const;
  it.each(cases)("%s", (reason, consumer, caller, wantCaller, wantFix) => {
    const res = refusal(
      "urania",
      "neighbors",
      caller,
      consumer,
      dec({ reason, principal: "p" }),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    const want = {
      refused: "pep",
      star: "urania",
      verb: "neighbors",
      caller: wantCaller,
      principal: "p",
      reason,
      fix: wantFix,
    };
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual(want);
    expect(res.structuredContent).toEqual(want);
  });
});

describe("TestResolveMode", () => {
  // Go's table, with the two deliberate differences: unset is witness (the
  // TS star has no `off`), and `off` itself is a mis-set switch here.
  it.each([
    ["", "witness", true],
    [undefined, "witness", true],
    ["witness", "witness", true],
    ["enforce", "enforce", true],
    ["ENFORCE", "witness", false],
    ["audit", "witness", false],
    ["off", "witness", false],
  ] as const)("%j -> %s", (raw, mode, recognized) => {
    expect(resolveMode(raw)).toEqual({ mode, recognized });
  });
});

describe("consumerOf", () => {
  it("a star is its bare name, a CI lane's run is job.<lane>, anyone else is the non-service path", () => {
    expect(consumerOf(peerFor("spiffe://notusmi.com/star/athena"))).toBe(
      "athena",
    );
    expect(consumerOf(peerFor(SESSION_ID))).toBe("");
    expect(consumerOf(undefined)).toBe("");
    expect(consumerOf({ spiffeId: JOB_ID, kind: "job", name: JOB_ID })).toBe(
      "job.gate",
    );
  });

  it("a job edge is held like a star's, under consumer job.<lane>", () => {
    const acl = parseAcl(
      "urania",
      '[[produces]]\nto = "job.gate"\ncontract = "urania-job.gate"\nstatus = "approved"\nverbs = ["neighbors"]\n',
    );
    const peer = { spiffeId: JOB_ID, kind: "job", name: JOB_ID } as const;
    expect(decide(acl, { peer, verb: "neighbors" })).toMatchObject({
      verdict: "allow",
      reason: "edge_allows",
      contract: "urania-job.gate",
    });
  });
});

const SESSION_ID =
  "spiffe://notusmi.com/session/5906d6fc-aba9-49ab-a8af-3b1e56409c49";
const JOB_ID = "spiffe://notusmi.com/job/gate/run-42";

describe("the composed sidecar dialect (TS-only: no TOML library behind the parser)", () => {
  it("calliope's own composed sidecar parses: four approved grants", () => {
    const acl = loadAcl("calliope", sidecarPath("calliope"));
    expect(acl.size).toBe(4);
    expect(acl.allApproved()).toBe(true);
    expect([...(acl.entry("proteus")?.verbs ?? [])].sort()).toEqual([
      "dissolve_note",
      "materialize_note",
      "read_container",
      "write_container",
    ]);
  });

  it("reads comments, literal strings, escapes, numbers and multi-line arrays", () => {
    const doc = parseToml(
      [
        "# a comment",
        "[[produces]] # trailing",
        "to = 'a'",
        'contract = "s\\u002Da"',
        "verbs = [",
        '  "v1", # one',
        '  "v2",',
        "]",
        "n = 1_000",
        "ok = true",
        "[consumes_info]",
        'x = "ignored table"',
      ].join("\n"),
    );
    const block = doc.arrays.get("produces")?.[0];
    expect(block?.get("to")).toBe("a");
    expect(block?.get("contract")).toBe("s-a");
    expect(block?.get("verbs")).toEqual(["v1", "v2"]);
    expect(block?.get("n")).toBe(1000);
    expect(doc.plainTables.has("consumes_info")).toBe(true);
  });

  it.each([
    ["dotted key", "a.b = 1"],
    ["inline table", "a = { b = 1 }"],
    ["multi-line string", 'a = """x"""'],
    ["a date", "a = 1979-05-27"],
    ["duplicate key", "a = 1\na = 2"],
    ["text after a statement", "a = 1 b = 2"],
    ["unterminated string", 'a = "x'],
    ["produces as a plain table", '[produces]\nto = "a"\ncontract = "c"'],
    [
      "a wrong-typed status",
      '[[produces]]\nto = "a"\ncontract = "c"\nstatus = 1',
    ],
  ])("refuses %s rather than misreading a grant", (_name, text) => {
    expect(() => parseAcl("s", text)).toThrow();
  });
});
