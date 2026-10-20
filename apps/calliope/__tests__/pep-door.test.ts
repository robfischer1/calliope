import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLog, runWithPeer } from "@forge/stellar-core-ts";
import type { RequestRecord, ToolCallHandler } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import { pepHandler } from "@forge/stellar-core-ts/pep";
import {
  enforcePreconditions,
  loadPep,
  pepConfigFromEnv,
} from "@forge/stellar-core-ts/pep";
import type { Pep } from "@forge/stellar-core-ts/pep";
import { makeWitness } from "../src/mcp/witness.js";
import type { Witness } from "../src/mcp/witness.js";
import { SESSION, peerFor, recordingLog } from "./helpers/pep.js";
import { makeIdentity } from "./helpers/tls-identity.js";
import type { TlsIdentity } from "./helpers/tls-identity.js";

/**
 * The PEP on the dispatcher, mirroring stellar-core-go `policy/middleware_test.go`
 * and `enforce_test.go`: every caller shape, what it was answered, the ONE record
 * it left, and the counter. `urania` is the Go suite's star. Since
 * stellar-core-ts 0.82.0 there is no ACL: the network (mTLS + NetworkPolicy)
 * admits star/job/ci callers, so the PEP allows them `network_enforced`.
 */

const stamp = (principal: string): Record<string, unknown> => ({
  "hades/principal": principal,
  "hades/principal-type": "session",
});
const AGENT = { "hades/principal-type": "agent" };
const star = (name: string): string => `spiffe://notusmi.com/star/${name}`;

