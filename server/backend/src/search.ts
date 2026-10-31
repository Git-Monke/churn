import type {
  ArrQualityProfile,
  ArrRootFolder,
  RequestMonitor,
  SearchResult,
} from "./types.js";
import type {
  ServarrMovieResource,
  ServarrQualityProfile,
  ServarrRootFolder,
  ServarrSeriesResource,
} from "./upstream/servarr.js";

const MEDIA_COVER_PATH = /^\/MediaCoverProxy\/[A-Za-z0-9]+\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i;

const PREFERRED_QUALITY_PROFILES = ["hd - 720p/1080p", "hd-1080p"];

export function isAllowedMediaCoverPath(value: string): boolean {
  return MEDIA_COVER_PATH.test(value);
}

/** Map an arr media-cover path to a backend-owned image URL. */
export function mediaCoverUrl(
  service: "sonarr" | "radarr",
  images: ServarrSeriesResource["images"],
): string | undefined {
  const poster = images?.find((image) => image.coverType === "poster" && image.url);
  if (!poster?.url || !isAllowedMediaCoverPath(poster.url)) {
    return undefined;
  }
  return `/api/search/images/${service}?path=${encodeURIComponent(poster.url)}`;
}

export function mapSeriesResource(
  resource: ServarrSeriesResource,
  inLibrary: boolean | null,
): SearchResult | null {
  if (!resource.title?.trim() || !resource.tvdbId) {
    return null;
  }
  const seasons = resource.seasons
    ?.filter((season) => Number.isInteger(season.seasonNumber))
    .map((season) => ({
      seasonNumber: season.seasonNumber,
      monitored: Boolean(season.monitored),
    }));

  return {
    key: `series:${resource.tvdbId}`,
    kind: "series",
    service: "sonarr",
    title: resource.title,
    year: resource.year,
    overview: resource.overview,
    rating: finiteNumber(resource.ratings?.value),
    certification: resource.certification,
    runtimeMinutes: finiteNumber(resource.runtime),
    genres: resource.genres,
    network: resource.network,
    tvdbId: resource.tvdbId,
    tmdbId: resource.tmdbId,
    imdbId: resource.imdbId,
    imageUrl: mediaCoverUrl("sonarr", resource.images),
    inLibrary,
    seasons,
  };
}

export function mapMovieResource(
  resource: ServarrMovieResource,
  inLibrary: boolean | null,
): SearchResult | null {
  if (!resource.title?.trim() || !resource.tmdbId) {
    return null;
  }
  return {
    key: `movie:${resource.tmdbId}`,
    kind: "movie",
    service: "radarr",
    title: resource.title,
    year: resource.year,
    overview: resource.overview,
    rating: finiteNumber(resource.ratings?.imdb?.value ?? resource.ratings?.tmdb?.value),
    certification: resource.certification,
    runtimeMinutes: finiteNumber(resource.runtime),
    genres: resource.genres,
    network: resource.studio,
    tmdbId: resource.tmdbId,
    imdbId: resource.imdbId,
    imageUrl: mediaCoverUrl("radarr", resource.images),
    inLibrary,
  };
}

/** Prefer the shared 720p/1080p profile, then 1080p, then the first profile. */
export function pickDefaultQualityProfile(
  profiles: ServarrQualityProfile[],
): ServarrQualityProfile | undefined {
  for (const preferred of PREFERRED_QUALITY_PROFILES) {
    const match = profiles.find((profile) => normalizeProfileName(profile.name) === preferred);
    if (match) {
      return match;
    }
  }
  return profiles[0];
}

export function pickDefaultRootFolder(
  folders: ServarrRootFolder[],
): ServarrRootFolder | undefined {
  return folders.find((folder) => folder.accessible) ?? folders[0];
}

export function toQualityProfiles(profiles: ServarrQualityProfile[]): ArrQualityProfile[] {
  return profiles.map((profile) => ({ id: profile.id, name: profile.name }));
}

export function toRootFolders(folders: ServarrRootFolder[]): ArrRootFolder[] {
  return folders.map((folder) => ({
    path: folder.path,
    accessible: folder.accessible,
    freeSpace: folder.freeSpace,
  }));
}

/**
 * Sonarr's `addOptions.monitor` value for each supported scope. `firstSeason`
 * means only season 1 is monitored for an existing show.
 */
export function arrMonitorName(monitor: RequestMonitor): string {
  return monitor;
}

export function monitorSeasons(
  seasons: Array<{ seasonNumber: number; monitored: boolean }> | undefined,
  monitor: RequestMonitor,
): Array<{ seasonNumber: number; monitored: boolean }> | undefined {
  if (!seasons) {
    return undefined;
  }
  return seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    monitored:
      monitor === "all"
        ? true
        : monitor === "firstSeason"
          ? season.seasonNumber === 1
          : false,
  }));
}

/** Interleave app results by upstream relevance rank. */
export function interleaveResults(groups: SearchResult[][]): SearchResult[] {
  const longest = groups.reduce((max, group) => Math.max(max, group.length), 0);
  const merged: SearchResult[] = [];
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      const result = group[index];
      if (result) {
        merged.push(result);
      }
    }
  }
  return merged;
}

function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
