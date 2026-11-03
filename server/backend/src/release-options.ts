import type { CachedReleaseView } from "./release-cache.js";
import { releaseId, toReleaseGroups } from "./releases.js";
import type { CachedReleasesResponse } from "./types.js";

interface BuildCachedReleasesInput {
  kind: CachedReleasesResponse["kind"];
  service: CachedReleasesResponse["service"];
  targetId: number;
  seasonNumber?: number;
  view: CachedReleaseView;
}

/** Convert an internal cache view into the browser-facing release contract. */
export function buildCachedReleasesResponse(
  input: BuildCachedReleasesInput,
): CachedReleasesResponse {
  const releases = input.view.releases.map((entry) => entry.release);
  const groups = toReleaseGroups(releases, input.kind === "movie" ? "movie" : "series");
  const searchSeasons = new Map<string, number>();
  for (const entry of input.view.releases) {
    const id = releaseId(entry.release);
    if (id && entry.searchSeasonNumber !== undefined) {
      searchSeasons.set(id, entry.searchSeasonNumber);
    }
  }
  for (const group of groups) {
    for (const release of group.releases) {
      const season = searchSeasons.get(release.id);
      if (season !== undefined) {
        release.searchSeasonNumber = season;
      }
    }
  }
  const releaseCount = groups.reduce((total, group) => total + group.releases.length, 0);
  const state =
    input.view.lastError !== undefined && releaseCount === 0 && !input.view.refreshing
      ? "error"
      : input.view.searching || (input.view.refreshing && releaseCount === 0)
        ? "searching"
        : "ready";

  return {
    kind: input.kind,
    service: input.service,
    targetId: input.targetId,
    ...(input.seasonNumber !== undefined ? { seasonNumber: input.seasonNumber } : {}),
    state,
    refreshing: input.view.refreshing,
    ...(state === "error" && input.view.lastError ? { detail: input.view.lastError } : {}),
    ...(input.view.fetchedAt ? { fetchedAt: input.view.fetchedAt } : {}),
    releaseCount,
    groups,
  };
}
