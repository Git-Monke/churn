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

// Sonarr and Radarr advertise artwork as `/MediaCoverProxy/...` URLs, but those
// are tied to the web UI session and answer 401 even with a valid API key. The
// same posters are published as public `remoteUrl`s, so the backend proxies
// those and allowlists the hosts to keep the proxy from becoming an SSRF vector.
const ARTWORK_HOSTS = new Set([
  "artworks.thetvdb.com",
  "banners.thetvdb.com",
  "www.thetvdb.com",
  "image.tmdb.org",
  "assets.fanart.tv",
]);

const IMAGE_EXTENSION = /\.(?:jpg|jpeg|png|webp)$/i;


/** True when `value` is an https URL on an allowlisted artwork CDN. */
export function isAllowedArtworkUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    ARTWORK_HOSTS.has(url.hostname.toLowerCase()) &&
    IMAGE_EXTENSION.test(url.pathname)
  );
}

/** Map an arr artwork URL to a backend-owned image URL. */
export function mediaCoverUrl(
  service: "sonarr" | "radarr",
  images: ServarrSeriesResource["images"],
): string | undefined {
  const poster = images?.find((image) => image.coverType === "poster" && image.remoteUrl);
  if (!poster?.remoteUrl || !isAllowedArtworkUrl(poster.remoteUrl)) {
    return undefined;
  }
  return `/api/search/images/${service}?url=${encodeURIComponent(poster.remoteUrl)}`;
}

export function mapSeriesResource(
  resource: ServarrSeriesResource,
  inLibrary: boolean | null,
  available?: boolean,
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
    available: available ?? (inLibrary === true ? isSeriesAvailable(resource) : undefined),
    seasons,
  };
}

export function mapMovieResource(
  resource: ServarrMovieResource,
  inLibrary: boolean | null,
  available?: boolean,
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
    available: available ?? (inLibrary === true ? Boolean(resource.hasFile) : undefined),
  };
}

/** True when Sonarr has files for every episode it knows about. */
export function isSeriesAvailable(series: ServarrSeriesResource): boolean {
  const statistics = series.statistics;
  return Boolean(
    statistics &&
      statistics.totalEpisodeCount !== undefined &&
      statistics.totalEpisodeCount > 0 &&
      (statistics.episodeFileCount ?? 0) >= statistics.totalEpisodeCount,
  );
}

/** True when Radarr has imported a file for the movie. */
export function isMovieAvailable(movie: ServarrMovieResource): boolean {
  return Boolean(movie.hasFile);
}

/**
 * Prefer a shared 720p/1080p profile, then 1080p, then 720p. Avoid picking a
 * 4K/Ultra-HD profile by default when a smaller profile is available.
 */
export function pickDefaultQualityProfile(
  profiles: ServarrQualityProfile[],
): ServarrQualityProfile | undefined {
  return profiles
    .map((profile, index) => ({
      profile,
      index,
      score: qualityProfileScore(profile.name),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.profile;
}

function qualityProfileScore(name: string): number {
  const normalized = normalizeProfileName(name);
  if (/(?:^|\W)(?:2160p?|4k|uhd|ultra)(?:\W|$)/.test(normalized)) {
    return -1;
  }
  const has720 = /(?:^|\W)720p?(?:\W|$)/.test(normalized);
  const has1080 = /(?:^|\W)1080p?(?:\W|$)/.test(normalized);
  if (has720 && has1080) {
    return 3;
  }
  if (has1080) {
    return 2;
  }
  if (has720) {
    return 1;
  }
  return 0;
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
