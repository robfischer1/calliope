import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestLog } from "@forge/stellar-core-ts";
import type { RequestRecord } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import { createServer } from "../src/mcp/server.js";
import { VERB_PREFIX, makeWitness } from "../src/mcp/witness.js";
import { bareClient } from "./helpers/bare-client.js";
import type { Witness } from "../src/mcp/witness.js";
import { makeIdentity } from "./helpers/tls-identity.js";
import type { TlsIdentity } from "./helpers/tls-identity.js";

/**
 * The witness, end to end: a `tools/call` on the SERVED route leaves exactly
 * one request record, and protocol chatter leaves none. The peer stamp is
 * proven through a real TLS handshake into the real streamable-HTTP transport,
 * because that the async context survives it into the tool handler is a
 * property of someone else's library — and the only place it is not an
 * assumption is here.
 */

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function recording(): {
  witness: Witness;
  got: RequestRecord[];
  closed: () => number;
} {
  const got: RequestRecord[] = [];
  let closed = 0;
  const log = new RequestLog("calliope", {
    verbPrefix: VERB_PREFIX,
    sink: (r) => {
      got.push(r);
    },
  });
  return {
    witness: {
      log,
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    },
    got,
    closed: () => closed,
  };
}

function witnessedServer(witness: Witness): Server {
  return createCalliopeHttpServer(
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
  );
}

const callEnvelope = (id: number, name: string): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

let open: Server | undefined;

async function listen(server: Server): Promise<string> {
  open = server;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function post(
  url: string,
  body: Record<string, unknown>,
): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
  return resp.text();
}

afterEach(async () => {
  const server = open;
  open = undefined;
  if (server?.listening) await closeServer(server);
});

describe("the served route leaves one record per tools/call", () => {
  it("a read-only call leaves exactly one record: unidentified, path unknown, native", async () => {
    const { witness, got } = recording();
    const url = await listen(witnessedServer(witness));
    await post(url, callEnvelope(1, "list_tags"));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      star: "calliope",
      verb: "list_tags",
      caller_class: "unidentified",
      path: "unknown",
      wire_form: "native",
      outcome: "ok",
    });
    expect(Object.keys(got[0] ?? {})).not.toContain("caller_identity");
  });

  it("the wire form follows the fleet record's verb prefix", async () => {
    const { witness, got } = recording();
    const url = await listen(witnessedServer(witness));
    await post(url, callEnvelope(1, "calliope_list_tags"));
    expect(got[0]?.wire_form).toBe("prefixed");
    expect(VERB_PREFIX).toBe("calliope");
  });

  it("initialize and tools/list leave none; two calls leave two", async () => {
    const { witness, got } = recording();
    const url = await listen(witnessedServer(witness));
    await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await post(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(got).toHaveLength(0);
    await post(url, callEnvelope(3, "list_tags"));
    await post(url, callEnvelope(4, "look"));
    expect(got.map((r) => r.verb)).toEqual(["list_tags", "look"]);
  });

  it("a call the star answers with an error is still one record, star_error", async () => {
    const { witness, got } = recording();
    const url = await listen(witnessedServer(witness));
    await post(url, callEnvelope(1, "no_such_verb"));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      verb: "no_such_verb",
      outcome: "star_error",
    });
  });

  it("a server wired with no witness records nothing and still answers", async () => {
    const url = await listen(createCalliopeHttpServer("fixture"));
    expect(await post(url, callEnvelope(1, "list_tags"))).toContain("result");
  });

  it("closing the door closes the witness's sink", async () => {
    const { witness, closed } = recording();
    const server = witnessedServer(witness);
    await listen(server);
    expect(closed()).toBe(0);
    await closeServer(server);
    expect(closed()).toBe(1);
  });
});

describe("the peer stamp, through a real TLS handshake and the real transport", () => {
  async function dial(
    client: TlsIdentity | undefined,
    trust: string,
  ): Promise<RequestRecord[]> {
    const { witness, got } = recording();
    const inner = witnessedServer(witness);
    const door = makeIdentity("DNS:localhost");
    // Verify-if-given, as the Go stars listen: a client certificate is asked
    // for and verified against the trust bundle, and its absence refuses nothing.
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
    await new Promise<void>((resolve) => {
      tls.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = (tls.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
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
            res.resume();
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(callEnvelope(1, "list_tags")));
      });
    } finally {
      await closeServer(tls);
    }
    return got;
  }

  it("a verified star is the caller, direct; a verified hades is the gateway; no cert is unidentified", async () => {
    const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
    const hades = makeIdentity("URI:spiffe://notusmi.com/star/hades");
    const bundle = themis.cert + hades.cert;

    const viaThemis = await dial(themis, bundle);
    expect(viaThemis).toHaveLength(1);
    expect(viaThemis[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/themis",
      path: "direct",
    });

    const viaHades = await dial(hades, bundle);
    expect(viaHades[0]).toMatchObject({
      caller_class: "star",
      caller_identity: "spiffe://notusmi.com/star/hades",
      path: "gateway",
    });

    const anon = await dial(undefined, bundle);
    expect(anon[0]).toMatchObject({
      caller_class: "unidentified",
      path: "unknown",
    });
  });

  it("a client certificate the bundle does not trust is not believed", async () => {
    const themis = makeIdentity("URI:spiffe://notusmi.com/star/themis");
    const stranger = makeIdentity("URI:spiffe://notusmi.com/star/hades");
    const got = await dial(stranger, themis.cert);
    expect(got[0]).toMatchObject({
      caller_class: "unidentified",
      path: "unknown",
    });
  });
});

describe("createServer", () => {
  it("builds with no options at all — the witness is optional and absence is not a fault", () => {
    expect(() => createServer(bareClient({}))).not.toThrow();
  });
});

describe("makeWitness", () => {
  it("close delegates to the sink it built, and the star's name and broker reach it", async () => {
    let closed = 0;
    const seen: unknown[] = [];
    const w = makeWitness({ KAFKA_BOOTSTRAP: "broker:9092" }, (opts) => {
      seen.push(opts);
      return {
        sink: () => undefined,
        reach: "topic",
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
    });
    expect(seen).toEqual([{ star: "calliope", bootstrap: "broker:9092" }]);
    expect(w.log.enabled).toBe(true);
    await w.close();
    expect(closed).toBe(1);
  });

  it("with no broker, records to the log stream and says so once", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const w = makeWitness({});
      w.log.record("calliope_x", {
        callerClass: "star",
        callerIdentity: "spiffe://notusmi.com/star/hades",
        path: "gateway",
      });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.filter((l) => l.includes("no broker configured")),
      ).toHaveLength(1);
      const recordLine = lines.find((l) => l.includes("msg=request_log"));
      expect(recordLine).toContain('\\"verb\\":\\"calliope_x\\"');
      expect(recordLine).toContain('\\"wire_form\\":\\"prefixed\\"');
      await w.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("with a broker named, builds the topic sink without dialling it", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const w = makeWitness({ KAFKA_BOOTSTRAP: "127.0.0.1:1" });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) =>
          l.includes(
            "witnessing inbound calls star=calliope topic=calliope._ops.calls",
          ),
        ),
      ).toBe(true);
      expect(w.log.enabled).toBe(true);
      await w.close();
    } finally {
      spy.mockRestore();
    }
  });
});
