/**
 * The filesystem {@link BodyClient} — the fourth implementation of the proven
 * interface (G2 of the Grace plan): a directory IS the store, a root-relative
 * path IS the node identity, a markdown file IS a body.
 *
 * Sections are DERIVED deterministically from file content: the text split on
 * the editor's own block separator (`"\n\n"` — aglaia's BLOCK_SEP). Split and
 * join on one separator are an identity, so an unmodified read → save round
 * trip is byte-lossless by construction; a CRLF file simply has no boundary
 * and reads as one coarse section (degradation, never corruption).
 *
 * Section identity is generational: `sha256(fileBytes):index`. Every external
 * change churns every id, which is exactly the staleness signal the editor's
 * compare-before-write (durability) and the interface's `stale_section:`
 * reject consume — the whole conflict model rides the existing contract.
 *
 * The derivation invariant (binding, tested): {@link applySectionOps} returns
 * exactly what the next {@link readBody} of the written file returns — ids and
 * order keys are re-derived post-write, never carried forward.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  AppliedOp,
  ApplySectionOpsResult,
  BodyClient,
  Section,
  SectionInput,
  SectionOp,
} from "./types.js";
import { compareKeys, sequence } from "./order-key.js";

/** The editor's block separator (aglaia BLOCK_SEP) — the derivation seam. */
const SECTION_SEP = "\n\n";

/** Extensions the body layer serves; everything else is not a body. */
const SERVED_EXTENSIONS = new Set([".md", ".markdown"]);

/** A derived section plus the working mutation state applySectionOps uses. */
interface WorkingSection {
  id: string;
  text: string;
  orderKey: string;
}

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Derive the canonical section list for a file's bytes. */
function derive(bytes: Buffer): Section[] {
  const text = bytes.toString("utf8");
  if (text === "") return [];
  const generation = hashOf(bytes);
  const parts = text.split(SECTION_SEP);
  const keys = sequence(parts.length);
  return parts.map((part, i) => {
    const orderKey = keys[i];
    if (orderKey === undefined) {
      throw new Error("unreachable: sequence(n) yielded fewer than n keys");
    }
    return { id: `${generation}:${String(i)}`, text: part, orderKey };
  });
}

export class FsBodyClient implements BodyClient {
  readonly #root: string;
  /** Per-path write serialization: the tail of each path's op chain. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** The absolute served root (the sidecar's /health reports it). */
  get root(): string {
    return this.#root;
  }

  /** Resolve a node id to an absolute path inside the root, or throw. */
  #resolve(nodeId: string): string {
    if (nodeId === "" || nodeId.includes("\0")) {
      throw new Error(`invalid_path: empty or malformed node id.`);
    }
    const ext = path.posix.extname(nodeId.toLowerCase());
    if (!SERVED_EXTENSIONS.has(ext)) {
      throw new Error(
        `unsupported_file: ${nodeId} is not a markdown body (.md/.markdown).`,
      );
    }
    const abs = path.resolve(this.#root, nodeId);
    const rel = path.relative(this.#root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`invalid_path: ${nodeId} escapes the served root.`);
    }
    return abs;
  }

