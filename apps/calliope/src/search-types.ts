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
