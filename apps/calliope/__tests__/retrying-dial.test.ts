/**
 * RetryingDial — the migration runner's blip armor. Reads retry on any
 * failure (idempotent); admit retries ONLY on connection-never-established
 * errors, because an admit whose response was lost may have landed and a
 * blind replay would double-apply the batch.
 */

import { describe, expect, it } from "vitest";
import { FixtureChaosDial, opCreate } from "../src/chaos-client.js";
import { RetryingDial } from "../src/mcp/migrate-tree.js";

const DNS_BLIP =
  'chaos wire call "resolve_node_refs": dialling: dial tcp: lookup chaos' +
  " on 127.0.0.11:53: server misbehaving";

describe("RetryingDial", () => {
  it("retries an admit whose connection never established", async () => {
    const inner = new FixtureChaosDial();
    let calls = 0;
    const realAdmit = inner.admit.bind(inner);
    inner.admit = async (ops, scope) => {
      calls += 1;
      if (calls === 1) throw new Error(DNS_BLIP);
      return realAdmit(ops, scope);
    };
    const dial = new RetryingDial(inner);
    const res = await dial.admit([opCreate("Note", "x")], "notes");
    expect(res.admitted).toBe(true);
    expect(calls).toBe(2);
  }, 15_000);

  it("does NOT retry an admit that failed for any other reason", async () => {
    const inner = new FixtureChaosDial();
    let calls = 0;
    inner.admit = () => {
      calls += 1;
      return Promise.reject(
        new Error("admit: shape violation: Note requires a label"),
      );
    };
    const dial = new RetryingDial(inner);
    await expect(dial.admit([opCreate("Note", "x")], "notes")).rejects.toThrow(
      "shape violation",
    );
    expect(calls).toBe(1);
  });

  it("retries a read on any failure", async () => {
    const inner = new FixtureChaosDial();
    let calls = 0;
    const real = inner.findByName.bind(inner);
    inner.findByName = async (kind, label) => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return real(kind, label);
    };
    const dial = new RetryingDial(inner);
    await expect(dial.findByName("Note", "x")).resolves.toEqual([]);
    expect(calls).toBe(2);
  }, 15_000);
});