interface Door {
  readonly pep: Pep;
  readonly got: RequestRecord[];
  readonly ran: () => number;
  /** One tools/call as `caller` ("" = plaintext); resolves to the verb's answer
   *  or the PEP's refusal. */
  call(
    caller: string,
    verb: string,
    meta?: Record<string, unknown>,
  ): Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

function door(pep: Pep, withLog = true): Door {
  const { log, got } = recordingLog("urania");
  let ran = 0;
  const verb: ToolCallHandler = () => {
    ran += 1;
    return { content: [{ type: "text", text: '{"ok":true}' }] };
  };
  const handler = pepHandler(
    withLog ? log : new RequestLog("urania"),
    pep,
    verb,
  );
  return {
    pep,
    got,
    ran: () => ran,
    call: async (caller, name, meta) =>
      (await runWithPeer(peerFor(caller), () =>
        handler(
          {
            params: {
              name,
              arguments: {},
              ...(meta === undefined ? {} : { _meta: meta }),
            },
          } as never,
          {},
        ),
      )) as never,
  };
}

const quiet = (): void => undefined;
const arm = (mode: string): Pep =>
  loadPep({ star: "urania", mode, log: quiet });

describe("TestWitnessRecordsAndRefusesNothing", () => {
  it("every caller shape is decided, recorded on the call's one record, counted, and answered by the verb", async () => {
    const d = door(arm("witness"));
    const cases = [
      [
        star("athena"),
        "neighbors",
        undefined,
        "allow",
        "network_enforced",
        "",
        "",
      ],
      [
        star("athena"),
        "declare_litigant",
        undefined,
        "allow",
        "network_enforced",
        "",
        "",
      ],
      [
        star("chaos"),
        "neighbors",
        stamp(SESSION),
        "allow",
        "network_enforced",
        "",
        "",
      ],
      ["", "neighbors", undefined, "would_deny", "unidentified", "", ""],
      [
        star("hades"),
        "neighbors",
        stamp(SESSION),
        "would_consult",
        "pdp_not_consulted",
        SESSION,
        "session",
      ],
      [
        star("hades"),
        "neighbors",
        undefined,
        "allow",
        "network_enforced",
        "",
        "",
      ],
    ] as const;
    for (const [caller, verb, meta] of cases) {
      const res = await d.call(caller, verb, meta);
      expect(res.isError).toBeUndefined(); // witness refuses nothing
    }
    expect(d.ran()).toBe(cases.length);
    expect(d.got).toHaveLength(cases.length);
    cases.forEach(([, , , decision, reason, principal, principalType], i) => {
      const r = d.got[i];
      expect(r).toMatchObject({ decision, reason, outcome: "ok" });
      expect(r?.principal).toBe(principal === "" ? undefined : principal);
      expect(r?.principal_type).toBe(
        principalType === "" ? undefined : principalType,
      );
    });
    expect(d.pep.counts()).toEqual({
      "witness/allow/network_enforced": 4,
      "witness/would_consult/pdp_not_consulted": 1,
      "witness/would_deny/unidentified": 1,
    });
  });

  it("outside a witnessed call the PEP still counts, and still refuses nothing", async () => {
    const d = door(arm("witness"), false);
    const res = await d.call("", "neighbors");
    expect(res.isError).toBeUndefined();
    expect(d.got).toHaveLength(0); // no sink, no record
    expect(d.pep.counts()).toEqual({ "witness/would_deny/unidentified": 1 });
  });
});

describe("TestEnforceRefusesBeforeTheHandler", () => {
  // Go's matrix minus the policy-plane rows (no PDP wired here: the gateway
  // and session paths are refused pdp_not_consulted, which Go's TestEnforceFailsClosed
  // "no PDP" row pins; the wired-PDP rows are pep-pdp.test.ts). Star callers
  // are allowed network_enforced whatever the verb: there is no per-edge ACL.
  const other =
    "spiffe://notusmi.com/session/00000000-0000-0000-0000-000000000000";
  const cases = [
    { caller: star("athena"), verb: "neighbors", reason: "" },
    { caller: star("athena"), verb: "declare_litigant", reason: "" },
    { caller: star("themis"), verb: "neighbors", reason: "" },
    {
      caller: star("chaos"),
      verb: "neighbors",
      meta: stamp(SESSION),
      reason: "",
    },
    { caller: "", verb: "neighbors", reason: "unidentified" },
    {
      caller: star("hades"),
      verb: "neighbors",
      meta: stamp(SESSION),
      reason: "pdp_not_consulted",
      principal: SESSION,
    },
    {
      caller: star("hades"),
      verb: "neighbors",
      meta: stamp(other),
      reason: "pdp_not_consulted",
      principal: other,
    },
    {
      caller: star("hades"),
      verb: "neighbors",
      meta: AGENT,
      reason: "pdp_not_consulted",
    },
    // An unstamped hades call is served: the network admitted the gateway.
    { caller: star("hades"), verb: "neighbors", reason: "" },
    {
      caller: SESSION,
      verb: "neighbors",
      reason: "pdp_not_consulted",
      principal: SESSION,
    },
  ] as const;

  it("refuses what is not allowed, never reaching the verb, with one record each", async () => {
    const d = door(arm("enforce"));
    for (const c of cases) {
      const res = await d.call(
        c.caller,
        c.verb,
        "meta" in c ? c.meta : undefined,
      );
      if (c.reason === "") {
        expect(res.isError).toBeUndefined();
      } else {
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toMatchObject({
          refused: "pep",
          reason: c.reason,
        });
      }
    }
    expect(d.ran()).toBe(5); // only the allowed calls
    expect(d.got).toHaveLength(cases.length);
    cases.forEach((c, i) => {
      const r = d.got[i];
      const allowed = c.reason === "";
      expect(r).toMatchObject({
        decision: allowed ? "allow" : "deny",
        outcome: allowed ? "ok" : "denied",
      });
      if (!allowed) expect(r?.reason).toBe(c.reason);
      expect(r?.principal).toBe("principal" in c ? c.principal : undefined);
    });
    expect(d.pep.counts()).toEqual({
      "enforce/allow/network_enforced": 5,
      "enforce/deny/pdp_not_consulted": 4,
      "enforce/deny/unidentified": 1,
    });
  });

  it("outside a witnessed call an enforcing PEP still refuses and still counts", async () => {
    const d = door(arm("enforce"), false);
    const res = await d.call("", "neighbors");
    expect(res.isError).toBe(true);
    expect(d.got).toHaveLength(0);
    expect(d.pep.counts()).toEqual({ "enforce/deny/unidentified": 1 });
  });

  it("a refusal is the Go body: a tool error naming the caller and where it is mended", async () => {
    const d = door(arm("enforce"));
    const anon = await d.call("", "neighbors");
    expect(anon.structuredContent).toEqual({
      refused: "pep",
      star: "urania",
      verb: "neighbors",
      caller: "unidentified",
      reason: "unidentified",
      fix: "dial the star's mTLS port (plaintext port + 1) presenting a SPIFFE SVID",
    });
    const session = await d.call(SESSION, "neighbors");
    expect(session.structuredContent).toEqual({
      refused: "pep",
      star: "urania",
      verb: "neighbors",
      caller: SESSION,
      principal: SESSION,
      reason: "pdp_not_consulted",
      fix: "foundry-dies/policy/authz_grants/data.json",
    });
  });
});

describe("TestEnforceFailsClosed (the no-PDP row)", () => {
  it("no policy plane refuses the gateway path pdp_not_consulted, with the star up", async () => {
    const d = door(arm("enforce"));
    const res = await d.call(star("hades"), "neighbors", stamp(SESSION));
    expect(res.structuredContent).toMatchObject({
      reason: "pdp_not_consulted",
    });
    expect(d.ran()).toBe(0);
    expect(d.got).toMatchObject([
      { outcome: "denied", reason: "pdp_not_consulted" },
    ]);
  });
});

describe("enforce preconditions at boot (enforcePreconditions)", () => {
  const pdp = { decide: () => Promise.reject(new Error("unused")) } as never;
  const boot = (mode: string, withPdp: boolean): string => {
    const lines: string[] = [];
    loadPep({
      star: "urania",
      mode,
      pdp: withPdp ? pdp : undefined,
      log: (l) => lines.push(l),
    });
    return lines.join("\n");
  };

  it("a PDP: no gap, no warning", () => {
    expect(boot("enforce", true)).not.toContain("unmet preconditions");
    expect(enforcePreconditions(true)).toHaveLength(0);
  });

  it("no PDP names pdp_not_consulted", () => {
    const out = boot("enforce", false);
    expect(out).toContain("ENFORCING on inbound calls");
    expect(out).toContain("unmet preconditions");
    expect(out).toContain("no PDP");
    expect(out).toContain("pdp_not_consulted");
  });

  it("the one gap is the missing PDP", () => {
    expect(enforcePreconditions(false)).toHaveLength(1);
  });

  it("enforce reads nothing from disk: it boots with no sidecar anywhere", () => {
    expect(() => boot("enforce", true)).not.toThrow();
  });

  it("witness never warns", () => {
    expect(boot("witness", false)).not.toContain("unmet preconditions");
  });
});

describe("the mode machine at boot (TestNewModes, TestAnUnknownModeRunsWitnessLoudly, TestConfigFromEnv)", () => {
  it("witness is the default", () => {
    const lines: string[] = [];
    const pep = loadPep({ star: "urania", log: (l) => lines.push(l) });
    expect(pep.mode).toBe("witness");
    expect(lines.join("\n")).toContain("witnessing inbound calls");
    expect(lines.join("\n")).not.toContain("ENFORCING");
  });

  it("enforce arms and says so", () => {
    const lines: string[] = [];
    const pep = loadPep({
      star: "urania",
      mode: "enforce",
      log: (l) => lines.push(l),
    });
    expect(pep.mode).toBe("enforce");
    expect(lines.join("\n")).toContain("ENFORCING on inbound calls");
  });

  it.each(["ENFORCE", "audit", "off", "true"])(
    "a mis-set mode %j runs witness, loudly, quoting the value",
    (raw) => {
      const lines: string[] = [];
      const pep = loadPep({
        star: "urania",
        mode: raw,
        log: (l) => lines.push(l),
      });
      expect(pep.mode).toBe("witness");
      const out = lines.join("\n");
      expect(out).toContain("is not a PEP mode");
      expect(out).toContain(JSON.stringify(raw));
      expect(out).toContain("WITNESS, which refuses nothing");
    },
  );

  it("a real mode is not called mis-set", () => {
    for (const mode of ["", "witness", "enforce"]) {
      const lines: string[] = [];
      loadPep({ star: "urania", mode, log: (l) => lines.push(l) });
      expect(lines.join("\n")).not.toContain("is not a PEP mode");
    }
  });

  it("reads the mode from STELLAR_PEP_MODE and nothing else from the environment", () => {
    const cfg = pepConfigFromEnv("calliope", {
      STELLAR_PEP_MODE: "enforce",
      STELLAR_ORBIT_SIDECAR: "/x/orbit.toml",
    });
    expect(cfg).toMatchObject({ star: "calliope", mode: "enforce" });
    expect(cfg).not.toHaveProperty("sidecarPath");
    expect(pepConfigFromEnv("calliope", {})).toMatchObject({
      star: "calliope",
      mode: undefined,
    });
  });
});

describe("BOOT reads nothing from disk", () => {
  it("a star caller is allowed network_enforced and the PEP refuses nothing", async () => {
    const pep = loadPep({ star: "calliope", mode: "witness", log: quiet });
    const d = await pep.adjudicate({
      peer: peerFor(star("athena")),
      verb: "read_container",
    });
    expect([d.verdict, d.reason]).toEqual(["allow", "network_enforced"]);
    expect(pep.refuses(d)).toBe(false);
  });
});

describe("the served route, through a real TLS handshake and the real transport", () => {
  const MCP_HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const envelope = (method: string, params: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  let open: Server | undefined;
  afterEach(async () => {
    const s = open;
    open = undefined;
    if (s?.listening)
      await new Promise<void>((r) =>
        s.close(() => {
          r();
        }),
      );
  });

  function served(pep: Pep): {
    server: Server;
    witness: Witness;
    got: RequestRecord[];
  } {
    const got: RequestRecord[] = [];
    // Through makeWitness's own sink wrapper, as production builds it.
    const witness = makeWitness({}, () => ({
      sink: (r) => {
        got.push(r);
      },
      reach: "stdout",
      close: () => Promise.resolve(),
    }));
    const server = createCalliopeHttpServer(
      "fixture",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      witness,
      undefined,
      pep,
    );
    return { server, witness, got };
  }

  async function dial(
    inner: Server,
    client: TlsIdentity | undefined,
    trust: string,
    body: string,
  ): Promise<string> {
    const door = makeIdentity("DNS:localhost");
    const tls = createHttpsServer(
      {
        cert: door.cert,
        key: door.key,
        ca: [trust],
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        for (const listener of inner.listeners("request")) listener(req, res);
      },
    );
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    try {
      const port = (tls.address() as AddressInfo).port;
      return await new Promise<string>((resolve, reject) => {
        const req = httpsRequest(
          {
            port,
            host: "127.0.0.1",
            method: "POST",
            path: "/mcp",
            headers: MCP_HEADERS,
            ca: [door.cert],
            servername: "localhost",
            agent: false,
            ...client,
          },
          (res) => {
            let text = "";
            res.on("data", (c: Buffer) => (text += c.toString()));
            res.on("end", () => {
              resolve(text);
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    } finally {
      await new Promise<void>((r) =>
        tls.close(() => {
          r();
        }),
      );
    }
  }

  const call = (verb: string, meta?: Record<string, unknown>): string =>
    envelope("tools/call", {
      name: verb,
      arguments: {},
      ...(meta ? { _meta: meta } : {}),
    });

  it("enforce: a star is served on its network identity; an unidentified caller is refused on the wire; tools/list is not decided", async () => {
    const { server, got } = served(arm("enforce"));
    open = server;
    const athena = makeIdentity(
      "URI:spiffe://notusmi.com/star/athena",
      "athena",
    );
    const themis = makeIdentity(
      "URI:spiffe://notusmi.com/star/themis",
      "themis",
    );
    const bundle = athena.cert + themis.cert;

    const served1 = await dial(server, themis, bundle, call("list_tags"));
    expect(served1).not.toContain("refused");

    const anon = await dial(server, undefined, bundle, call("list_tags"));
    expect(anon).toContain('\\"refused\\":\\"pep\\"');
    expect(anon).toContain("unidentified");

    const allowed = await dial(server, athena, bundle, call("list_tags"));
    expect(allowed).not.toContain("refused");

    const listed = await dial(
      server,
      undefined,
      bundle,
      envelope("tools/list", {}),
    );
    expect(listed).toContain("list_tags");

    expect(got.map((r) => [r.outcome, r.reason, r.decision])).toEqual([
      ["ok", "network_enforced", "allow"],
      ["denied", "unidentified", "deny"],
      ["ok", "network_enforced", "allow"],
    ]);
    expect(got[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/themis",
      path: "direct",
    });
  });

  it("witness: an unidentified caller is answered and recorded would_deny", async () => {
    const { server, got } = served(arm("witness"));
    open = server;
    const themis = makeIdentity(
      "URI:spiffe://notusmi.com/star/themis",
      "themis",
    );
    const text = await dial(server, undefined, themis.cert, call("list_tags"));
    expect(text).not.toContain("refused");
    expect(got).toMatchObject([
      { outcome: "ok", decision: "would_deny", reason: "unidentified" },
    ]);
  });

  it("probes are never gated: /healthz and /ready on an enforcing star are not the PEP's to answer", async () => {
    const pep = arm("enforce");
    const { server } = served(pep);
    open = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    for (const path of ["/healthz", "/ready"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404); // no such route; and never a pep refusal
      expect(await res.text()).not.toContain("pep");
    }
    expect(pep.counts()).toEqual({});
  });
});

describe("the production witness records a refusal as decision deny", () => {
  it("makeWitness's sink adds the decision the library's vocabulary lacks", () => {
    const seen: RequestRecord[] = [];
    const w = makeWitness({}, () => ({
      sink: (r) => {
        seen.push(r);
      },
      reach: "stdout",
      close: () => Promise.resolve(),
    }));
    const call = w.log.observe("neighbors", { path: "direct" });
    call.denied("unidentified");
    call.decided("deny", "unidentified"); // ignored by the library; the sink supplies it
    call.finish();
    expect(seen[0]).toMatchObject({
      outcome: "denied",
      reason: "unidentified",
      decision: "deny",
    });
    const ok = w.log.record("neighbors", { outcome: "ok" });
    expect(ok.decision).toBeUndefined();
  });
});
