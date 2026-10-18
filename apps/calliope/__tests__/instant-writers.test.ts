/**
 * Time facts through the notes-graph writers: dtype on the wire, the retract
 * hazard (a read answers the rendering, not the stored form), instant
 * equality, instant sort, and the local admit's canonical hashing.
 *
 * The FixtureChaosDial stands in for chaos: an `instant` is held as µs and
 * read back rendered Eastern, and an untyped retract of that rendering does
 * NOT hit it — the very hazard the writers must defeat.
 */

import { describe, expect, it } from "vitest";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FixtureChaosDial, opAdd, opRemove } from "../src/chaos-client.js";
import { FixtureTagStore } from "../src/tag-store.js";
import { sinkNoteVersion } from "../src/notes-sink.js";
import { NotesDocumentStore } from "../src/notes-document-store.js";
import { setProperties } from "../src/properties.js";
import { contentHash, toCaptureOps } from "../src/local-admit.js";
import { createNote, isCreateNoteError } from "../src/mcp/tools.js";

const SCOPE = "notes";
const Z = "2026-10-17T22:11:45.188Z";
const EASTERN = "2026-10-17T18:11:45.188000-04:00";
const MICROS = "1792275105188000";

function rig() {
  return {
    client: new FixtureBodyClient(),
    dial: new FixtureChaosDial(),
    tags: new FixtureTagStore(),
  };
}

async function valuesOf(
  dial: FixtureChaosDial,
  id: string,
  predicate: string,
): Promise<string[]> {
  return (await dial.edges(id))
    .filter((e) => e.predicate === predicate)
    .map((e) => e.value)
    .sort();
}

describe("the notes sink writes provenance times typed", () => {
  it("mints mtime/ctime as instants (read back Eastern) and leaves the rest untyped", async () => {
    const { client, dial, tags } = rig();
    const res = await sinkNoteVersion(
      client,
      dial,
      SCOPE,
      tags,
      {
        source_path: "Notes/a.md",
        body_text: "a",
        mtime: Z,
        ctime: "2026-10-17T18:11:45",
      },
      "2026-10-17T22:12:00+00:00",
    );
    expect(await valuesOf(dial, res.node_id, "mtime")).toEqual([EASTERN]);
    // naive -> wallclock: answered verbatim
    expect(await valuesOf(dial, res.node_id, "ctime")).toEqual([
      "2026-10-17T18:11:45",
    ]);
    expect(await valuesOf(dial, res.node_id, "dissolved_at")).toEqual([
      "2026-10-17T18:12:00-04:00",
    ]);
    expect(await valuesOf(dial, res.node_id, "source_kind")).toEqual([
      "vault-note",
    ]);
    const mint = dial.admits
      .flatMap((a) => a.ops)
      .find((o) => o.predicate === "mtime");
    expect(mint).toMatchObject({ to_literal: Z, dtype: "instant" });
    const source = dial.admits
      .flatMap((a) => a.ops)
      .find((o) => o.predicate === "source_path");
    expect(source).not.toHaveProperty("dtype");
  });

  it("a re-sink of the same instant, spelled differently, writes nothing", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "Notes/b.md", body_text: "b" };
    await sinkNoteVersion(client, dial, SCOPE, tags, { ...input, mtime: Z });
    const before = dial.admits.length;
    await sinkNoteVersion(client, dial, SCOPE, tags, {
      ...input,
      mtime: "2026-10-17T18:11:45.188-04:00",
    });
    // the held rendering equals the wanted instant: no retract, no add
    const attrBatches = dial.admits
      .slice(before)
      .flatMap((a) => a.ops)
      .filter((o) => o.predicate === "mtime");
    expect(attrBatches).toEqual([]);
  });

  it("a changed instant retracts the old one in BOTH forms and the old fact is gone", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "Notes/c.md", body_text: "c" };
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, {
      ...input,
      mtime: Z,
    });
    const before = dial.admits.length;
    await sinkNoteVersion(client, dial, SCOPE, tags, {
      ...input,
      mtime: "2026-10-18T01:00:00Z",
    });
    const ops = dial.admits
      .slice(before)
      .flatMap((a) => a.ops)
      .filter((o) => o.predicate === "mtime");
    expect(ops.filter((o) => o.op === "removeEdge")).toEqual([
      expect.objectContaining({ to_literal: EASTERN }),
      expect.objectContaining({ to_literal: EASTERN, dtype: "instant" }),
    ]);
    expect(await valuesOf(dial, first.node_id, "mtime")).toEqual([
      "2026-10-17T21:00:00-04:00",
    ]);
  });

  it("a legacy untyped Z fact is replaced, not orphaned", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "Notes/d.md", body_text: "d" };
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, input);
    await dial.admit(
      [opAdd(first.node_id, "mtime", { toLiteral: "2026-01-01T00:00:00Z" })],
      SCOPE,
    );
    await sinkNoteVersion(client, dial, SCOPE, tags, { ...input, mtime: Z });
    expect(await valuesOf(dial, first.node_id, "mtime")).toEqual([EASTERN]);
  });

  it("an instant equal to a legacy untyped fact keeps it (no churn)", async () => {
    const { client, dial, tags } = rig();
    const input = { source_path: "Notes/e.md", body_text: "e" };
    const first = await sinkNoteVersion(client, dial, SCOPE, tags, input);
    await dial.admit(
      [
        opAdd(first.node_id, "mtime", {
          toLiteral: "2026-10-17T22:11:45.188Z",
        }),
      ],
      SCOPE,
    );
    const before = dial.admits.length;
    await sinkNoteVersion(client, dial, SCOPE, tags, {
      ...input,
      mtime: "2026-10-17T18:11:45.188000-04:00",
    });
    const touched = dial.admits
      .slice(before)
      .flatMap((a) => a.ops)
      .filter((o) => o.predicate === "mtime");
    expect(touched).toEqual([]);
  });
});

