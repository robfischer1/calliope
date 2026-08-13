// ── 028 ("Look At This" F5): the focus register + the look verb ──────────────

import { describe, expect, it } from "vitest";
import {
  FocusRegister,
  handleTelemetryMessage,
} from "../src/focus-register.js";
import { isBodyPointer, type BodyPointer } from "../src/types.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { look } from "../src/mcp/tools.js";

const pointer = (over?: Partial<BodyPointer>): BodyPointer => ({
  kind: "body",
  node: "n1",
  section: "s1",
  offsetFrom: 0,
  offsetTo: 6,
  text: "stable",
  ts: "2026-08-13T00:00:00.000Z",
  ...over,
});

describe("the BodyPointer mirror — pinned against theia 058", () => {
  it("accepts the well-formed shape and tolerates unknown kinds", () => {
    expect(isBodyPointer(pointer())).toBe(true);
    const future: unknown = { ...pointer(), kind: "star-card" };
    expect(() => isBodyPointer(future)).not.toThrow();
    expect(isBodyPointer(future)).toBe(false);
    expect(isBodyPointer(null)).toBe(false);
    expect(isBodyPointer({ ...pointer(), offsetFrom: "0" })).toBe(false);
  });
});

describe("FocusRegister — the LWW broadcast slot", () => {
  it("is last-write-wins and reads never mutate", () => {
    const reg = new FocusRegister();
    expect(reg.current()).toBeNull();
    reg.set(pointer({ section: "first" }), "t1");
    reg.set(pointer({ section: "second" }), "t2");
    expect(reg.current()?.pointer.section).toBe("second");
    // N readers of one value: reading changes nothing
    reg.current();
    reg.current();
    expect(reg.current()?.pointer.section).toBe("second");
    expect(reg.current()?.receivedAt).toBe("t2");
  });
});

describe("handleTelemetryMessage — the pure fold", () => {
  const now = () => new Date("2026-08-13T12:00:00.000Z");

  it("folds a selection-change carrying a valid pointer", () => {
    const reg = new FocusRegister();
    handleTelemetryMessage(
      reg,
      JSON.stringify({ type: "selection-change", pointer: pointer() }),
      now,
    );
    expect(reg.current()?.pointer.section).toBe("s1");
    expect(reg.current()?.receivedAt).toBe("2026-08-13T12:00:00.000Z");
  });

  it("folds batches (arrays) in order — the last pointer wins", () => {
    const reg = new FocusRegister();
    handleTelemetryMessage(
      reg,
      JSON.stringify([
        { type: "selection-change", pointer: pointer({ section: "a" }) },
        { type: "doc-change", added: 3, removed: 0 },
        { type: "selection-change", pointer: pointer({ section: "b" }) },
      ]),
      now,
    );
    expect(reg.current()?.pointer.section).toBe("b");
  });

  it("ignores other events, pointerless selections, guard failures, malformed JSON", () => {
    const reg = new FocusRegister();
    handleTelemetryMessage(reg, JSON.stringify({ type: "doc-change" }), now);
    handleTelemetryMessage(
      reg,
      JSON.stringify({ type: "selection-change", from: 1, to: 5 }),
      now,
    );
    handleTelemetryMessage(
      reg,
      JSON.stringify({
        type: "selection-change",
        pointer: { kind: "star-card" },
      }),
      now,
    );
    handleTelemetryMessage(reg, "{not json", now);
    handleTelemetryMessage(reg, undefined, now);
    expect(reg.current()).toBeNull();
  });
});

describe("look — read the register, verify the witness", () => {
  it("answers { focus: null } on an empty register — not an error", async () => {
    const client = new FixtureBodyClient();
    expect(await look(client, new FocusRegister())).toEqual({ focus: null });
  });

  it("drift none: the excerpt still exists in the live block", async () => {
    const client = new FixtureBodyClient({
      n1: [{ text: "stable prose here" }],
    });
    const body = await client.readBody("n1");
    const sec = body[0];
    if (sec === undefined) throw new Error("seed failed");
    const reg = new FocusRegister();
    reg.set(pointer({ section: sec.id }), "t1");
    const r = await look(client, reg);
    expect(r.focus?.drift).toBe("none");
    expect(r.focus?.pointer.text).toBe("stable");
    expect(r.focus?.current_text).toBeUndefined();
  });

  it("drift drifted: the excerpt is gone from the block — current text included", async () => {
    const client = new FixtureBodyClient({
      n1: [{ text: "totally rewritten paragraph" }],
    });
    const body = await client.readBody("n1");
    const sec = body[0];
    if (sec === undefined) throw new Error("seed failed");
    const reg = new FocusRegister();
    reg.set(pointer({ section: sec.id }), "t1");
    const r = await look(client, reg);
    expect(r.focus?.drift).toBe("drifted");
    expect(r.focus?.current_text).toBe("totally rewritten paragraph");
  });

  it("drift gone: the block no longer resolves", async () => {
    const client = new FixtureBodyClient({ n1: [{ text: "anything" }] });
    const reg = new FocusRegister();
    reg.set(pointer({ section: "no-such-block" }), "t1");
    const r = await look(client, reg);
    expect(r.focus?.drift).toBe("gone");
    expect(r.focus?.current_text).toBeUndefined();
  });

  it("reading the verb does not consume the focus", async () => {
    const client = new FixtureBodyClient({ n1: [{ text: "stable" }] });
    const body = await client.readBody("n1");
    const sec = body[0];
    if (sec === undefined) throw new Error("seed failed");
    const reg = new FocusRegister();
    reg.set(pointer({ section: sec.id }), "t1");
    await look(client, reg);
    const again = await look(client, reg);
    expect(again.focus).not.toBeNull();
  });
});
