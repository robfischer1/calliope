/**
 * Plan block-addressing — the C7 projection scheme.
 *
 * A dissolved plan lives in the document store as one `documents` row whose
 * `body_text` is the plan's markdown. A plan's prose is a sequence of *feature
 * blocks* under a `# Feature list` — each block a heading of the form
 * `### FN — <title> · <Size>` (the grammar athena's `orchestrate_plan` parses).
 * C7 makes those blocks *addressable*: athena carries a block handle (a Calliope
 * reference), and Calliope moves the bytes — the projecting session never loads
 * the whole `plan_text`, and the projecter's conflict payload can name a single
 * colliding feature by its block ref.
 *
 * This module is the pure block-addressing core: it parses a plan body into
 * {@link PlanBlock}s and slices one block by its id. No I/O, no store — the
 * verb layer ({@link ./mcp/plan-ingest}) resolves the document, this addresses
 * the blocks. Pure so it is unit-tested directly and cannot drift from the wire.
 *
 * ## The block-addressing scheme
 *
 * - **Feature-head grammar** (a superset of the conventions in the wild —
 *   `### FN —`, `## FN —`, `#### FN —`, `### Feature N —`): a heading at depth
 *   2–4, an optional `Feature ` word, then a **feature-id token** — one to six
 *   letters immediately followed by digits (`C7`, `F25`, `H1`, `E1`) — then a
 *   dash separator (`—`, `–`, or `-`). The id token is the block's **address**;
 *   it is normalized to upper-case for the canonical handle, and looked up
 *   case-insensitively.
 * - **Block extent**: a block runs from its heading line to the next heading
 *   whose depth is `<=` the block heading's depth (the next sibling feature, or
 *   a structural section such as `## Cross-feature DAG` that ends the list), or
 *   to end-of-document. Deeper sub-headings stay inside the block.
 * - **Size**: the trailing `· <token>` of the heading, when `<token>` is a size
 *   (`XS` `S` `M` `L` `XL`); otherwise `null`. The title is the heading text
 *   between the dash and that size marker.
 */

/** One addressable feature block within a plan document. */
export interface PlanBlock {
  /** The canonical block address — the feature-id token, upper-cased (`C7`). */
  id: string;
  /** The heading title (between the dash separator and the `· Size` marker). */
  title: string;
  /** The size marker (`XS`|`S`|`M`|`L`|`XL`) when present, else `null`. */
  size: string | null;
  /** The heading depth (2–4). */
  level: number;
  /** 0-indexed position of this block among the plan's feature blocks. */
  order: number;
  /** 0-indexed line where the block's heading starts. */
  lineStart: number;
  /** Exclusive 0-indexed line where the block ends (next boundary / EOF). */
  lineEnd: number;
  /** The block's verbatim markdown (heading line through its body). */
  text: string;
}

/** A heading line the scanner found: its depth and 0-indexed line. */
interface HeadingLine {
  level: number;
  line: number;
}

/**
 * The feature-head grammar. Depth 2–4, optional `Feature ` word, a feature-id
 * token (1–6 letters immediately followed by digits), then a dash separator.
 * Capture 1 = the hashes (depth), capture 2 = the id token, capture 3 = the
 * remainder (title + optional `· Size`).
 */
const FEATURE_HEAD =
  /^(#{2,4})\s+(?:Feature\s+)?([A-Za-z]{1,6}\d+)\s*[—–-]\s*(.*)$/;

/** Any ATX heading — used to bound a block at the next same-or-higher heading. */
const ANY_HEAD = /^(#{1,6})\s+\S/;

const SIZE_TOKEN = /^(XS|S|M|L|XL)$/i;

/** Split a feature heading's remainder into `{ title, size }`. */
function splitTitleAndSize(remainder: string): {
  title: string;
  size: string | null;
} {
  const parts = remainder.split("·");
  if (parts.length > 1) {
    const tail = (parts.at(-1) ?? "").trim();
    if (SIZE_TOKEN.test(tail)) {
      return {
        title: parts.slice(0, -1).join("·").trim(),
        size: tail.toUpperCase(),
      };
    }
  }
  return { title: remainder.trim(), size: null };
}

/**
 * Parse a plan body into its addressable feature blocks, in document order.
 * A body with no feature-shaped headings yields `[]` (correctly "prose-only").
 */
export function parsePlanBlocks(body: string): PlanBlock[] {
  const lines = body.split("\n");

  // Every ATX heading, with its depth — the boundary set.
  const headings: HeadingLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = ANY_HEAD.exec(line);
    if (m?.[1] !== undefined) {
      headings.push({ level: m[1].length, line: i });
    }
  }

  const blocks: PlanBlock[] = [];
  let order = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = FEATURE_HEAD.exec(line);
    if (m === null) {
      continue;
    }
    const [, hashes, idToken, remainder] = m;
    if (hashes === undefined || idToken === undefined) continue;
    const level = hashes.length;
    const id = idToken.toUpperCase();
    const { title, size } = splitTitleAndSize(remainder ?? "");

    // The block ends at the next heading of depth <= this block's depth.
    const boundary = headings.find((h) => h.line > i && h.level <= level);
    const lineEnd = boundary === undefined ? lines.length : boundary.line;
    const text = lines.slice(i, lineEnd).join("\n").trim();

    blocks.push({
      id,
      title,
      size,
      level,
      order,
      lineStart: i,
      lineEnd,
      text,
    });
    order += 1;
  }
  return blocks;
}

/**
 * Slice one feature block out of a plan body by its address (case-insensitive).
 * Returns the {@link PlanBlock} or `null` when no such block exists. On the
 * (malformed) chance of a duplicate id, the first in document order wins.
 */
export function sliceBlock(body: string, blockId: string): PlanBlock | null {
  const want = blockId.trim().toUpperCase();
  return parsePlanBlocks(body).find((b) => b.id === want) ?? null;
}

/** The lightweight index entry for a block (address + metadata, no prose). */
export interface PlanBlockRef {
  id: string;
  title: string;
  size: string | null;
  order: number;
}

/** Project a {@link PlanBlock} to its index entry (the address, not the bytes). */
export function toBlockRef(block: PlanBlock): PlanBlockRef {
  return {
    id: block.id,
    title: block.title,
    size: block.size,
    order: block.order,
  };
}
