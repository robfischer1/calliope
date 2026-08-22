/**
 * Archived notes carry no inline tags.
 *
 * The phdb-migration corpus (2026-07-05) landed 2,479 non-vault documents on
 * the notes scope — C source, spreadsheets, mail — keyed `source_path :: file`
 * and stamped `isArchived=true` as the exclusion predicate. The inline-tag
 * hook then ran the tag grammar over every body, and the picker's chip row
 * filled with `#include`, `#ifdef`, `#div/0`, `#n/a`, `#inbox/<gmail id>`.
 * Two halves here: the hook skips an archived note, and the one-shot sweep
 * takes the standing inline rows off every archived note, explicit rows
 * untouched, probe mode writing nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { FixtureChaosDial, opAdd, opCreate } from "../src/chaos-client.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import {
  isArchived,
  maybeReconcileInlineTags,
  reconcileNoteTags,
  sweepArchivedTags,
} from "../src/mcp/tools.js";
import { main } from "../src/mcp/cleanup-tags.js";
import { FixtureTagStore } from "../src/tag-store.js";

const SCOPE = "notes";

async function mintNote(
  dial: FixtureChaosDial,
  label: string,
  archived: boolean,
): Promise<string> {
  const ops = [
    opCreate("Note", label),
    // A non-empty createNode label names its mint for later ops in the
    // same batch (themis's rule, mirrored by the fixture dial).
    opAdd(label, "hasType", { toLiteral: "Note" }),
    ...(archived ? [opAdd(label, "isArchived", { toLiteral: "true" })] : []),
  ];
  const res = await dial.admit(ops, SCOPE);
  const token = res.minted[0] ?? "";
  expect(token).not.toBe("");
  return token;
}

describe("the inline-tag hook skips an archived note", () => {
  it("writes nothing for an archived body; a live body still reconciles", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const client = new FixtureBodyClient();
    const archived = await mintNote(
      dial,
      "F:\\OneDrive :: unchroot.c.txt",
      true,
    );
    const live = await mintNote(dial, "Brain Soup/Idea.md", false);
    await client.saveBody(archived, [
      { text: "#include <stdio.h>\n#ifdef X\n#endif" },
    ]);
    await client.saveBody(live, [{ text: "prose #brain-soup" }]);

    await maybeReconcileInlineTags(client, dial, SCOPE, store, archived);
    await maybeReconcileInlineTags(client, dial, SCOPE, store, live);

    expect(await store.byNode(archived)).toEqual([]);
    expect(
      (await dial.edges(archived)).filter((e) => e.predicate === "hasTag"),
    ).toEqual([]);
    expect((await store.byNode(live)).map((r) => r.tag)).toEqual([
      "#brain-soup",
    ]);
  });

  it("isArchived reads the literal, not a node-valued edge or another value", () => {
    expect(
      isArchived([{ predicate: "isArchived", value: "true", isNode: false }]),
    ).toBe(true);
    expect(
      isArchived([{ predicate: "isArchived", value: "false", isNode: false }]),
    ).toBe(false);
    expect(
      isArchived([{ predicate: "isArchived", value: "true", isNode: true }]),
    ).toBe(false);
    // Another predicate's "true" is not this one's.
    expect(
      isArchived([{ predicate: "published", value: "true", isNode: false }]),
    ).toBe(false);
    expect(isArchived([])).toBe(false);
  });
});

describe("cleanup-tags --archived (the CLI seam)", () => {
  it("probe reports the sweep on the handed dial + store and writes one JSON line", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const a = await mintNote(dial, "F:\\OneDrive :: a.c", true);
    await reconcileNoteTags(dial, SCOPE, store, a, { inline: ["#include"] });
    const lines: string[] = [];
    await main(
      ["bun", "cleanup-tags.ts", "--archived", "--probe"],
      { DATABASE_URL: "postgres://unused" },
      { dial, store, write: (l) => lines.push(l) },
    );
    expect(lines).toEqual([
      `${JSON.stringify({ probe: true, archived: 1, carriers: 1, rows: 1, tags: ["#include"] })}\n`,
    ]);
    // Probe wrote nothing.
    expect((await store.byNode(a)).map((r) => r.tag)).toEqual(["#include"]);
  });

  it("apply sweeps, and DATABASE_URL is still required", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const a = await mintNote(dial, "F:\\OneDrive :: a.c", true);
    await reconcileNoteTags(dial, SCOPE, store, a, { inline: ["#include"] });
    const lines: string[] = [];
    await main(
      ["bun", "cleanup-tags.ts", "--archived"],
      { DATABASE_URL: "postgres://unused" },
      { dial, store, write: (l) => lines.push(l) },
    );
    expect(lines[0]).toContain('"probe":false');
    expect(lines[0]).toContain('"rows":1');
    expect(await store.byNode(a)).toEqual([]);
    await expect(
      main(["bun", "cleanup-tags.ts", "--archived"], {}, { dial, store }),
    ).rejects.toThrow("DATABASE_URL is required.");
  });

  it("without --archived the legacy plan runs against the store (and here cannot reach one)", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const a = await mintNote(dial, "F:\\OneDrive :: a.c", true);
    await reconcileNoteTags(dial, SCOPE, store, a, { inline: ["#include"] });
    const lines: string[] = [];
    // The legacy mode reads note_tags off the pool — a closed port refuses,
    // and the archived sweep must NOT have run in its place.
    await expect(
      main(
        ["bun", "cleanup-tags.ts", "--probe"],
        { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" },
        { dial, store, write: (l) => lines.push(l) },
      ),
    ).rejects.toThrow();
    expect(lines).toEqual([]);
    expect((await store.byNode(a)).map((r) => r.tag)).toEqual(["#include"]);
  });

  it("the default writer is stdout", async () => {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await main(
        ["bun", "cleanup-tags.ts", "--archived", "--probe"],
        { DATABASE_URL: "postgres://unused" },
        { dial, store },
      );
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([
      `${JSON.stringify({ probe: true, archived: 0, carriers: 0, rows: 0, tags: [] })}\n`,
    ]);
  });
});

describe("sweepArchivedTags", () => {
  async function rig() {
    const dial = new FixtureChaosDial();
    const store = new FixtureTagStore();
    const a1 = await mintNote(dial, "F:\\OneDrive :: a.c", true);
    const a2 = await mintNote(dial, "F:\\OneDrive :: b.xlsx", true);
    const a3 = await mintNote(dial, "F:\\OneDrive :: clean.txt", true);
    const live = await mintNote(dial, "Journal/2026-08-22.md", false);
    // The standing rows, as the pre-fix hook left them: inline junk on the
    // archived notes, an explicit folder tag beside one, and a live note's
    // own inline tag that must survive.
    await reconcileNoteTags(dial, SCOPE, store, a1, {
      inline: ["#include", "#ifdef"],
      explicit: ["#homelab"],
    });
    await reconcileNoteTags(dial, SCOPE, store, a2, {
      inline: ["#div/0", "#n/a"],
    });
    await reconcileNoteTags(dial, SCOPE, store, live, {
      inline: ["#n/a"],
      explicit: ["#journal"],
    });
    return { dial, store, a1, a2, a3, live };
  }

  it("probe reports the archived carriers and writes nothing", async () => {
    const { dial, store, a1, a2 } = await rig();
    const report = await sweepArchivedTags(dial, SCOPE, store, true);
    expect(report).toEqual({
      archived: 3,
      carriers: 2,
      rows: 4,
      tags: ["#div/0", "#ifdef", "#include", "#n/a"],
    });
    expect((await store.byNode(a1)).map((r) => r.tag)).toEqual([
      "#homelab",
      "#ifdef",
      "#include",
    ]);
    expect((await store.byNode(a2)).length).toBe(2);
  });

  it("apply removes the inline rows and edges, keeps explicit rows and live notes", async () => {
    const { dial, store, a1, a2, a3, live } = await rig();
    const report = await sweepArchivedTags(dial, SCOPE, store);
    expect(report.rows).toBe(4);

    expect(await store.byNode(a1)).toEqual([
      { tag: "#homelab", source: "explicit" },
    ]);
    expect(await store.byNode(a2)).toEqual([]);
    expect(await store.byNode(a3)).toEqual([]);
    const tagsOf = async (id: string) =>
      (await dial.edges(id))
        .filter((e) => e.predicate === "hasTag")
        .map((e) => e.value)
        .sort();
    expect(await tagsOf(a1)).toEqual(["#homelab"]);
    expect(await tagsOf(a2)).toEqual([]);
    // The live note is not the sweep's business — junk or not.
    expect((await store.byNode(live)).map((r) => r.tag).sort()).toEqual([
      "#journal",
      "#n/a",
    ]);
    expect(await tagsOf(live)).toEqual(["#journal", "#n/a"]);

    // Idempotent: a second sweep finds no carriers.
    expect(await sweepArchivedTags(dial, SCOPE, store)).toEqual({
      archived: 3,
      carriers: 0,
      rows: 0,
      tags: [],
    });
  });
});
