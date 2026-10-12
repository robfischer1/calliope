/**
 * Dispatch 283 — every calliope verb's advertised input schema is closed,
 * described and handler-true, held by the stellar-core-ts schematest kit over a
 * real MCP session, a fresh seeded server per call. The desktop's path-body
 * verbs are served here too, so the kit covers every verb calliope has.
 */
import { describe, expect, it } from "vitest";
import { runKit, refusalOf } from "@forge/stellar-core-ts/schematest";
import type { CallResult, Case } from "@forge/stellar-core-ts/schematest";
import { FixtureBlobGc, FixtureBlobStore } from "../src/blob-store.js";
import { FixtureChaosDial, TENANTS } from "../src/chaos-client.js";
import { writeContainer } from "../src/container-write.js";
import { FixtureBodyClient } from "../src/fixture-client.js";
import { FocusRegister } from "../src/focus-register.js";
import { createNote } from "../src/mcp/tools.js";
import { createServer } from "../src/mcp/server.js";
import { FixtureRevisionStore } from "../src/revision-store.js";
import { FixtureTagStore } from "../src/tag-store.js";

const POINTER = {
  kind: "body" as const,
  node: "n1",
  section: "s1",
  offsetFrom: 0,
  offsetTo: 5,
  text: "hello",
  ts: "2026-10-07T00:00:00Z",
};

const BODY = "n1";

/** A fresh world: one note with one block, one path body with one section,
 *  one archived revision, one focus pin. Every id it mints is deterministic. */
async function world() {
  const dial = new FixtureChaosDial();
  const blobs = new FixtureBlobStore();
  const tags = new FixtureTagStore();
  const created = await createNote(dial, "notes", { title: "Seed" }, tags);
  const note = (created as { node_id: string }).node_id;
  await writeContainer(
    { blobs, dial },
    note,
    [{ op: "add", text: "alpha #beta", position: "a0" }],
    "notes",
  );
  const client = new FixtureBodyClient();
  await client.saveBody(BODY, [{ text: "one" }]);
  const body = await client.readBody(BODY);
  const revisions = new FixtureRevisionStore();
  await revisions.importRevision({
    id: 1,
    schema_type: "FileRevision",
    repo: "vault",
    commit_sha: "c".repeat(40),
    file_path: "a.md",
    prior_file_path: null,
    change_type: "modify",
    authorship: "ai",
    summary: null,
    summary_model: null,
    summary_generated_at: null,
    git_blob_sha: "bd9587b0",
    parent_blob_sha: null,
    captured_at: "2026-05-27T10:39:48.080Z",
  });
  const focus = new FocusRegister();
  focus.set(POINTER, "2026-10-07T00:00:01Z");
  focus.pin("pin-1", POINTER, "2026-10-07T00:00:02Z");
  const server = createServer(client, {
    pathBodies: true,
    chaos: { dial, scope: "notes" },
    containers: { blobs, dial, gc: new FixtureBlobGc(blobs) },
    tags,
    revisions,
    focus,
  });
  return { server, note, body };
}

/** World answers: the call was well-formed and the world said no (no such
 *  note; a replacement's expected_count against the text it met). */
const WORLD = new Set(["not_found", "count_mismatch"]);

function refused(r: CallResult): boolean {
  return r.isError === true && !WORLD.has(refusalOf(r).code ?? "");
}

/** The i-th distinct note token, for bounding the id lists. */
const token = (i: number): string => i.toString(16).padStart(64, "f");

const NOTE = "0".repeat(63) + "2";
const SLOT = "0".repeat(63) + "3";
const SESSION =
  "spiffe://notusmi.com/session/00000000-0000-4000-8000-000000000000";

