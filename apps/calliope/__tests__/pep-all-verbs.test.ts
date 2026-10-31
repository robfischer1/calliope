import { afterEach, describe, expect, it } from "vitest";
import { RequestLog } from "@forge/stellar-core-ts";
import type { RequestRecord } from "@forge/stellar-core-ts";
import { loadPep, withDenyDecision } from "@forge/stellar-core-ts/pep";
import { serveDoor, toolRecords } from "./rest-door.js";

/**
 * Mesh census: proteus->calliope calls to these four verbs logged a request
 * record with no PEP decision. Each is driven through the SERVED door (the REST
 * door, calliope's only listener) with a witness-mode PEP armed; each must leave
 * one tool record carrying a decision, and witness must never refuse.
 */

const VERBS = [
  "dissolve_note",
  "materialize_note",
  "read_container",
  "write_container",
] as const;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("witness-mode PEP decides every verb on the served door", () => {
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
        log: () => undefined,
      });
      const { rest, base } = await serveDoor({
        witness: { log, close: () => Promise.resolve() },
        pep,
      });
      closers.push(() => rest.close());
      const doc = (await (await fetch(`${base}/openapi.json`)).json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const method = Object.keys(doc.paths[`/v1/${verb}`] ?? {})[0] ?? "post";
      const resp = await fetch(`${base}/v1/${verb}`, {
        method: method.toUpperCase(),
        ...(method === "get"
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: "{}" }),
      });
      await resp.text();
      const recs = toolRecords(got);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ verb });
      expect(recs[0]?.decision).toBeDefined();
      expect(recs[0]?.outcome).not.toBe("denied");
    });
  }
});
