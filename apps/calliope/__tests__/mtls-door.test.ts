import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestLog, peerFrom } from "@forge/stellar-core-ts";
import type { Peer, RequestRecord } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import {
  LoopbackPeers,
  bootMtlsDoor,
  openDoorSource,
  presentedCertificate,
  startMtlsDoor,
  tlsOptions,
  withDoorPeers,
} from "../src/mcp/mtls-door.js";
import type {
  DoorCredential,
  DoorSource,
  MtlsDoor,
} from "../src/mcp/mtls-door.js";
import { VERB_PREFIX } from "../src/mcp/witness.js";
import type { Witness } from "../src/mcp/witness.js";
import { makeIdentity } from "./helpers/tls-identity.js";
import type { TlsIdentity } from "./helpers/tls-identity.js";

/**
 * The mTLS door, end to end over real sockets: a real TLS handshake into the
 * door, a real loopback hop into the real plaintext server, the real streamable
 * transport, and the witness's record at the far end. The trust bundle is the
 * set of self-signed identities the test mints, each its own anchor.
 */

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_tags", arguments: {} },
});

function recording(): { witness: Witness; got: RequestRecord[] } {
  const got: RequestRecord[] = [];
  return {
    witness: {
      log: new RequestLog("calliope", {
        verbPrefix: VERB_PREFIX,
        sink: (r) => {
          got.push(r);
        },
      }),
      close: () => Promise.resolve(),
    },
    got,
  };
}

const DOOR_SAN = "DNS:localhost, URI:spiffe://notusmi.com/star/calliope";

function fakeSource(
  door: TlsIdentity,
  bundle: string,
): {
  source: DoorSource;
  rotate: (next: TlsIdentity) => void;
  closed: () => number;
} {
  let cred: DoorCredential = {
    certPem: door.cert,
    keyPem: door.key,
    bundlePem: bundle,
  };
  let listener: ((c: DoorCredential) => void) | undefined;
  let closed = 0;
  return {
    source: {
      current: () => cred,
      onRotate: (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      close: () => {
        closed += 1;
      },
    },
    rotate: (next) => {
      cred = { certPem: next.cert, keyPem: next.key, bundlePem: bundle };
      listener?.(cred);
    },
    closed: () => closed,
  };
}

interface Rig {
  door: MtlsDoor;
  peers: LoopbackPeers;
  got: RequestRecord[];
  fake: ReturnType<typeof fakeSource>;
  doorIdentity: TlsIdentity;
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function rig(bundle: string): Promise<Rig> {
  const { witness, got } = recording();
  const peers = new LoopbackPeers();
  const plain: Server = createCalliopeHttpServer(
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
    peers,
  );
  await new Promise<void>((resolve) => {
    plain.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        plain.close(() => {
          resolve();
        });
        plain.closeAllConnections();
      }),
  );
  const doorIdentity = makeIdentity(DOOR_SAN, "calliope-door");
  const fake = fakeSource(doorIdentity, bundle);
  const door = await startMtlsDoor({
    source: fake.source,
    peers,
    upstreamPort: (plain.address() as AddressInfo).port,
    port: 0,
    host: "127.0.0.1",
  });
  cleanup.push(() => door.close());
  return { door, peers, got, fake, doorIdentity };
}

/** One POST through the door; resolves the served certificate's SAN. */
function dial(
  r: Rig,
  client: TlsIdentity | undefined,
): Promise<{ status: number; serverSan: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        port: r.door.port,
        host: "127.0.0.1",
        method: "POST",
        path: "/mcp",
        headers: MCP_HEADERS,
        rejectUnauthorized: false,
        servername: "localhost",
        agent: false,
        ...client,
      },
      (res) => {
        const serverSan =
          (
            res.socket as unknown as {
              getPeerCertificate(): { subjectaltname?: string };
            }
          ).getPeerCertificate().subjectaltname ?? "";
        res.resume();
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, serverSan });
        });
      },
    );
    req.on("error", reject);
    req.end(CALL);
  });
}