const CASES: Record<string, Case> = {
  read_body: { valid: { node_id: BODY } },
  write_body: {
    valid: { node_id: BODY, sections: [{ text: "two" }] },
    alternates: [
      {
        node_id: BODY,
        sections: [{ text: "two" }],
        authored_by: SESSION,
        kafka_offset: 3,
      },
    ],
  },
  apply_section_ops: {
    valid: {
      node_id: BODY,
      ops: [{ op: "add", text: "two", order_key: "b0" }],
    },
    alternates: [
      {
        node_id: BODY,
        ops: [
          {
            op: "update",
            section_id: `${BODY}#0`,
            text: "uno",
            order_key: "c0",
          },
        ],
        authored_by: SESSION,
        kafka_offset: 3,
      },
      { node_id: BODY, ops: [{ op: "delete", section_id: `${BODY}#0` }] },
      {
        node_id: BODY,
        ops: [{ op: "reorder", section_id: `${BODY}#0`, order_key: "d0" }],
      },
    ],
  },
  read_body_revisions: { valid: { node_id: BODY, limit: 5 } },
  read_body_at: { valid: { node_id: BODY, revision: "2026-10-07T00:00:00Z" } },
  has_body: { valid: { node_ids: [BODY] } },
  search: {
    valid: { query: "alpha" },
    alternates: [{ query: "alpha", scope: "", k: 20 }],
  },
  file_revisions: {
    valid: {},
    alternates: [{ id: 1, file_path: "a.md", repo: "vault", limit: 10 }],
  },
  revision_deltas: { valid: { revision_id: 1 } },
  look: { valid: {} },
  unpin: { valid: { pin_id: "pin-1" } },
  dissolve_note: {
    valid: { source_path: "Brain Soup/Idea.md", blocks: [{ text: "# Idea" }] },
    alternates: [
      {
        source_path: "Brain Soup/Idea.md",
        blocks: [{ text: "# Idea" }],
        title: "Idea",
        source_kind: "vault-note",
        schema_type: "Note",
        file_path: "/vault/Brain Soup/Idea.md",
        mtime: "2026-10-07T00:00:00Z",
        ctime: "2026-10-07T00:00:00Z",
        raw_hash: "abc",
      },
    ],
  },
  export_note: {
    valid: { container_id: NOTE },
    alternates: [{ source_path: "Seed" }],
  },
  materialize_note: {
    valid: { container_id: NOTE },
    alternates: [{ source_path: "Seed" }],
  },
  create_note: {
    valid: { title: "Another" },
    alternates: [{ title: "Tagged", parent: NOTE, tags: ["x"], type: "Plan" }],
  },
  copy_reference: { valid: { node_id: NOTE } },
  delete_note: {
    valid: { ids: [NOTE] },
    alternates: [{ ids: [NOTE], dry_run: false, purge: true }],
    distinct: { ids: token },
  },
  restore_note: { valid: { ids: [NOTE] }, distinct: { ids: token } },
  list_by_tag: {
    valid: { tag: "beta" },
    alternates: [{ tag: "beta", include_suppressed: true }],
  },
  list_tags: { valid: {} },
  set_properties: {
    valid: {
      container_id: NOTE,
      properties: [{ predicate: "status", values: [{ literal: "open" }] }],
    },
    alternates: [
      {
        container_id: NOTE,
        properties: [{ predicate: "related", values: [{ node: NOTE }] }],
        tags: ["x"],
        frontmatter: "status: open",
        retract: true,
      },
    ],
  },
  write_container: {
    valid: {
      container: NOTE,
      ops: [{ op: "add", text: "gamma", position: "b0" }],
    },
    alternates: [
      {
        container: NOTE,
        slot: SLOT,
        replacements: [{ find: "alpha", replace: "delta", expected_count: 1 }],
        tenant: "notes",
      },
      {
        container: NOTE,
        ops: [{ op: "update", slot: SLOT, oldBlobId: "1", text: "new" }],
      },
      {
        container: NOTE,
        ops: [{ op: "reorder", slot: SLOT, oldPosition: "a0", position: "c0" }],
      },
      {
        container: NOTE,
        ops: [{ op: "remove", slot: SLOT, position: "a0", blobId: "1" }],
      },
    ],
    vocab: { tenant: TENANTS },
  },
  read_container: {
    valid: { container: NOTE },
    alternates: [{ container: NOTE, as_of_tx: 1 }],
  },
  container_history: { valid: { container: NOTE } },
  blob_census: { valid: {}, alternates: [{ execute: true }] },
};

describe("dispatch 283 — calliope's typed input schemas", () => {
  it("seeds the ids the cases name", async () => {
    const { note, body } = await world();
    expect(note).toBe(NOTE);
    expect(body.map((s) => s.id)).toEqual([`${BODY}#0`]);
  });

  it("holds every verb's advertised schema to its handler (schematest)", async () => {
    const findings = await runKit({
      server: async () => (await world()).server,
      cases: CASES,
      refused,
    });
    expect(findings).toEqual([]);
  }, 120_000);
});