describe("set_properties and time facts", () => {
  async function node(dial: FixtureChaosDial, title: string) {
    const r = await createNote(dial, SCOPE, { title }, undefined);
    if (isCreateNoteError(r)) throw new Error(r.detail);
    return r.node_id;
  }

  it("types created/updated date-times, leaves bare dates and other predicates alone", async () => {
    const dial = new FixtureChaosDial();
    const id = await node(dial, "P/a");
    await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [
        { predicate: "created", values: [{ literal: "2026-10-17" }] },
        { predicate: "updated", values: [{ literal: Z }] },
        {
          predicate: "last_active",
          values: [{ literal: "2026-10-17T09:00:00" }],
        },
        { predicate: "due", values: [{ literal: Z }] },
      ],
    });
    expect(await valuesOf(dial, id, "created")).toEqual(["2026-10-17"]);
    expect(await valuesOf(dial, id, "updated")).toEqual([EASTERN]);
    expect(await valuesOf(dial, id, "last_active")).toEqual([
      "2026-10-17T09:00:00",
    ]);
    expect(await valuesOf(dial, id, "due")).toEqual([Z]);
  });

  it("re-running with another spelling of the same instant is a no-op", async () => {
    const dial = new FixtureChaosDial();
    const id = await node(dial, "P/b");
    const call = (literal: string) =>
      setProperties(dial, SCOPE, undefined, {
        container_id: id,
        properties: [{ predicate: "updated", values: [{ literal }] }],
      });
    await call(Z);
    const before = dial.admits.length;
    const again = await call(EASTERN);
    expect(dial.admits.length).toBe(before);
    expect(again).toMatchObject({ added: [], removed: [] });
  });

  it("a changed instant retracts the held one (typed) and a legacy one (untyped)", async () => {
    const dial = new FixtureChaosDial();
    const id = await node(dial, "P/c");
    await dial.admit(
      [
        opAdd(id, "updated", { toLiteral: "2025-01-01T00:00:00Z" }),
        opAdd(id, "updated", {
          toLiteral: "2025-02-01T00:00:00Z",
          dtype: "instant",
        }),
      ],
      SCOPE,
    );
    await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "updated", values: [{ literal: Z }] }],
    });
    expect(await valuesOf(dial, id, "updated")).toEqual([EASTERN]);
  });

  it("retract:true removes an instant fact by the value read back", async () => {
    const dial = new FixtureChaosDial();
    const id = await node(dial, "P/d");
    await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      properties: [{ predicate: "updated", values: [{ literal: Z }] }],
    });
    const out = await setProperties(dial, SCOPE, undefined, {
      container_id: id,
      retract: true,
      properties: [{ predicate: "updated", values: [{ literal: EASTERN }] }],
    });
    expect(out).toMatchObject({ removed: [`updated=${EASTERN}`] });
    expect(await valuesOf(dial, id, "updated")).toEqual([]);
  });
});

