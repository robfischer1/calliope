/**
 * The inbound rule set, read from the star's composed orbit sidecar. The TS
 * peer of stellar-core-go `policy/acl.go`.
 *
 * Only `[[produces]]` matters: it names who calls THIS star. `[[consumes]]`
 * describes calliope's own outbound dials and is not read.
 */

import { readFileSync } from "node:fs";
import { parseToml, TomlError } from "./toml.js";
import type { TomlTable, TomlValue } from "./toml.js";

/** The one contract status enforcement may stand on. A `generated` contract is
 *  a baseline authored from the witnessed graph, never a target. */
export const STATUS_APPROVED = "approved";

/** The sidecar file does not exist, as distinct from one that is broken. */
export class NoSidecarError extends Error {
  constructor(star: string, path: string) {
    super(`${star}: ${path}: orbit sidecar absent`);
    this.name = "NoSidecarError";
  }
}

/** One inbound grant: `consumer` may call `verbs` on this star, under `contract`. */
export interface AclEntry {
  readonly consumer: string;
  readonly contract: string;
  readonly version: string;
  readonly status: string;
  readonly verbs: ReadonlySet<string>;
}

/** A star's inbound rule set, keyed by consumer so the hot path is one lookup. */
export class Acl {
  constructor(
    readonly star: string,
    private readonly entries: ReadonlyMap<string, AclEntry>,
  ) {}

  entry(consumer: string): AclEntry | undefined {
    return this.entries.get(consumer);
  }

  /** Whether `consumer`'s grant is approved; a consumer with no grant is not. */
  approved(consumer: string): boolean {
    return this.entries.get(consumer)?.status === STATUS_APPROVED;
  }

  /** The number of declared consumers. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether every entry is approved (an empty set is vacuously so). */
  allApproved(): boolean {
    return [...this.entries.values()].every(
      (e) => e.status === STATUS_APPROVED,
    );
  }
}

function text(
  star: string,
  block: number,
  table: TomlTable,
  key: string,
  required: boolean,
): string {
  const v: TomlValue | undefined = table.get(key);
  if (v === undefined) {
    if (required) throw missing(star, block);
    return "";
  }
  if (typeof v !== "string") {
    throw new Error(
      `${star}: produces block ${String(block)}: '${key}' is not a string`,
    );
  }
  if (required && v === "") throw missing(star, block);
  return v;
}

function missing(star: string, block: number): Error {
  return new Error(
    `${star}: produces block ${String(block)} is missing 'to' or 'contract'`,
  );
}

function verbsOf(star: string, block: number, table: TomlTable): Set<string> {
  const v = table.get("verbs");
  if (v === undefined) return new Set();
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(
      `${star}: produces block ${String(block)}: 'verbs' is not a list of strings`,
    );
  }
  return new Set(v);
}

/**
 * Parse a composed sidecar into `star`'s inbound rule set. It never degrades: a
 * document that does not decode, a block missing `to` or `contract`, a verb
 * list that is not strings, a wrong-typed field, or two blocks for one consumer
 * throws, because an ACL that quietly loses a grant would read, once enforced,
 * as a refusal nobody declared.
 */
export function parseAcl(star: string, raw: string): Acl {
  let doc;
  try {
    doc = parseToml(raw);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new Error(`${star}: orbit sidecar does not parse: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
  if (doc.plainTables.has("produces")) {
    throw new Error(
      `${star}: orbit sidecar does not parse: 'produces' is a table, not an array`,
    );
  }
  const entries = new Map<string, AclEntry>();
  (doc.arrays.get("produces") ?? []).forEach((block, i) => {
    const consumer = text(star, i, block, "to", true);
    const contract = text(star, i, block, "contract", true);
    if (entries.has(consumer)) {
      throw new Error(
        `${star}: two produces blocks name consumer "${consumer}"`,
      );
    }
    entries.set(consumer, {
      consumer,
      contract,
      version: text(star, i, block, "version", false),
      status: text(star, i, block, "status", false),
      verbs: verbsOf(star, i, block),
    });
  });
  return new Acl(star, entries);
}

/** Read and parse the sidecar at `path`. An absent file is {@link NoSidecarError};
 *  every other fault is the read's or {@link parseAcl}'s. */
export function loadAcl(star: string, path: string): Acl {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NoSidecarError(star, path);
    }
    throw new Error(
      `${star}: orbit sidecar ${path} is unreadable: ${String(err)}`,
      {
        cause: err,
      },
    );
  }
  return parseAcl(star, raw);
}
