/**
 * Reciprocal-rank fusion (Findability F2) — the degradation mechanism the
 * architecture ruling names: fusion over one ranked list IS that list, so a
 * one-arm response is honest by construction, never a fallback code path.
 * A hit ranked by k arms accumulates k reciprocal-rank contributions and
 * appears once, carrying every ranking arm (docs/search-architecture.md).
 */

export type SearchArm = "fts" | "semantic" | "eros";

export interface ArmEntry {
  /** The note identity (fs backend: root-relative path). */
  id: string;
  /** The arm's snippet offer for this hit, if it has one. */
  snippet?: string;
}

export interface ArmList {
  arm: SearchArm;
  /** Ranked best-first, already deduped per id within the arm. */
  entries: ArmEntry[];
}

export interface FusedHit {
  id: string;
  snippet: string;
  score: number;
  arms: SearchArm[];
}

/** The literature-default RRF constant (plan 033 Decision 6). */
export const RRF_K = 60;

/**
 * Fuse N ranked lists into one. With one list the output order equals its
 * order (1/(k+r) is strictly decreasing in r). Snippet preference: the first
 * arm in `lists` order that offered one — callers put the FTS arm first so
 * marked snippets win over semantic block heads.
 */
export function rrfFuse(lists: ArmList[], limit: number): FusedHit[] {
  const byId = new Map<string, FusedHit>();
  for (const list of lists) {
    list.entries.forEach((entry, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = byId.get(entry.id);
      if (existing === undefined) {
        byId.set(entry.id, {
          id: entry.id,
          snippet: entry.snippet ?? "",
          score: contribution,
          arms: [list.arm],
        });
      } else {
        existing.score += contribution;
        if (!existing.arms.includes(list.arm)) existing.arms.push(list.arm);
        if (existing.snippet === "" && entry.snippet !== undefined) {
          existing.snippet = entry.snippet;
        }
      }
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
