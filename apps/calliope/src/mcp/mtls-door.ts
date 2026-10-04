/**
 * The mTLS door — calliope's second listener, on plaintext port + 1, presenting
 * the star's SPIFFE SVID. The TS peer of the Go stars' `mtls.Listener` with
 * `tls.VerifyClientCertIfGiven`.
 *
 * Semantics, mirrored from stellar-core-go (`mtls`, `witness.PeerContext`):
 *
 *  - A client certificate is ASKED FOR and verified against the SPIFFE trust
 *    bundle when presented. None presented is served, as an unidentified
 *    caller — the door requires nothing. A certificate presented but not
 *    verifiable (foreign CA, expired) is REFUSED: the connection is dropped
 *    before a byte of HTTP is read, exactly as Go's handshake fails.
 *  - A verified peer is stamped on the request's async context; the witness
 *    reads it where the verb is dispatched (`caller_identity`, `path`: gateway
 *    for hades, direct for any other star). The gateway's stamped principal is
 *    the PEP's to read and this star has no PEP, so it is not read here.
 *
 * WHY A TLS FRONT PIPED TO THE PLAINTEXT SERVER, not `https.createServer`.
 * The star runs under bun, and bun's `node:https` server hands the handler a
 * socket with no `getPeerCertificate` — the client certificate is unreachable
 * from a request (measured on bun 1.3.14). Its `node:tls` server does expose
 * `authorized` and the peer certificate on the accepted socket, but `node:http`
 * cannot adopt a foreign socket there. So the door terminates TLS itself and
 * pipes the decrypted bytes to the SAME plaintext server over loopback — one
 * handler, not a copy — recording which loopback connection carries which
 * verified peer ({@link LoopbackPeers}). The plaintext server's listener reads
 * that record ({@link withDoorPeers}) and stamps the peer on the async context.
 * The same code runs under node (the test runner), where it behaves the same.
 *
 * ROTATION. SVIDs are short-lived. The credential is read off the library's
 * `X509Source` (one Workload API stream, held for the process's life — the
 * same source the themis/chaos dials use) and every rotation is applied with
 * no restart: the door builds a new TLS server on the renewed credential,
 * listens on the SAME port beside the old one (`reusePort`), then closes the
 * old one. New handshakes present the renewed certificate and verify against
 * the renewed bundle; connections already open finish on the context they were
 * accepted under. Not `setSecureContext`: bun 1.3.14 exposes it and ignores it
 * (the served certificate does not change — measured), as it ignores
 * `SNICallback`. A rotation that cannot bind logs one WARN and leaves the old
 * server serving; the next rotation tries again.
 *
 * FAIL-SOFT. If the SPIRE socket or the first SVID is unavailable, boot logs
 * one WARN and the star serves plaintext only. It never crashes for want of
 * an identity.
 *
 * This belongs in `@forge/stellar-core-ts` so demeter can share it; it lives in
 * calliope until that package's release path carries a server (its witness
 * half is already consumed from there).
 */

import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import {
  X509Source,
  peerFromSocket,
  runWithPeer,
} from "@forge/stellar-core-ts";
import type {
  Peer,
  RequestListener,
  Unsubscribe,
} from "@forge/stellar-core-ts";

/** How long boot waits for the first SVID before serving plaintext only. */
export const DEFAULT_SVID_WAIT_MS = 5_000;

/** The slice of a credential the door presents. */
export interface DoorCredential {
  readonly certPem: string;
  readonly keyPem: string;
  readonly bundlePem: string;
}

/** The identity source the door needs: a live read and a rotation signal. */
export interface DoorSource {
  current(): DoorCredential;
  onRotate(cb: (cred: DoorCredential) => void): Unsubscribe;
  close(): void;
}

const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

/** The slice of a socket {@link LoopbackPeers} keys on. */
export interface AddressedSocket {
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
}

/**
 * Which verified peer rides which loopback connection into the plaintext
 * server. Keyed by the door's own outbound local port, which no other process
 * can claim while the connection is open, and honoured only for a loopback
 * remote address — a connection from anywhere else never reads this table.
 */
