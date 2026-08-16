/**
 * The search seam (Findability F2/F11) — the TYPES only, extracted when F14
 * deleted the fs-search implementation. Any backend implements
 * {@link SearchProvider}: the fleet routes to eros (`eros-provider.ts`),
 * the desktop serves FTS from the local engine (`local-store.ts`). The
 * degradation contract is unchanged: a dark arm is NAMED in the envelope,
 * never thrown (docs/search-architecture.md).
 */

export type SearchArm = "fts" | "semantic" | "eros";

export interface SearchHit {
  id: string;
  snippet: string;
  score: number;
  arms: SearchArm[];
}

export interface SearchResponse {
  hits: SearchHit[];
  armsQueried: SearchArm[];
  armsDark: SearchArm[];
}

/** F11 — one mention (linked or unlinked candidate). */
export interface Mention {
  id: string;
  snippet: string;
}

/** F11 — the mentions answer: true linked mentions + unlinked candidates. */
export interface MentionsResponse {
  linked: Mention[];
  unlinked: Mention[];
}

/** The seam server.ts consumes (any backend can implement it). */
export interface SearchProvider {
  search(query: string, scope?: string, k?: number): Promise<SearchResponse>;
}
