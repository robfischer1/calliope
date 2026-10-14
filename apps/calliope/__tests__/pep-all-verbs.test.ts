import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLog } from "@forge/stellar-core-ts";
import type { RequestRecord } from "@forge/stellar-core-ts";
import { createCalliopeHttpServer } from "../src/mcp/http.js";
import { loadPep, withDenyDecision } from "@forge/stellar-core-ts/pep";

/**
 * Mesh census: proteus->calliope calls to these four verbs logged a request
 * record with no PEP decision. Each is driven through the SERVED route with a
 * witness-mode PEP armed; each must leave one record carrying a decision, and
 * witness must never refuse.
 */

const VERBS = [
  "dissolve_note",
  "materialize_note",
  "read_container",
  "write_container",
] as const;

let open: Server | undefined;

afterEach(async () => {
  const server = open;
  open = undefined;
  if (server?.listening)
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
});

describe("witness-mode PEP decides every verb on the served route", () => {
  for (const verb of VERBS) {
    it(`${verb}: one record, a decision recorded, nothing refused`, async () => {
      const got: RequestRecord[] = [];
      const log = new RequestLog("calliope", {
        sink: withDenyDecision((r) => {
          got.push(r);
        }),
      });
      const pep = loadPep({
        star: "calliope",
        mode: "witness",
        sidecarPath: "/nonexistent/orbit.toml",
        log: () => undefined,
      });
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
        { log, close: () => Promise.resolve() },
        undefined,
        pep,
      );
      open = server;
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: verb, arguments: {} },
        }),
      });
      await resp.text();
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ verb });
      expect(got[0]?.decision).toBeDefined();
      expect(got[0]?.outcome).not.toBe("denied");
    });
  }
});
