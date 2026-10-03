import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestLog, peerFrom } from "@forge/stellar-core-ts";
import type { Peer, RequestRecord } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import { EventEmitter } from "node:events";
import { X509Certificate } from "node:crypto";
import type { connect as netConnect } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  LoopbackPeers,
  accept,
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
  listening: () => boolean;
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
    listening: () => listener !== undefined,
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
    // The replaced server stopped accepting: with it still listening beside the
    // new one, the kernel would hand some of these to the old certificate.
    for (let i = 0; i < 12; i += 1) {
      expect((await dial(r, themis)).serverSan).toContain("calliope-renewed");
    }
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

describe("the door's lifetime", () => {
  const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");

  it("closing it stops listening, stops following rotations, and closes the source", async () => {
    const r = await rig(themis.cert);
    expect(r.fake.listening()).toBe(true);
    await dial(r, themis);
    await r.door.close();
    expect(r.fake.listening()).toBe(false);
    expect(r.fake.closed()).toBe(1);
    await expect(dial(r, themis)).rejects.toThrow();
  });

  it("a host it cannot bind rejects the start", async () => {
    const fake = fakeSource(makeIdentity(DOOR_SAN, "d"), themis.cert);
    await expect(
      startMtlsDoor({
        source: fake.source,
        peers: new LoopbackPeers(),
        upstreamPort: 1,
        port: 0,
        host: "not a host name!",
      }),
    ).rejects.toThrow();
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
    expect(
      presentedCertificate({ getPeerCertificate: () => null } as never),
    ).toBe(false);
  });
});

describe("openDoorSource", () => {
  const source = (onClose: () => void = () => undefined): DoorSource => ({
    current: () => ({ certPem: "", keyPem: "", bundlePem: "" }),
    onRotate: () => () => undefined,
    close: onClose,
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
    late?.(
      source(() => {
        closed += 1;
      }),
    );
    await vi.waitFor(() => {
      expect(closed).toBe(1);
    });
  });

  it("a source that arrives in time is returned untouched", async () => {
    let closed = 0;
    const src = source(() => {
      closed += 1;
    });
    await expect(
      openDoorSource(1000, () => Promise.resolve(src)),
    ).resolves.toBe(src);
    expect(closed).toBe(0);
  });

  it("a creation that fails fails the open with its own error", async () => {
    await expect(
      openDoorSource(1000, () => Promise.reject(new Error("no socket"))),
    ).rejects.toThrow("no socket");
  });
});

/** A socket stand-in: records what the door does to it, says what it is told. */
class FakeSock extends EventEmitter {
  destroyed = 0;
  ended = 0;
  written: Buffer[] = [];
  localPort: number | undefined = undefined;
  readableEnded = false;
  encrypted = true;
  authorized = true;
  constructor(private readonly der: Buffer | undefined) {
    super();
  }
  getPeerCertificate(): { raw?: Buffer } {
    return this.der === undefined ? {} : { raw: this.der };
  }
  destroy(): void {
    this.destroyed += 1;
  }
  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.ended += 1;
  }
}

