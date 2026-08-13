/**
 * F1 (024) — fixture-client parity for per-call author threading.
 *
 * The fixture mirrors the sovereign store's provenance surface as far as the
 * A8 history observes it: each write-event records the author that made it,
 * and `readRevisions` reports it verbatim (it hard-coded "human" before 024).
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";

const PRINCIPAL =
  "spiffe://notusmi.com/session/aa579121-1a2b-4c3d-8e4f-a5b6c7d8e9f0";

describe("FixtureBodyClient — 024 per-call author threading", () => {
  it("saveBody records the caller's principal on the event", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n1", [{ text: "hello" }], PRINCIPAL);
    const revs = await client.readRevisions("n1");
    expect(revs.map((r) => r.authoredBy)).toEqual([PRINCIPAL]);
  });

  it("absent author keeps the legacy default (human) — byte-identical history", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n2", [{ text: "hello" }]);
    const revs = await client.readRevisions("n2");
    expect(revs.map((r) => r.authoredBy)).toEqual(["human"]);
  });

  it("editSection and applySectionOps thread the principal to their events", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n3", [{ text: "one" }]);
    const body = await client.readBody("n3");
    const target = body.at(0);
    if (!target) throw new Error("fixture body missing");

    await client.editSection("n3", target.id, "one edited", PRINCIPAL);
    await client.applySectionOps(
      "n3",
      [{ op: "add", text: "two", orderKey: "zz" }],
      PRINCIPAL,
    );

    const revs = await client.readRevisions("n3");
    // Newest first: ops (principal), edit (principal), save (default human).
    expect(revs.map((r) => r.authoredBy)).toEqual([
      PRINCIPAL,
      PRINCIPAL,
      "human",
    ]);
  });

  it("splitSection and mergeSections record the principal", async () => {
    const client = new FixtureBodyClient();
    await client.saveBody("n4", [{ text: "one two" }]);
    const body = await client.readBody("n4");
    const target = body.at(0);
    if (!target) throw new Error("fixture body missing");

    const [head, tail] = await client.splitSection(
      "n4",
      target.id,
      3,
      PRINCIPAL,
    );
    await client.mergeSections("n4", head.id, tail.id, "", PRINCIPAL);

    const revs = await client.readRevisions("n4");
    expect(revs.map((r) => r.authoredBy)).toEqual([
      PRINCIPAL,
      PRINCIPAL,
      "human",
    ]);
  });

  describe("025 — the offset stamp (fixture parity)", () => {
    it("records the per-event kafkaOffset and null when absent", async () => {
      const client = new FixtureBodyClient();
      await client.saveBody("n5", [{ text: "one" }], PRINCIPAL, 42);
      await client.applySectionOps(
        "n5",
        [{ op: "add", text: "two", orderKey: "zz" }],
        PRINCIPAL,
        43,
      );
      await client.saveBody("n5", [{ text: "three" }], PRINCIPAL);
      const revs = await client.readRevisions("n5");
      // Newest first.
      expect(revs.map((r) => r.kafkaOffset)).toEqual([null, 43, 42]);
    });

    it("refuses an offset without a session principal", async () => {
      const client = new FixtureBodyClient();
      await expect(
        client.saveBody("n6", [{ text: "nope" }], "human", 42),
      ).rejects.toThrow(/session-principal/);
      expect(await client.readRevisions("n6")).toEqual([]);
    });
  });
});