export class LoopbackPeers {
  private readonly byPort = new Map<number, Peer>();

  set(port: number, peer: Peer): void {
    this.byPort.set(port, peer);
  }

  delete(port: number): void {
    this.byPort.delete(port);
  }

  get size(): number {
    return this.byPort.size;
  }

  /** The verified peer behind this accepted connection, or undefined. */
  forSocket(socket: AddressedSocket): Peer | undefined {
    // String()/Number() so an absent address or port can match nothing: the
    // loopback set holds no "undefined", and the table no NaN.
    return LOOPBACK.has(String(socket.remoteAddress))
      ? this.byPort.get(Number(socket.remotePort))
      : undefined;
  }
}

/**
 * {@link withPeerContext}'s sibling for a server fronted by the door: the peer
 * comes from the door's loopback table first, and from the socket's own TLS
 * state otherwise (a server that terminates TLS itself, as the tests do).
 */
export function withDoorPeers(
  next: RequestListener,
  peers: LoopbackPeers,
): RequestListener {
  return (req, res) => {
    runWithPeer(
      peers.forSocket(req.socket) ?? peerFromSocket(req.socket),
      () => {
        next(req, res);
      },
    );
  };
}

/** True when the client sent a certificate (Node answers `{}` for none). */
export function presentedCertificate(socket: TLSSocket): boolean {
  // Typed as always-present; a runtime answers `{}` (or null once destroyed).
  const cert = socket.getPeerCertificate() as { raw?: Buffer } | null;
  return (cert?.raw?.length ?? 0) > 0;
}

/** The TLS options for a credential: ask for a client cert, never insist. */
export function tlsOptions(cred: DoorCredential): {
  cert: string;
  key: string;
  ca: string;
  requestCert: true;
  rejectUnauthorized: false;
} {
  return {
    cert: cred.certPem,
    key: cred.keyPem,
    ca: cred.bundlePem,
    requestCert: true,
    rejectUnauthorized: false,
  };
}

/** A running door. */
export interface MtlsDoor {
  readonly port: number;
  /** Connections dropped because they presented an unverifiable certificate. */
  readonly refused: () => number;
  close(): Promise<void>;
}

export interface DoorOptions {
  readonly source: DoorSource;
  readonly peers: LoopbackPeers;
  /** The plaintext server's port; the door pipes to it over loopback. */
  readonly upstreamPort: number;
  /** The port to listen on (0 for an ephemeral one). */
  readonly port: number;
  readonly host: string;
}

/**
 * Accept one TLS connection: refuse a presented-but-unverified certificate,
 * else forward it to the plaintext server, registering the verified peer (if any)
 * against the loopback connection that carries it.
 */
export function accept(
  sock: TLSSocket,
  opts: Pick<DoorOptions, "peers" | "upstreamPort">,
  refuse: () => void,
  connect: typeof netConnect = netConnect,
): void {
  sock.on("error", () => {
    sock.destroy();
  });
  if (presentedCertificate(sock) && !sock.authorized) {
    refuse();
    sock.destroy();
    return;
  }
  const peer = peerFromSocket(sock);
  const up = connect({ host: "127.0.0.1", port: opts.upstreamPort });
  // NaN is no port: deleting it from the table is a no-op, so `end` needs no
  // branch to tell "never registered" from "already cleared".
  let registered = NaN;
  const end = (): void => {
    opts.peers.delete(registered);
    registered = NaN;
    sock.destroy();
    up.destroy();
  };
  // Forwarded by hand, listeners attached NOW: bun's TLS socket flows as soon
  // as it is accepted and drops what arrives before a `data` listener (a late
  // `pipe()` lost the request outright — measured), so bytes read before the
  // loopback connection is up are held here and flushed once it is.
  const held: Buffer[] = [];
  let connected = false;
  sock.on("data", (chunk: Buffer) => {
    if (connected) up.write(chunk);
    else held.push(chunk);
  });
  sock.once("end", () => {
    if (connected) up.end();
  });
  up.on("data", (chunk: Buffer) => {
    sock.write(chunk);
  });
  up.once("end", () => {
    sock.end();
  });
  up.on("error", end);
  up.once("close", end);
  sock.once("close", end);
  up.once("connect", () => {
    if (peer !== undefined && up.localPort !== undefined) {
      registered = up.localPort;
      opts.peers.set(registered, peer);
    }
    connected = true;
    for (const chunk of held.splice(0)) up.write(chunk);
    if (sock.readableEnded) up.end();
  });
}