describe("the door's client-certificate semantics (verify if given)", () => {
  const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
  const hades = makeIdentity("URI:spiffe://notusmi.com/star/hades");
  const bundle = themis.cert + hades.cert;

  it("no certificate is served, unidentified, path unknown", async () => {
    const r = await rig(bundle);
    const { status } = await dial(r, undefined);
    expect(status).toBe(200);
    expect(r.got).toHaveLength(1);
    expect(r.got[0]).toMatchObject({
      verb: "list_tags",
      caller_class: "unidentified",
      path: "unknown",
    });
    expect(r.got[0]?.caller_identity).toBeUndefined();
    expect(r.door.refused()).toBe(0);
  });

  it("a verified star is the caller, path direct", async () => {
    const r = await rig(bundle);
    await dial(r, themis);
    expect(r.got[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/themis",
      path: "direct",
    });
  });

  it("a verified hades is the gateway, path gateway", async () => {
    const r = await rig(bundle);
    await dial(r, hades);
    expect(r.got[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/hades",
      path: "gateway",
    });
  });

  it("a certificate from a foreign CA is refused and leaves no record", async () => {
    const r = await rig(bundle);
    const stranger = makeIdentity("URI:spiffe://notusmi.com/star/hades");
    await expect(dial(r, stranger)).rejects.toThrow();
    expect(r.door.refused()).toBe(1);
    expect(r.got).toHaveLength(0);
  });

  it("the verified-peer table empties when the connection ends", async () => {
    const r = await rig(bundle);
    await dial(r, themis);
    await vi.waitFor(() => {
      expect(r.peers.size).toBe(0);
    });
  });

  it("a later anonymous call does not inherit an earlier caller's identity", async () => {
    const r = await rig(bundle);
    await dial(r, themis);
    await dial(r, undefined);
    expect(r.got.map((x) => x.caller_class)).toEqual(["star", "unidentified"]);
  });
});

describe("rotation", () => {
  it("a renewed SVID is presented to new handshakes without a restart", async () => {
    const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
    const r = await rig(themis.cert);
    const before = await dial(r, themis);
    expect(before.serverSan).toContain("star/calliope");
    r.fake.rotate(
      makeIdentity(
        "DNS:localhost, URI:spiffe://notusmi.com/star/calliope-renewed",
        "calliope-renewed",
      ),
    );
    await vi.waitFor(async () => {
      expect((await dial(r, themis)).serverSan).toContain("calliope-renewed");
    });
    const after = await dial(r, themis);
    expect(after.status).toBe(200);
  });

  it("a rotation that cannot bind warns once and the old server keeps serving", async () => {
    const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
    const r = await rig(themis.cert);
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      r.fake.rotate({ cert: "not a certificate", key: "not a key" });
      await vi.waitFor(() => {
        expect(
          spy.mock.calls.filter((c) =>
            String(c[0]).includes("could not apply the rotated SVID"),
          ),
        ).toHaveLength(1);
      });
    } finally {
      spy.mockRestore();
    }
    expect((await dial(r, themis)).status).toBe(200);
  });
});

