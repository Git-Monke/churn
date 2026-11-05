import { entryTitle, type LibraryEntry } from "@/features/library/library-entries";

/**
 * Frontend-only library search. Titles are matched by default, but the year,
 * network, rating and overview are searchable too so "2021", "hbo" or "spiders"
 * narrow the grid without leaving the page.
 */
export function searchLibraryEntries(
  entries: LibraryEntry[],
  query: string,
): LibraryEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return entries;
  }

  const scored: { entry: LibraryEntry; rank: number }[] = [];
  for (const entry of entries) {
    const titleTokens = tokenize(entryTitle(entry));
    const titleHit = tokens.every((token) => matches(titleTokens, token));
    if (!titleHit) {
      const haystack = [...titleTokens, ...tokenize(otherFields(entry))];
      if (!tokens.every((token) => matches(haystack, token))) {
        continue;
      }
    }
    scored.push({ entry, rank: titleHit ? 0 : 1 });
  }

  // Stable sort: title hits come first, the grid's existing activity/library
  // ordering survives inside each group.
  return scored.sort((left, right) => left.rank - right.rank).map((hit) => hit.entry);
}

function otherFields(entry: LibraryEntry): string {
  const year = entry.library?.year ?? entry.requested?.year ?? entry.activity?.year;
  return [
    year === undefined ? "" : String(year),
    entry.library?.officialRating,
    entry.library?.rating ?? entry.requested?.rating ?? entry.activity?.rating,
    entry.requested?.network,
    entry.activity?.network,
    entry.library?.overview,
    entry.requested?.overview,
    entry.activity?.overview,
  ]
    .filter((value) => value !== undefined && value !== "")
    .join(" ");
}

function matches(haystack: string[], token: string): boolean {
  return haystack.some((candidate) => candidate.includes(token));
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
