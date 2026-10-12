import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLog, runWithPeer } from "@forge/stellar-core-ts";
import type { RequestRecord, ToolCallHandler } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import { pepHandler } from "../src/mcp/pep/intercept.js";
import {
  DEFAULT_SIDECAR_PATH,
  PepBootError,
  loadPep,
  pepConfigFromEnv,
} from "../src/mcp/pep/pep.js";
import type { Pep } from "../src/mcp/pep/pep.js";
import { makeWitness } from "../src/mcp/witness.js";
import type { Witness } from "../src/mcp/witness.js";
import {
  SESSION,
  peerFor,
  recordingLog,
  sidecarWith,
  tempFile,
} from "./helpers/pep.js";
import { makeIdentity } from "./helpers/tls-identity.js";
import type { TlsIdentity } from "./helpers/tls-identity.js";

/**
 * The PEP on the dispatcher, mirroring stellar-core-go `policy/middleware_test.go`
 * and `enforce_test.go`: every caller shape, what it was answered, the ONE record
 * it left, and the counter. `urania` is the Go suite's star; the sidecar is its
 * athena edge (approved) and themis edge (generated).
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
const arm = (mode: string, path: string): Pep =>
  loadPep({ star: "urania", mode, sidecarPath: path, log: quiet });

describe("TestWitnessRecordsAndRefusesNothing", () => {
  it("every caller shape is decided, recorded on the call's one record, counted, and answered by the verb", async () => {
    const d = door(arm("witness", sidecarWith("generated")));
    const cases = [
      [star("athena"), "neighbors", undefined, "allow", "edge_allows", "", ""],
      [
        star("athena"),
        "declare_litigant",
        undefined,
        "would_deny",
        "verb_not_on_edge",
        "",
        "",
      ],
      [
        star("chaos"),
        "neighbors",
        stamp(SESSION),
        "would_deny",
        "no_edge",
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
      "witness/allow/edge_allows": 1,
      "witness/would_consult/pdp_not_consulted": 1,
      "witness/would_deny/no_edge": 1,
      "witness/would_deny/unidentified": 1,
      "witness/would_deny/verb_not_on_edge": 1,
    });
  });

  it("outside a witnessed call the PEP still counts, and still refuses nothing", async () => {
    const d = door(arm("witness", sidecarWith("generated")), false);
    const res = await d.call(star("chaos"), "neighbors");
    expect(res.isError).toBeUndefined();
    expect(d.got).toHaveLength(0); // no sink, no record
    expect(d.pep.counts()).toEqual({ "witness/would_deny/no_edge": 1 });
  });
});

describe("TestEnforceRefusesBeforeTheHandler", () => {
  // Go's matrix minus the policy-plane rows (this port has no plane: the gateway
  // and session paths are refused pdp_not_consulted, which Go's TestEnforceFailsClosed
  // "no PDP" row pins).
  const other =
    "spiffe://notusmi.com/session/00000000-0000-0000-0000-000000000000";
  const cases = [
    { caller: star("athena"), verb: "neighbors", reason: "" },
    {
      caller: star("athena"),
      verb: "declare_litigant",
      reason: "verb_not_on_edge",
    },
    { caller: star("themis"), verb: "neighbors", reason: "edge_not_approved" },
    {
      caller: star("chaos"),
      verb: "neighbors",
      meta: stamp(SESSION),
      reason: "no_edge",
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
    { caller: star("hades"), verb: "neighbors", reason: "no_edge" },
    {
      caller: SESSION,
      verb: "neighbors",
      reason: "pdp_not_consulted",
      principal: SESSION,
    },
  ] as const;

  it("refuses what is not allowed, never reaching the verb, with one record each", async () => {
    const d = door(arm("enforce", sidecarWith("generated")));
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
    expect(d.ran()).toBe(1); // only the allowed call
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
      "enforce/allow/edge_allows": 1,
      "enforce/deny/edge_not_approved": 1,
      "enforce/deny/no_edge": 2,
      "enforce/deny/pdp_not_consulted": 4,
      "enforce/deny/unidentified": 1,
      "enforce/deny/verb_not_on_edge": 1,
    });
  });

  it("outside a witnessed call an enforcing PEP still refuses and still counts", async () => {
    const d = door(arm("enforce", sidecarWith("approved")), false);
    const res = await d.call(star("chaos"), "neighbors");
    expect(res.isError).toBe(true);
    expect(d.got).toHaveLength(0);
    expect(d.pep.counts()).toEqual({ "enforce/deny/no_edge": 1 });
  });

  it("a refusal is the Go body: a tool error naming the caller and where it is mended", async () => {
    const d = door(arm("enforce", sidecarWith("approved")));
    const res = await d.call(star("chaos"), "neighbors");
    expect(res.structuredContent).toEqual({
      refused: "pep",
      star: "urania",
      verb: "neighbors",
      caller: star("chaos"),
      reason: "no_edge",
      fix: "foundry-dies/orbits/urania-chaos.toml",
    });
  });
});

describe("TestEnforceFailsClosed (the no-PDP row)", () => {
  it("no policy plane refuses the gateway path pdp_not_consulted, with the star up", async () => {
    const d = door(arm("enforce", sidecarWith("approved")));
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

describe("the mode machine at boot (TestNewModes, TestAnUnknownModeRunsWitnessLoudly, TestConfigFromEnv)", () => {
  const sidecar = sidecarWith("approved");

  it("witness is the default and arms with the sidecar's consumer count", () => {
    const lines: string[] = [];
    const pep = loadPep({
      star: "urania",
      sidecarPath: sidecar,
      log: (l) => lines.push(l),
    });
    expect(pep.mode).toBe("witness");
    expect(pep.consumers).toBe(2);
    expect(lines.join("\n")).toContain("witnessing inbound calls");
    expect(lines.join("\n")).not.toContain("ENFORCING");
  });

  it("enforce arms and says so", () => {
    const lines: string[] = [];
    const pep = loadPep({
      star: "urania",
      mode: "enforce",
      sidecarPath: sidecar,
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
        sidecarPath: sidecar,
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
      loadPep({
        star: "urania",
        mode,
        sidecarPath: sidecar,
        log: (l) => lines.push(l),
      });
      expect(lines.join("\n")).not.toContain("is not a PEP mode");
    }
  });

  it("reads mode and sidecar from STELLAR_PEP_MODE and STELLAR_ORBIT_SIDECAR", () => {
    expect(
      pepConfigFromEnv("calliope", {
        STELLAR_PEP_MODE: "enforce",
        STELLAR_ORBIT_SIDECAR: "/x/orbit.toml",
      }),
    ).toEqual({
      star: "calliope",
      mode: "enforce",
      sidecarPath: "/x/orbit.toml",
    });
    expect(pepConfigFromEnv("calliope", {})).toEqual({
      star: "calliope",
      mode: undefined,
      sidecarPath: undefined,
    });
  });
});

describe("BOOT on a missing or broken sidecar", () => {
  // Go: TestWitnessBootsWithoutASidecar (boots, records would_deny{no_acl}) —
  // matched here; TestWitnessRefusesABrokenSidecar (refuses) — matched;
  // TestEnforceSidecarFaults and TestEnforceRefusesEveryCallOnABrokenSidecar
  // (boot, refuse every call) — here an enforcing star refuses the boot.
  const missing = (): string => `${tempFile("x", "")}.absent`;
  const broken = (): string => tempFile("orbit.toml", "[[produces]\n");

  it("witness: a missing sidecar boots, star callers would_deny{no_acl}", () => {
    const lines: string[] = [];
    const pep = loadPep({
      star: "calliope",
      mode: "witness",
      sidecarPath: missing(),
      log: (l) => lines.push(l),
    });
    expect(pep.mode).toBe("witness");
    expect(pep.consumers).toBe(0);
    expect(lines.join("\n")).toMatch(
      /no orbit sidecar .*STELLAR_ORBIT_SIDECAR/,
    );
    const d = pep.adjudicate({
      peer: peerFor(star("athena")),
      verb: "read_container",
    });
    expect([d.verdict, d.reason]).toEqual(["deny", "no_acl"]);
    expect(pep.refuses(d)).toBe(false);
  });

  it.each(["enforce"])(
    "%s: a missing sidecar refuses to start, naming the path and the env",
    (mode) => {
      const path = missing();
      expect(() =>
        loadPep({ star: "calliope", mode, sidecarPath: path, log: quiet }),
      ).toThrow(PepBootError);
      expect(() =>
        loadPep({ star: "calliope", mode, sidecarPath: path, log: quiet }),
      ).toThrow(
        new RegExp(
          `${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*STELLAR_ORBIT_SIDECAR.*missing or unparseable`,
        ),
      );
    },
  );

  it.each(["witness", "enforce"])(
    "%s: an unparseable sidecar refuses to start with the parser's reason",
    (mode) => {
      expect(() =>
        loadPep({ star: "calliope", mode, sidecarPath: broken(), log: quiet }),
      ).toThrow(/calliope: orbit sidecar does not parse: /);
    },
  );

  it("an unset path reads the mount point", () => {
    // The sandbox has no /etc/stellar/orbit.toml; the point is where it looked.
    expect(() =>
      loadPep({ star: "calliope", mode: "enforce", log: quiet }),
    ).toThrow(new RegExp(DEFAULT_SIDECAR_PATH));
  });
});

describe("the process refuses to start (main(), as the pod runs it)", () => {
  const bun = spawnSync("bun", ["--version"]);
  it.skipIf(bun.status !== 0)(
    "exits non-zero before it binds when the sidecar is broken (witness) or missing (enforce)",
    () => {
      const entry = new URL("../src/mcp/http.ts", import.meta.url).pathname;
      for (const [mode, sidecar] of [
        ["enforce", `${tempFile("x", "")}.absent`],
        ["witness", tempFile("orbit.toml", "[[produces]\n")],
      ] as const) {
        const run = spawnSync("bun", [entry], {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            STELLAR_PEP_MODE: mode,
            STELLAR_ORBIT_SIDECAR: sidecar,
            PORT: "0",
          },
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("pep: refusing to start");
        expect(run.stderr).not.toContain("serving");
      }
    },
    60_000,
  );
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

  it("enforce: an edge-less star is refused on the wire and leaves one denied record; an unidentified caller too; tools/list is not decided", async () => {
    const pep = arm(
      "enforce",
      tempFile(
        "orbit.toml",
        '[[produces]]\nto = "athena"\ncontract = "calliope-athena"\nstatus = "approved"\nverbs = ["list_tags"]\n',
      ),
    );
    const { server, got } = served(pep);
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

    const refused = await dial(server, themis, bundle, call("list_tags"));
    expect(refused).toContain('\\"refused\\":\\"pep\\"');
    expect(refused).toContain("no_edge");

    const anon = await dial(server, undefined, bundle, call("list_tags"));
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
      ["denied", "no_edge", "deny"],
      ["denied", "unidentified", "deny"],
      ["ok", "edge_allows", "allow"],
    ]);
    expect(got[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/themis",
      path: "direct",
    });
  });

  it("witness: the same edge-less caller is answered and recorded would_deny", async () => {
    const pep = arm(
      "witness",
      tempFile(
        "orbit.toml",
        '[[produces]]\nto = "athena"\ncontract = "calliope-athena"\nstatus = "approved"\nverbs = ["list_tags"]\n',
      ),
    );
    const { server, got } = served(pep);
    open = server;
    const themis = makeIdentity(
      "URI:spiffe://notusmi.com/star/themis",
      "themis",
    );
    const text = await dial(server, themis, themis.cert, call("list_tags"));
    expect(text).not.toContain("refused");
    expect(got).toMatchObject([
      { outcome: "ok", decision: "would_deny", reason: "no_edge" },
    ]);
  });

  it("probes are never gated: /healthz and /ready on an enforcing star are not the PEP's to answer", async () => {
    const pep = arm("enforce", tempFile("orbit.toml", ""));
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
    call.denied("no_edge");
    call.decided("deny", "no_edge"); // ignored by the library; the sink supplies it
    call.finish();
    expect(seen[0]).toMatchObject({
      outcome: "denied",
      reason: "no_edge",
      decision: "deny",
    });
    const ok = w.log.record("neighbors", { outcome: "ok" });
    expect(ok.decision).toBeUndefined();
  });
});
