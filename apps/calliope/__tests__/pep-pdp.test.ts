import { describe, expect, it } from "vitest";
import { runWithPeer } from "@forge/stellar-core-ts";
import type { ToolCallHandler } from "@forge/stellar-core-ts";
import { pepHandler } from "../src/mcp/pep/intercept.js";
import { loadPep } from "../src/mcp/pep/pep.js";
import { Ouranos } from "../src/mcp/pep/pdp.js";
import type { Pdp, PdpAnswer } from "../src/mcp/pep/pdp.js";
import { SESSION, peerFor, recordingLog, sidecarWith } from "./helpers/pep.js";

/** The PDP wired into the PEP, mirroring stellar-core-go `policy/consult_test.go`
 *  and the PDP rows of `enforce_test.go`: a consult verdict is put to the plane
 *  and its ANSWER is what the record and the counter carry. */

const ENDPOINT = "http://ouranos-opa:8181/v1/data/authz/endpoint_decision";
const GATEWAY = "spiffe://notusmi.com/star/hades";
const stamp = {
  "hades/principal": SESSION,
  "hades/principal-type": "session",
};
const quiet = (): void => undefined;

type Labels = [string, string, string];

function rig(
  mode: string,
  pdp: Pdp | undefined,
): {
  call: (
    meta?: Record<string, unknown>,
    args?: unknown,
  ) => Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
  ran: () => number;
  labels: Labels[];
  records: ReturnType<typeof recordingLog>["got"];
} {
  const { log, got } = recordingLog("urania");
  const labels: Labels[] = [];
  const pep = loadPep({
    star: "urania",
    mode,
    sidecarPath: sidecarWith("approved"),
    log: quiet,
    pdp,
    onDecision: (m, d, r) => labels.push([m, d, r]),
  });
  let ran = 0;
  const verb: ToolCallHandler = () => {
    ran += 1;
    return { content: [{ type: "text", text: "{}" }] };
  };
  const handler = pepHandler(log, pep, verb);
  return {
    labels,
    records: got,
    ran: () => ran,
    call: async (meta, args = {}) =>
      (await runWithPeer(peerFor(GATEWAY), () =>
        handler(
          {
            params: {
              name: "neighbors",
              arguments: args,
              ...(meta === undefined ? {} : { _meta: meta }),
            },
          } as never,
          {},
        ),
      )) as never,
  };
}

const answering = (allow: boolean): { pdp: Pdp; asked: unknown[] } => {
  const asked: unknown[] = [];
  const fetch = ((_u: string, init?: RequestInit) => {
    asked.push(JSON.parse(init?.body as string));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          result: { allow, reasons: allow ? [] : ["no grant"] },
        }),
      ),
    );
  }) as typeof globalThis.fetch;
  return { pdp: new Ouranos({ url: ENDPOINT, fetch, log: quiet }), asked };
};

const faulting: Pdp = {
  decide: (): Promise<PdpAnswer> =>
    Promise.resolve({
      verdict: {
        allow: true,
        reason: "policy unavailable — permitted (fail-open)",
      },
      error: new Error("authz consult: boom"),
    }),
};