describe("fail-soft boot", () => {
  const boot = {
    peers: new LoopbackPeers(),
    upstreamPort: 1,
    port: 0,
    host: "127.0.0.1",
  };

  it("with no SVID the door is absent, one WARN, and nothing throws", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const door = await bootMtlsDoor({
        ...boot,
        open: () => Promise.reject(new Error("no workload api")),
      });
      expect(door).toBeUndefined();
      const warns = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("WARN mtls door unavailable"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("serving plaintext only");
      expect(warns[0]).toContain("no workload api");
    } finally {
      spy.mockRestore();
    }
  });

  it("a source whose credential cannot be read is closed and the door is absent", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let closed = 0;
    try {
      const door = await bootMtlsDoor({
        ...boot,
        open: () =>
          Promise.resolve({
            current: () => {
              throw new Error("expired");
            },
            onRotate: () => () => undefined,
            close: () => {
              closed += 1;
            },
          }),
      });
      expect(door).toBeUndefined();
      expect(closed).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("with an SVID the door comes up, and closing it closes the source", async () => {
    const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
    const fake = fakeSource(
      makeIdentity(DOOR_SAN, "calliope-door"),
      themis.cert,
    );
    const door = await bootMtlsDoor({
      ...boot,
      open: () => Promise.resolve(fake.source),
    });
    expect(door).toBeDefined();
    expect(door?.port).toBeGreaterThan(0);
    await door?.close();
    expect(fake.closed()).toBe(1);
  });

  it("a source that arrives after the deadline is closed, not left streaming", async () => {
    let late: ((s: DoorSource) => void) | undefined;
    const pending = new Promise<DoorSource>((resolve) => {
      late = resolve;
    });
    await expect(openDoorSource(5, () => pending)).rejects.toThrow(
      "no SVID within 5ms",
    );
    let closed = 0;
    late?.({
      current: () => ({ certPem: "", keyPem: "", bundlePem: "" }),
      onRotate: () => () => undefined,
      close: () => {
        closed += 1;
      },
    });
    await vi.waitFor(() => {
      expect(closed).toBe(1);
    });
  });

  it("a source that arrives in time is returned untouched", async () => {
    let closed = 0;
    const src: DoorSource = {
      current: () => ({ certPem: "", keyPem: "", bundlePem: "" }),
      onRotate: () => () => undefined,
      close: () => {
        closed += 1;
      },
    };
    await expect(
      openDoorSource(1000, () => Promise.resolve(src)),
    ).resolves.toBe(src);
    expect(closed).toBe(0);
  });
});

describe("the loopback table", () => {
  const themis: Peer = {
    spiffeId: "spiffe://notusmi.com/star/themis",
    kind: "star",
    name: "themis",
  };

  it("answers only a loopback connection on a registered port", () => {
    const peers = new LoopbackPeers();
    peers.set(40000, themis);
    expect(
      peers.forSocket({ remoteAddress: "127.0.0.1", remotePort: 40000 }),
    ).toBe(themis);
    expect(
      peers.forSocket({ remoteAddress: "::ffff:127.0.0.1", remotePort: 40000 }),
    ).toBe(themis);
    expect(peers.forSocket({ remoteAddress: "::1", remotePort: 40000 })).toBe(
      themis,
    );
    expect(
      peers.forSocket({ remoteAddress: "10.0.0.7", remotePort: 40000 }),
    ).toBeUndefined();
    expect(
      peers.forSocket({ remoteAddress: "127.0.0.1", remotePort: 40001 }),
    ).toBeUndefined();
    expect(peers.forSocket({ remoteAddress: "127.0.0.1" })).toBeUndefined();
    expect(peers.forSocket({ remotePort: 40000 })).toBeUndefined();
    peers.delete(40000);
    expect(peers.size).toBe(0);
  });

  it("withDoorPeers stamps the registered peer, and nothing for an unregistered or foreign one", () => {
    const peers = new LoopbackPeers();
    peers.set(40000, themis);
    const seen: (Peer | undefined)[] = [];
    const listener = withDoorPeers(() => {
      seen.push(peerFrom());
    }, peers);
    const at = (remoteAddress: string, remotePort: number): never =>
      ({ socket: { remoteAddress, remotePort } }) as never;
    listener(at("127.0.0.1", 40000), {} as never);
    listener(at("127.0.0.1", 40001), {} as never);
    listener(at("10.0.0.7", 40000), {} as never);
    expect(seen).toEqual([themis, undefined, undefined]);
  });
});

describe("the TLS options", () => {
  it("ask for a client certificate and never insist on one", () => {
    expect(tlsOptions({ certPem: "c", keyPem: "k", bundlePem: "b" })).toEqual({
      cert: "c",
      key: "k",
      ca: "b",
      requestCert: true,
      rejectUnauthorized: false,
    });
  });

  it("presentedCertificate reads the raw bytes, and an empty answer is none", () => {
    const sock = (raw: Buffer | undefined): never =>
      ({ getPeerCertificate: () => ({ raw }) }) as never;
    expect(presentedCertificate(sock(Buffer.from([1])))).toBe(true);
    expect(presentedCertificate(sock(Buffer.alloc(0)))).toBe(false);
    expect(presentedCertificate(sock(undefined))).toBe(false);
  });
});