describe("accept — one connection, scripted", () => {
  const themisId = makeIdentity("URI:spiffe://notusmi.com/star/themis");
  const der = new X509Certificate(themisId.cert).raw;

  function accepted(
    o: {
      der?: Buffer;
      authorized?: boolean;
      localPort?: number;
      readableEnded?: boolean;
    } = {},
  ): {
    sock: FakeSock;
    up: FakeSock;
    peers: LoopbackPeers;
    dialed: unknown[];
    refused: () => number;
  } {
    const peers = new LoopbackPeers();
    const sock = new FakeSock(o.der);
    sock.authorized = o.authorized ?? true;
    sock.readableEnded = o.readableEnded ?? false;
    const up = new FakeSock(undefined);
    up.localPort = o.localPort;
    const dialed: unknown[] = [];
    let refused = 0;
    const connect = ((target: unknown) => {
      dialed.push(target);
      return up;
    }) as unknown as typeof netConnect;
    accept(
      sock as unknown as TLSSocket,
      { peers, upstreamPort: 4321 },
      () => {
        refused += 1;
      },
      connect,
    );
    return { sock, up, peers, dialed, refused: () => refused };
  }

  it("dials the plaintext server on loopback", () => {
    expect(accepted().dialed).toEqual([{ host: "127.0.0.1", port: 4321 }]);
  });

  it("refuses a presented certificate that did not verify, before reading a byte", () => {
    const a = accepted({ der, authorized: false });
    expect(a.refused()).toBe(1);
    expect(a.sock.destroyed).toBe(1);
    expect(a.dialed).toEqual([]);
    expect(a.sock.listenerCount("data")).toBe(0);
  });

  it("serves a verified certificate, and a caller with none, whatever authorized says", () => {
    for (const o of [
      { der, authorized: true },
      { authorized: false },
      { authorized: true },
    ]) {
      const a = accepted(o);
      expect(a.refused()).toBe(0);
      expect(a.sock.destroyed).toBe(0);
      expect(a.dialed).toHaveLength(1);
    }
  });

  it("a socket error destroys the socket", () => {
    const a = accepted();
    a.sock.emit("error", new Error("reset"));
    expect(a.sock.destroyed).toBe(1);
  });

  it("holds bytes read before the upstream is up, flushes them in order once, then forwards directly", () => {
    const a = accepted();
    a.sock.emit("data", Buffer.from("a"));
    a.sock.emit("data", Buffer.from("b"));
    expect(a.up.written).toEqual([]);
    a.up.emit("connect");
    expect(a.up.written.map(String)).toEqual(["a", "b"]);
    a.sock.emit("data", Buffer.from("c"));
    expect(a.up.written.map(String)).toEqual(["a", "b", "c"]);
  });

  it("passes the client's end on only once connected, and a finished client at connect", () => {
    const early = accepted();
    early.sock.emit("end");
    expect(early.up.ended).toBe(0);
    early.up.emit("connect");
    expect(early.up.ended).toBe(0);

    const finished = accepted({ readableEnded: true });
    finished.up.emit("connect");
    expect(finished.up.ended).toBe(1);

    const late = accepted();
    late.up.emit("connect");
    late.sock.emit("end");
    expect(late.up.ended).toBe(1);
  });

  it("relays the upstream's bytes and end to the client", () => {
    const a = accepted();
    a.up.emit("data", Buffer.from("reply"));
    expect(a.sock.written.map(String)).toEqual(["reply"]);
    expect(a.sock.ended).toBe(0);
    a.up.emit("end");
    expect(a.sock.ended).toBe(1);
  });

  it("registers the verified peer against the upstream's local port, once connected", () => {
    const a = accepted({ der, localPort: 5555 });
    expect(a.peers.size).toBe(0);
    a.up.emit("connect");
    expect(
      a.peers.forSocket({ remoteAddress: "127.0.0.1", remotePort: 5555 })
        ?.spiffeId,
    ).toBe("spiffe://notusmi.com/star/themis");
  });

  it("registers nobody for an anonymous caller, or when the port is unknown", () => {
    const anon = accepted({ localPort: 5555 });
    anon.up.emit("connect");
    expect(anon.peers.size).toBe(0);
    const noPort = accepted({ der });
    noPort.up.emit("connect");
    expect(noPort.peers.size).toBe(0);
  });

  it("any end of the pair clears the registration and destroys both sockets", () => {
    for (const ending of ["up-close", "up-error", "sock-close"]) {
      const a = accepted({ der, localPort: 5555 });
      a.up.emit("connect");
      expect(a.peers.size).toBe(1);
      if (ending === "up-close") a.up.emit("close");
      if (ending === "up-error") a.up.emit("error", new Error("refused"));
      if (ending === "sock-close") a.sock.emit("close");
      expect(a.peers.size).toBe(0);
      expect(a.sock.destroyed).toBe(1);
      expect(a.up.destroyed).toBe(1);
    }
  });

  it("a second end does not clear a registration a later connection made on the same port", () => {
    const a = accepted({ der, localPort: 5555 });
    a.up.emit("connect");
    a.up.emit("close");
    a.peers.set(5555, {
      spiffeId: "spiffe://notusmi.com/star/hades",
      kind: "star",
      name: "hades",
    });
    a.sock.emit("close");
    expect(a.peers.size).toBe(1);
  });
});