  /** Serialize async work per path — writes must never interleave. */
  #serialized<T>(abs: string, work: () => Promise<T>): Promise<T> {
    const tail = this.#locks.get(abs) ?? Promise.resolve();
    const next = tail.then(work, work);
    this.#locks.set(
      abs,
      next.catch(() => undefined),
    );
    return next;
  }

  async #readBytes(abs: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Atomic write: temp file in the same directory, then rename over. */
  async #writeAtomic(abs: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(
      path.dirname(abs),
      `.calliope-tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, abs);
  }

  async readBody(nodeId: string): Promise<Section[]> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const bytes = await this.#readBytes(abs);
      return bytes === null ? [] : derive(bytes);
    });
  }

  async saveBody(nodeId: string, sections: SectionInput[]): Promise<void> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const text = sections.map((s) => s.text).join(SECTION_SEP);
      await this.#writeAtomic(abs, text);
    });
  }

  async editSection(
    nodeId: string,
    sectionId: string,
    text: string,
  ): Promise<Section> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const bytes = await this.#readBytes(abs);
      const current = bytes === null ? [] : derive(bytes);
      const index = current.findIndex((s) => s.id === sectionId);
      if (index < 0) {
        throw new Error(
          `stale_section: section ${sectionId} is not part of node ${nodeId}.`,
        );
      }
      const texts = current.map((s) => s.text);
      texts[index] = text;
      await this.#writeAtomic(abs, texts.join(SECTION_SEP));
      const rewritten = await this.#readBytes(abs);
      const fresh = rewritten === null ? [] : derive(rewritten);
      // Sections before the edit are derived splits and cannot contain the
      // separator, so the edit's head sits at the same index post-derive.
      const head = fresh[Math.min(index, fresh.length - 1)];
      if (head === undefined) {
        throw new Error(
          `stale_section: node ${nodeId} has no body after the edit.`,
        );
      }
      return head;
    });
  }

  async applySectionOps(
    nodeId: string,
    ops: SectionOp[],
  ): Promise<ApplySectionOpsResult> {
    const abs = this.#resolve(nodeId);
    return this.#serialized(abs, async () => {
      const bytes = await this.#readBytes(abs);
      const current = bytes === null ? [] : derive(bytes);
      const working: WorkingSection[] = current.map((s) => ({ ...s }));
      const byId = new Map(working.map((s) => [s.id, s]));

      // Batch rules: every referenced id must be a CURRENT section, and at
      // most one op may touch a given section — any violation rejects whole.
      const touched = new Set<string>();
      for (const op of ops) {
        if (op.op === "add") continue;
        const target = byId.get(op.sectionId);
        if (target === undefined) {
          throw new Error(
            `stale_section: section ${op.sectionId} is not part of node ${nodeId}.`,
          );
        }
        if (touched.has(op.sectionId)) {
          throw new Error(
            `stale_section: section ${op.sectionId} was consumed earlier in the batch.`,
          );
        }
        touched.add(op.sectionId);
      }

      // Apply in memory. Op order keys place adds/moves; the final body is the
      // key-sorted working set. Deletions leave the set entirely.
      const additions: WorkingSection[] = [];
      const deleted = new Set<string>();
      for (const op of ops) {
        if (op.op === "add") {
          additions.push({ id: "", text: op.text, orderKey: op.orderKey });
        } else if (op.op === "update") {
          const target = byId.get(op.sectionId);
          if (target === undefined) continue; // unreachable post-validation
          target.text = op.text;
          if (op.orderKey !== undefined) target.orderKey = op.orderKey;
        } else if (op.op === "delete") {
          deleted.add(op.sectionId);
        } else {
          const target = byId.get(op.sectionId);
          if (target === undefined) continue; // unreachable post-validation
          target.orderKey = op.orderKey;
        }
      }
      const survivors = working
        .filter((s) => !deleted.has(s.id))
        .concat(additions)
        .sort((a, b) => compareKeys(a.orderKey, b.orderKey));

      const text = survivors.map((s) => s.text).join(SECTION_SEP);
      await this.#writeAtomic(abs, text);

      // Re-derive: the result IS the next readBody (the derivation invariant).
      const rewritten = await this.#readBytes(abs);
      const fresh = rewritten === null ? [] : derive(rewritten);

      // Per-op alignment: map each op to its section's post-apply derived row.
      // An op's text may itself contain the separator and re-split; derived
      // originals cannot (they came from a split). The exact fresh index of a
      // survivor's head is the running sum of its predecessors' split counts.
      const headIndex = new Map<WorkingSection, number>();
      let acc = 0;
      for (const s of survivors) {
        headIndex.set(s, acc);
        acc += s.text.split(SECTION_SEP).length;
      }
      const rowFor = (probe: (s: WorkingSection) => boolean): AppliedOp => {
        const survivor = survivors.find(probe);
        const idx =
          survivor === undefined ? -1 : (headIndex.get(survivor) ?? -1);
        const row = idx >= 0 ? fresh[idx] : undefined;
        return row === undefined
          ? { id: "", orderKey: "" }
          : { id: row.id, orderKey: row.orderKey };
      };
      const applied: AppliedOp[] = ops.map((op) => {
        if (op.op === "delete") {
          const was = byId.get(op.sectionId);
          return { id: op.sectionId, orderKey: was?.orderKey ?? "" };
        }
        if (op.op === "add") {
          return rowFor((s) => s.id === "" && s.text === op.text);
        }
        return rowFor((s) => s.id === op.sectionId);
      });

      return { sections: fresh, applied };
    });
  }
}
