import type { LibraryItem, MediaAddedBy, RequestedLibraryItem } from "@/api/types";
import { normalizeTitle } from "@/features/library/library-entries";

export type { MediaAddedBy };

export interface TitleIdentity {
  kind: "movie" | "series";
  /** Present when the detail route knows the provider ids. */
  tmdbId?: number;
  tvdbId?: number;
  title: string;
  year?: number;
}

interface Candidate {
  tmdbId?: number | undefined;
  tvdbId?: number | undefined;
  title: string | undefined;
  year: number | undefined;
  addedBy?: MediaAddedBy | undefined;
}

/**
 * Who added this title, matched against the library and requested-title lists.
 * The detail routes do not carry attribution, and those two lists are already
 * cached by the library page under the same query keys, so this costs nothing
 * extra.
 *
 * Provider ids win; when either side lacks them we fall back to a normalised
 * title plus a year within one (series are often re-tagged a year later).
 */
export function findTitleAttribution(
  identity: TitleIdentity,
  lists: {
    library?: LibraryItem[] | undefined;
    requested?: RequestedLibraryItem[] | undefined;
    /** Playable titles prefer the library entry, requests prefer the arr list. */
    playable: boolean;
  },
): MediaAddedBy | undefined {
  const library = (lists.library ?? [])
    .filter((item) => (identity.kind === "movie" ? item.type === "Movie" : item.type === "Series"))
    .map<Candidate>((item) => ({
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      title: item.name,
      year: item.year,
      addedBy: item.addedBy,
    }))
    .filter((candidate) => candidate.addedBy !== undefined);
  const requested = (lists.requested ?? [])
    .filter((item) => item.kind === identity.kind)
    .map<Candidate>((item) => ({
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      title: item.title,
      year: item.year,
      addedBy: item.addedBy,
    }))
    .filter((candidate) => candidate.addedBy !== undefined);

  const ordered = lists.playable ? [library, requested] : [requested, library];
  for (const candidates of ordered) {
    const match = bestMatch(identity, candidates);
    if (match?.addedBy) {
      return match.addedBy;
    }
  }
  return undefined;
}

function bestMatch(identity: TitleIdentity, candidates: Candidate[]): Candidate | undefined {
  const providerMatch = candidates.find((candidate) => providersMatch(identity, candidate));
  if (providerMatch) {
    return providerMatch;
  }
  const wanted = normalizeTitle(identity.title);
  if (!wanted) {
    return undefined;
  }
  return candidates.find((candidate) => {
    if (!candidate.title || normalizeTitle(candidate.title) !== wanted) {
      return false;
    }
    if (identity.year === undefined || candidate.year === undefined) {
      return true;
    }
    return identity.kind === "movie"
      ? candidate.year === identity.year
      : Math.abs(candidate.year - identity.year) <= 1;
  });
}

function providersMatch(identity: TitleIdentity, candidate: Candidate): boolean {
  if (identity.kind === "movie") {
    return (
      identity.tmdbId !== undefined &&
      candidate.tmdbId !== undefined &&
      identity.tmdbId === candidate.tmdbId
    );
  }
  if (identity.tvdbId !== undefined && candidate.tvdbId !== undefined) {
    return identity.tvdbId === candidate.tvdbId;
  }
  return (
    identity.tmdbId !== undefined &&
    candidate.tmdbId !== undefined &&
    identity.tmdbId === candidate.tmdbId
  );
}
