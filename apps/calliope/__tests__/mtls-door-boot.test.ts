/**
 * The door's boot, fail-soft: the Workload API is faked at the library seam
 * (`X509Source.create`) so the real default path — the 5s bound, the warning,
 * the plaintext-only outcome — is what runs. Nothing opens a SPIRE socket.
 */
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoopbackPeers,
  bootMtlsDoor,
  serveMtlsDoor,
} from "../src/mcp/mtls-door.js";
import type { DoorSource } from "../src/mcp/mtls-door.js";
import { makeIdentity } from "./helpers/tls-identity.js";

const hoisted = vi.hoisted(() => ({ create: vi.fn() }));
const { create } = hoisted;

vi.mock("@forge/stellar-core-ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, X509Source: { create: hoisted.create } };
});

const ident = makeIdentity(
  "DNS:localhost, URI:spiffe://notusmi.com/star/calliope",
);

function source(closed: { n: number }): DoorSource {
  return {
    current: () => ({
      certPem: ident.cert,
      keyPem: ident.key,
      bundlePem: ident.cert,
    }),
    onRotate: () => () => undefined,
    close: () => {
      closed.n += 1;
    },
  };
}

function offer(src: DoorSource): void {
  create.mockResolvedValue(src);
}

const boot = {
  peers: new LoopbackPeers(),
  upstreamPort: 1,
  port: 0,
  host: "127.0.0.1",
};

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  create.mockReset();
  for (const fn of cleanup.splice(0)) await fn();
});

function stderrSpy(): { lines: () => string[]; restore: () => void } {
  const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  return {
    lines: () => spy.mock.calls.map((c) => String(c[0])),
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("bootMtlsDoor", () => {
  it("with no workload API the door is absent, one WARN, nothing thrown", async () => {
    const err = stderrSpy();
    try {
      create.mockRejectedValue(new Error("no workload api"));
      await expect(bootMtlsDoor(boot)).resolves.toBeUndefined();
      const warns = err
        .lines()
        .filter((l) => l.includes("WARN mtls door unavailable"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("serving plaintext only");
      expect(warns[0]).toContain("no workload api");
    } finally {
      err.restore();
    }
  });

  it("names a failure that is not an Error by its text", async () => {
    const err = stderrSpy();
    try {
      create.mockRejectedValue("socket path missing");
      await expect(bootMtlsDoor(boot)).resolves.toBeUndefined();
      expect(err.lines().join("")).toContain("socket path missing");
    } finally {
      err.restore();
    }
  });

  it("waits exactly 5s for the first SVID, then gives up, and closes a source that arrives late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const err = stderrSpy();
    try {
      let late: ((s: DoorSource) => void) | undefined;
      create.mockReturnValue(
        new Promise<DoorSource>((resolve) => {
          late = resolve;
        }),
      );
      let settled: unknown = "pending";
      const booted = bootMtlsDoor(boot).then((d) => {
        settled = d;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await booted;
      expect(settled).toBeUndefined();
      expect(
        err.lines().filter((l) => l.includes("no SVID within 5000ms")),
      ).toHaveLength(1);
      const closed = { n: 0 };
      late?.(source(closed));
      await vi.waitFor(() => {
        expect(closed.n).toBe(1);
      });
    } finally {
      err.restore();
    }
  });

  it("a source whose credential cannot be read is closed and the door is absent", async () => {
    const err = stderrSpy();
    try {
      const closed = { n: 0 };
      offer({
        ...source(closed),
        current: () => {
          throw new Error("expired");
        },
      });
      await expect(bootMtlsDoor(boot)).resolves.toBeUndefined();
      expect(closed.n).toBe(1);
      expect(err.lines().join("")).toContain("expired");
    } finally {
      err.restore();
    }
  });

  it("with an SVID the door comes up, leaves no timer behind, and closing it closes the source", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closed = { n: 0 };
    offer(source(closed));
    const door = await bootMtlsDoor(boot);
    expect(door?.port).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    await door?.close();
    expect(closed.n).toBe(1);
  });
});

describe("serveMtlsDoor", () => {
  async function plain(): Promise<Server> {
    const server = createHttpServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    );
    return server;
  }

  function dialDoor(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          port,
          host: "127.0.0.1",
          rejectUnauthorized: false,
          agent: false,
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString();
          });
          res.on("end", () => {
            resolve(body);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("serves the plaintext server's answer on its port + 1, says so once, and closes with it", async () => {
    const err = stderrSpy();
    try {
      const closed = { n: 0 };
      offer(source(closed));
      const server = await plain();
      const port = (server.address() as AddressInfo).port;
      await serveMtlsDoor(server, new LoopbackPeers(), "127.0.0.1");
      expect(await dialDoor(port + 1)).toBe("ok");
      const said = err
        .lines()
        .filter((l) => l.includes("serving mTLS (verify-if-given)"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`https://127.0.0.1:${String(port + 1)}/mcp`);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await vi.waitFor(() => {
        expect(closed.n).toBe(1);
      });
      await expect(dialDoor(port + 1)).rejects.toThrow();
    } finally {
      err.restore();
    }
  });

  it("with no SVID it adds nothing: no door, and nothing waiting on the plaintext server's close", async () => {
    const err = stderrSpy();
    try {
      create.mockRejectedValue(new Error("no workload api"));
      const server = await plain();
      const before = server.listenerCount("close");
      await serveMtlsDoor(server, new LoopbackPeers(), "127.0.0.1");
      expect(server.listenerCount("close")).toBe(before);
      expect(
        err.lines().filter((l) => l.includes("serving mTLS")),
      ).toHaveLength(0);
    } finally {
      err.restore();
    }
  });
});