describe("the fixture models the retract hazard", () => {
  it("an untyped retract of the rendering misses an instant; a typed one hits", async () => {
    const dial = new FixtureChaosDial();
    const r = await createNote(dial, SCOPE, { title: "H/a" }, undefined);
    if (isCreateNoteError(r)) throw new Error(r.detail);
    await dial.admit(
      [opAdd(r.node_id, "mtime", { toLiteral: Z, dtype: "instant" })],
      SCOPE,
    );
    await dial.admit(
      [opRemove(r.node_id, "mtime", { toLiteral: EASTERN })],
      SCOPE,
    );
    expect(await valuesOf(dial, r.node_id, "mtime")).toEqual([EASTERN]);
    await dial.admit(
      [opRemove(r.node_id, "mtime", { toLiteral: EASTERN, dtype: "instant" })],
      SCOPE,
    );
    expect(await valuesOf(dial, r.node_id, "mtime")).toEqual([]);
  });
});

describe("NotesDocumentStore orders by instant", () => {
  it("newest dissolved_at first, across offsets", async () => {
    const client = new FixtureBodyClient();
    const dial = new FixtureChaosDial();
    const store = new NotesDocumentStore(client, dial, SCOPE);
    const when = new Map([
      // lexically last, chronologically first
      ["Notes/x.md", "2026-10-17T23:00:00+05:00"],
      ["Notes/y.md", "2026-10-17T15:00:00-04:00"],
      ["Notes/z.md", "2026-10-17T12:00:00Z"],
    ]);
    for (const [path, at] of when) {
      await sinkNoteVersion(
        client,
        dial,
        SCOPE,
        undefined,
        { source_path: path, body_text: path },
        at,
      );
    }
    const rows = await store.list({ limit: 10 });
    expect(rows.map((r) => r.source_path)).toEqual([
      "Notes/y.md",
      "Notes/x.md",
      "Notes/z.md",
    ]);
    expect(rows[0]?.created_at).toBe("2026-10-17T15:00:00-04:00");
  });
});

describe("the local admit hashes the canonical form", () => {
  it("an instant interns as µs with its dtype and hashes (µs, instant, '')", () => {
    const wire = toCaptureOps(
      [opAdd("aa11", "mtime", { toLiteral: Z, dtype: "instant" })],
      SCOPE,
    );
    expect(wire[0]).toEqual({
      op: "intern",
      value: MICROS,
      dtype: "instant",
    });
    expect(wire[1]).toMatchObject({
      o: contentHash(MICROS, "instant", ""),
    });
    // and never the hash of the raw text
    expect(wire[1]).not.toMatchObject({ o: contentHash(Z) });
    expect(wire[1]).not.toMatchObject({ o: contentHash(Z, "instant") });
  });

  it("the same instant in two spellings is one scalar", () => {
    const hash = (literal: string) =>
      toCaptureOps(
        [opAdd("aa11", "mtime", { toLiteral: literal, dtype: "instant" })],
        SCOPE,
      )[1];
    expect(hash(Z)).toEqual(hash(EASTERN));
  });

  it("a wallclock interns canonical; an untyped literal is unchanged", () => {
    const [intern] = toCaptureOps(
      [
        opAdd("aa11", "ctime", {
          toLiteral: "2026-10-17T18:11:45.5",
          dtype: "wallclock",
        }),
      ],
      SCOPE,
    );
    expect(intern).toEqual({
      op: "intern",
      value: "2026-10-17T18:11:45.500000",
      dtype: "wallclock",
    });
    const [plain] = toCaptureOps(
      [opAdd("aa11", "status", { toLiteral: "done" })],
      SCOPE,
    );
    expect(plain).toEqual({ op: "intern", value: "done" });
  });

  it("refuses a dtype it cannot canonicalise", () => {
    expect(() =>
      toCaptureOps(
        [opAdd("aa11", "mtime", { toLiteral: "soon", dtype: "instant" })],
        SCOPE,
      ),
    ).toThrow(/not a valid instant/);
  });
});
