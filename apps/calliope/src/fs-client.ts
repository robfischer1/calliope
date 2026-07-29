/**
 * The filesystem {@link BodyClient} — the fourth implementation of the proven
 * interface (G2 of the Grace plan): a directory IS the store, a root-relative
 * path IS the node identity, a markdown file IS a body.
 *
 * A file derives as exactly ONE section (the 0.14 de-inference pass: the
 * block grain is USER-determined, so the old blank-line chunker — every
 * `"\n\n"` a section — is gone; a note is one block until the user splits
 * it in the editor). Line endings normalize to LF (matching the editor's
 * own markdown normalization; a raw `\r\n` baseline is text the serializer
 * can never emit, so a CRLF doc sat permanently dirty), and a CRLF file's
 * first real save lands as LF — deliberate, like the serializer's own
 * normalization. An unmodified LF read → save round trip is byte-lossless.
 *
 * Section identity is generational: `sha256(fileBytes):0`. Every external
 * change churns the id, which is exactly the staleness signal the editor's
 * compare-before-write (durability) consumes — the whole conflict model
 * rides the existing contract.
 *
 * `applySectionOps` is deliberately ABSENT: files have no durable section
 * identity for fine-grained ops to anchor on, and the old implementation
 * was built on the premise that derived sections cannot contain the
 * separator — false the moment derivation stopped splitting. The editor's
 * durable path degrades to the honest whole-body compare-and-write.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BodyClient, Section, SectionInput } from "./types.js";
import { sequence } from "./order-key.js";

/** The editor's block separator (aglaia BLOCK_SEP) — the JOIN seam only:
 *  a multi-block save writes blocks joined; reads never split on it. */
const SECTION_SEP = "\n\n";

/** Extensions the body layer serves; everything else is not a body. */
const SERVED_EXTENSIONS = new Set([".md", ".markdown"]);

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Derive a file's body: exactly ONE section carrying the whole normalized
 *  text (the user grain — no inferred chunking). Line endings normalize to
 *  LF exactly as markdown-it does (`\r\n` and lone `\r`), so the derived
 *  text is always text the editor can serialize back. The generation id
 *  keeps hashing the RAW bytes — any external rewrite still churns it. */
function derive(bytes: Buffer): Section[] {
  const text = bytes.toString("utf8").replace(/\r\n?/g, "\n");
  if (text === "") return [];
  const generation = hashOf(bytes);
  const orderKey = sequence(1)[0];
  if (orderKey === undefined) {
    throw new Error("unreachable: sequence(1) yielded no key");
  }
  return [{ id: `${generation}:0`, text, orderKey }];
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
      const head = fresh[Math.min(index, fresh.length - 1)];
      if (head === undefined) {
        throw new Error(
          `stale_section: node ${nodeId} has no body after the edit.`,
        );
      }
      return head;
    });
  }
}