describe("witness with a PDP: the answer is recorded, the call always runs", () => {
  it("allow -> allow{pdp_allows}", async () => {
    const { pdp, asked } = answering(true);
    const r = rig("witness", pdp);
    expect((await r.call(stamp)).isError).toBeUndefined();
    expect(r.ran()).toBe(1);
    expect(r.labels).toEqual([["witness", "allow", "pdp_allows"]]);
    expect(r.records[0]).toMatchObject({
      decision: "allow",
      reason: "pdp_allows",
      principal: SESSION,
      principal_type: "session",
    });
    expect(asked).toEqual([
      {
        input: {
          principal: { type: "session", subject: SESSION },
          verb: "neighbors",
          star: "urania",
        },
      },
    ]);
  });

  it("deny -> would_deny{pdp_denies}, and the call still runs", async () => {
    const r = rig("witness", answering(false).pdp);
    expect((await r.call(stamp)).isError).toBeUndefined();
    expect(r.ran()).toBe(1);
    expect(r.labels).toEqual([["witness", "would_deny", "pdp_denies"]]);
  });

  it("a plane that did not answer -> allow{pdp_error} (fail-open), call runs", async () => {
    const r = rig("witness", faulting);
    expect((await r.call(stamp)).isError).toBeUndefined();
    expect(r.ran()).toBe(1);
    expect(r.labels).toEqual([["witness", "allow", "pdp_error"]]);
  });

  it("the action discriminator rides, the payload does not", async () => {
    const { pdp, asked } = answering(true);
    const r = rig("witness", pdp);
    await r.call(stamp, { action: "delete", body: "secret" });
    expect(JSON.stringify(asked)).toContain('"args":{"action":"delete"}');
    expect(JSON.stringify(asked)).not.toContain("secret");
  });

  it("an agent stamp (type only, no subject) is not asked: pdp_not_consulted", async () => {
    const { pdp, asked } = answering(true);
    const r = rig("witness", pdp);
    await r.call({ "hades/principal-type": "agent" });
    expect(asked).toHaveLength(0);
    expect(r.labels).toEqual([
      ["witness", "would_consult", "pdp_not_consulted"],
    ]);
  });

  it("no PDP wired: unchanged, would_consult{pdp_not_consulted}", async () => {
    const r = rig("witness", undefined);
    await r.call(stamp);
    expect(r.labels).toEqual([
      ["witness", "would_consult", "pdp_not_consulted"],
    ]);
  });
});

describe("enforce with a PDP", () => {
  it("allow -> the call runs, allow{pdp_allows}", async () => {
    const r = rig("enforce", answering(true).pdp);
    expect((await r.call(stamp)).isError).toBeUndefined();
    expect(r.ran()).toBe(1);
    expect(r.labels).toEqual([["enforce", "allow", "pdp_allows"]]);
  });

  it("deny -> refused before the handler, deny{pdp_denies}", async () => {
    const r = rig("enforce", answering(false).pdp);
    const res = await r.call(stamp);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      refused: "pep",
      reason: "pdp_denies",
      principal: SESSION,
      fix: "foundry-dies/policy/authz_grants/data.json",
    });
    expect(r.ran()).toBe(0);
    expect(r.labels).toEqual([["enforce", "deny", "pdp_denies"]]);
    expect(r.records[0]).toMatchObject({ outcome: "denied", decision: "deny" });
  });

  it("pdp_error is refused whatever the client's fail-open posture said", async () => {
    const r = rig("enforce", faulting);
    const res = await r.call(stamp);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ reason: "pdp_error" });
    expect(r.ran()).toBe(0);
    expect(r.labels).toEqual([["enforce", "deny", "pdp_error"]]);
  });

  it("a real timeout is a pdp_error refusal", async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new DOMException("timed out", "TimeoutError"));
        });
      })) as unknown as typeof globalThis.fetch;
    const r = rig(
      "enforce",
      new Ouranos({ url: ENDPOINT, fetch: hang, timeoutMs: 20, log: quiet }),
    );
    expect((await r.call(stamp)).isError).toBe(true);
    expect(r.labels).toEqual([["enforce", "deny", "pdp_error"]]);
  });

  it("no PDP wired: refused pdp_not_consulted (unchanged)", async () => {
    const r = rig("enforce", undefined);
    expect((await r.call(stamp)).isError).toBe(true);
    expect(r.labels).toEqual([["enforce", "deny", "pdp_not_consulted"]]);
  });

  it("a service caller never meets the plane", async () => {
    const { pdp, asked } = answering(false);
    const { log } = recordingLog("urania");
    const pep = loadPep({
      star: "urania",
      mode: "enforce",
      sidecarPath: sidecarWith("approved"),
      log: quiet,
      pdp,
    });
    const res = (await runWithPeer(
      peerFor("spiffe://notusmi.com/star/athena"),
      () =>
        pepHandler(log, pep, () => ({ content: [] }))(
          { params: { name: "neighbors", arguments: {} } } as never,
          {},
        ),
    )) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(asked).toHaveLength(0);
  });
});