/** Build a TLS server on one credential, forwarding to the plaintext server. */
function makeServer(
  cred: DoorCredential,
  opts: DoorOptions,
  refuse: () => void,
): TlsServer {
  return createTlsServer(tlsOptions(cred), (sock) => {
    accept(sock, opts, refuse);
  });
}

function listenOn(
  server: TlsServer,
  port: number,
  host: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // reusePort so a rotated server can bind beside the one it replaces.
    server.listen({ port, host, reusePort: true }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Start the door. Rejects if the credential cannot be read or the port bound.
 * Closing it also closes the identity source it was given.
 */
export async function startMtlsDoor(opts: DoorOptions): Promise<MtlsDoor> {
  let refusedCount = 0;
  const refuse = (): void => {
    refusedCount += 1;
  };
  let current = makeServer(opts.source.current(), opts, refuse);
  const port = await listenOn(current, opts.port, opts.host);
  let rotating: Promise<void> = Promise.resolve();
  const off = opts.source.onRotate((cred) => {
    rotating = rotating.then(async () => {
      try {
        const next = makeServer(cred, opts, refuse);
        await listenOn(next, port, opts.host);
        const old = current;
        current = next;
        old.close();
      } catch (err) {
        process.stderr.write(
          `calliope-mcp-http: WARN mtls door could not apply the rotated SVID: ${errText(err)}\n`,
        );
      }
    });
  });
  return {
    port,
    refused: () => refusedCount,
    close: async () => {
      off();
      await rotating;
      await new Promise<void>((resolve) => {
        current.close(() => {
          resolve();
        });
      });
      opts.source.close();
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the identity source, bounded. `X509Source.create` retries a missing
 * Workload API socket forever, so boot races it against a timer; a source that
 * arrives after the deadline is closed rather than left streaming.
 */
export async function openDoorSource(
  timeoutMs: number,
  create: () => Promise<DoorSource>,
): Promise<DoorSource> {
  const pending = create();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no SVID within ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (err) {
    void pending.then(
      (late) => {
        late.close();
      },
      () => undefined,
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type BootOptions = Omit<DoorOptions, "source">;

/**
 * Bring the door up, or say once why not. Never throws: the star's plaintext
 * door is its liveness, and an identity problem must not take it down.
 */
export async function bootMtlsDoor(
  opts: BootOptions,
): Promise<MtlsDoor | undefined> {
  let source: DoorSource | undefined;
  try {
    source = await openDoorSource(DEFAULT_SVID_WAIT_MS, () =>
      X509Source.create(),
    );
    return await startMtlsDoor({ ...opts, source });
  } catch (err) {
    source?.close();
    process.stderr.write(
      `calliope-mcp-http: WARN mtls door unavailable, serving plaintext only: ${errText(err)}\n`,
    );
    return undefined;
  }
}

/**
 * Put the door beside a listening plaintext server: on its port + 1, forwarding
 * to it, closed when it closes. Says what it did on stderr, once.
 */
export async function serveMtlsDoor(
  plain: HttpServer,
  peers: LoopbackPeers,
  host: string,
): Promise<void> {
  const upstreamPort = (plain.address() as AddressInfo).port;
  const door = await bootMtlsDoor({
    peers,
    upstreamPort,
    port: upstreamPort + 1,
    host,
  });
  if (door === undefined) return;
  process.stderr.write(
    `calliope-mcp-http: serving mTLS (verify-if-given) on https://${host}:${String(door.port)}/mcp\n`,
  );
  plain.once("close", () => {
    void door.close();
  });
}
