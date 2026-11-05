import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { movieMetadata, seriesMetadata } from "../activity.js";
import { ApiError, isUpstreamNotFound } from "../errors.js";
import { refreshJellyfinLibrary } from "../library-scan.js";
import {
  type MediaAttributionStore,
  type MediaIdentity,
} from "../media-attribution.js";
import {
  movieMetadataEntry,
  seriesMetadataEntry,
  type MediaCache,
} from "../media-cache.js";
import type { ReleaseSearchService } from "../release-search.js";
import type {
  CancelLibraryItemResponse,
  RequestedLibraryItem,
  RequestedLibraryResponse,
  RequestedLibraryServiceState,
} from "../types.js";
import { isMovieAvailable, isSeriesAvailable } from "../search.js";
import { movieTitleMatches } from "../qbittorrent-activity.js";
import { tokenize, torrentBelongsToShow } from "../qbittorrent-show.js";
import { createQbittorrentClient } from "../upstream/qbittorrent.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrMovieResource,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

interface ServiceRequestedLibrary {
  items: RequestedLibraryItem[];
  status: RequestedLibraryServiceState;
}

export function registerRequestedLibraryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  mediaCache: MediaCache,
  releaseSearch: ReleaseSearchService,
  mediaAttribution: MediaAttributionStore,
): void {
  app.get("/api/library/requested", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const [sonarr, radarr] = await Promise.all([
      loadRequestedLibrary(
        "sonarr",
        config.services.sonarr,
        config.requestTimeoutMs,
        mediaCache,
        mediaAttribution,
      ),
      loadRequestedLibrary(
        "radarr",
        config.services.radarr,
        config.requestTimeoutMs,
        mediaCache,
        mediaAttribution,
      ),
    ]);
    const items = [...sonarr.items, ...radarr.items];

    const response: RequestedLibraryResponse = {
      checkedAt: new Date().toISOString(),
      services: [sonarr.status, radarr.status],
      items,
      total: items.length,
    };
    return response;
  });

  app.delete<{ Params: { service: string; id: string } }>(
    "/api/library/requested/:service/:id",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const service = parseArrService(request.params.service);
      const id = parsePositiveId(request.params.id);
      return cancelRequestedTitle(config, service, id, releaseSearch, mediaAttribution);
    },
  );
}

export async function cancelRequestedTitle(
  config: AppConfig,
  service: ArrServiceId,
  id: number,
  releaseSearch: ReleaseSearchService,
  mediaAttribution: MediaAttributionStore,
): Promise<CancelLibraryItemResponse> {
  const serviceConfig = config.services[service];
  if (!serviceConfig.apiKey) {
    throw new ApiError(
      503,
      `${service}_unconfigured`,
      `Set ${service.toUpperCase()}_API_KEY or keep server/config/${service}/config.xml`,
    );
  }

  const client = createArrClient(service, serviceConfig, config.requestTimeoutMs);
  const [qbittorrentHashes, identity] = await Promise.all([
    findQbittorrentHashes(config, client, service, id).catch(() => [] as string[]),
    loadArrIdentity(client, service, id).catch(() => undefined),
  ]);
  const queue = await client.getQueue();
  const records = queue.filter((record) =>
    service === "sonarr" ? record.seriesId === id : record.movieId === id,
  );

  // A season pack can produce several queue records for one download. Removing
  // one can already remove its siblings, so a 404 for the rest is expected.
  await Promise.all(
    records.map(async (record) => {
      if (record.id === undefined) {
        return;
      }
      try {
        await client.removeQueueRecord(record.id);
      } catch (error) {
        if (!isUpstreamNotFound(error)) {
          throw error;
        }
      }
    }),
  );

  try {
    if (service === "sonarr") {
      await client.deleteSeries(id);
    } else {
      await client.deleteMovie(id);
    }
  } catch (error) {
    if (isUpstreamNotFound(error)) {
      throw new ApiError(404, "not_found", "Title was not found in " + service);
    }
    throw error;
  }

  if (identity) {
    await mediaAttribution.remove(identity);
  }

  // The arr removes its queue entry and tracked files, but a torrent Sonarr no
  // longer knows about can survive in qBittorrent. Remove those only after the
  // arr delete succeeded, so a failed delete never touches the download client.
  await removeQbittorrentTorrents(config, qbittorrentHashes);

  if (service === "sonarr") {
    await releaseSearch.invalidateSeries(id);
  } else {
    await releaseSearch.invalidateMovie(id);
  }

  // Jellyfin scans best-effort; a failure must not make the cancel look failed.
  try {
    await refreshJellyfinLibrary(config);
  } catch {
    // The arr delete already succeeded; Jellyfin will notice on its next scan.
  }
  scheduleJellyfinRefresh(config);

  return {
    status: "cancelled",
    service,
    kind: service === "sonarr" ? "series" : "movie",
    id,
    queueRemoved: records.filter((record) => record.id !== undefined).length,
  };
}


export interface ArrTitleMatch {
  service: "sonarr" | "radarr";
  kind: "movie" | "series";
  arrId: number;
}

/**
 * Match a Jellyfin item to an arr title when provider ids are missing or
 * differ. Provider ids win; otherwise require the same normalized title and a
 * compatible year so a remake or a different show is never deleted by accident.
 */
export async function findArrTitleMatch(
  config: AppConfig,
  kind: "movie" | "series",
  title: string,
  year: number | undefined,
  providerIds: { tmdbId?: number; tvdbId?: number } = {},
): Promise<ArrTitleMatch | undefined> {
  const serviceName = kind === "movie" ? "radarr" : "sonarr";
  const service = config.services[serviceName];
  if (!service.apiKey) {
    return undefined;
  }

  const client = createArrClient(serviceName, service, config.requestTimeoutMs);
  const items =
    kind === "movie"
      ? (await client.listMovies())
          .map(requestedMovieItem)
          .filter((item): item is RequestedLibraryItem => item !== null)
      : (await client.listSeries())
          .map(requestedSeriesItem)
          .filter((item): item is RequestedLibraryItem => item !== null);

  const providerMatches = items.filter((item) =>
    kind === "movie"
      ? providerIds.tmdbId !== undefined && item.tmdbId === providerIds.tmdbId
      : providerIds.tvdbId !== undefined && item.tvdbId === providerIds.tvdbId,
  );
  if (providerMatches.length === 1) {
    const match = providerMatches[0]!;
    return { service: match.service, kind: match.kind, arrId: match.arrId };
  }
  if (providerMatches.length > 1) {
    throw new ApiError(
      409,
      "ambiguous_arr_title",
      "More than one Sonarr/Radarr title matches this Jellyfin item",
    );
  }

  const titleMatches = items.filter((item) => {
    if (normalizeTitle(item.title) !== normalizeTitle(title)) {
      return false;
    }
    if (year === undefined || item.year === undefined) {
      return true;
    }
    return kind === "series" ? Math.abs(item.year - year) <= 1 : item.year === year;
  });
  if (titleMatches.length > 1) {
    throw new ApiError(
      409,
      "ambiguous_arr_title",
      "More than one Sonarr/Radarr title matches this Jellyfin item",
    );
  }
  if (titleMatches.length === 0) {
    return undefined;
  }
  const match = titleMatches[0]!;
  return { service: match.service, kind: match.kind, arrId: match.arrId };
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function findQbittorrentHashes(
  config: AppConfig,
  client: ReturnType<typeof createArrClient>,
  service: ArrServiceId,
  id: number,
): Promise<string[]> {
  if (!config.qbittorrent.apiKey) {
    return [];
  }

  const qbittorrent = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  const [torrents, resource] = await Promise.all([
    qbittorrent.getTorrents(),
    service === "sonarr" ? client.getSeries(id) : client.getMovie(id),
  ]);
  const title = resource.title?.trim();
  if (!title) {
    return [];
  }

  const matched =
    service === "sonarr"
      ? torrents.filter((torrent) => {
          const name = torrent.name?.trim();
          return name !== undefined && torrentBelongsToShow(name, tokenize(title));
        })
      : torrents.filter(
          (torrent) =>
            torrent.name !== undefined &&
            movieTitleMatches(
              torrent.name,
              title,
              (resource as ServarrMovieResource).year,
            ),
        );

  return [
    ...new Set(
      matched
        .map((torrent) => torrent.hash ?? torrent.infohash_v1 ?? torrent.infohash_v2)
        .filter((hash): hash is string => Boolean(hash?.trim())),
    ),
  ];
}

async function removeQbittorrentTorrents(
  config: AppConfig,
  hashes: string[],
): Promise<void> {
  if (!config.qbittorrent.apiKey || hashes.length === 0) {
    return;
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        await client.removeTorrent(hash, true);
      } catch {
        // The arr delete already succeeded. Leave a stubborn torrent for the
        // user rather than reporting the whole deletion as failed.
      }
    }),
  );
}


/** Best-effort qBittorrent cleanup for a title deleted outside the arr. */
export async function removeQbittorrentForTitle(
  config: AppConfig,
  kind: "movie" | "series",
  title: string,
  year: number | undefined,
): Promise<void> {
  if (!config.qbittorrent.apiKey) {
    return;
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  let torrents;
  try {
    torrents = await client.getTorrents();
  } catch {
    return;
  }
  const matched =
    kind === "series"
      ? torrents.filter((torrent) => {
          const name = torrent.name?.trim();
          return name !== undefined && torrentBelongsToShow(name, tokenize(title));
        })
      : torrents.filter(
          (torrent) =>
            torrent.name !== undefined && movieTitleMatches(torrent.name, title, year),
        );
  const hashes = [
    ...new Set(
      matched
        .map((torrent) => torrent.hash ?? torrent.infohash_v1 ?? torrent.infohash_v2)
        .filter((hash): hash is string => Boolean(hash?.trim())),
    ),
  ];
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        await client.removeTorrent(hash, true);
      } catch {
        // The Jellyfin delete already succeeded; leave stubborn torrents alone.
      }
    }),
  );
}

/** Jellyfin can miss files deleted midway through a scan; ask once more later. */
function scheduleJellyfinRefresh(config: AppConfig): void {
  const timer = setTimeout(() => {
    void refreshJellyfinLibrary(config).catch(() => undefined);
  }, 1_500);
  timer.unref?.();
}

function parseArrService(value: string): ArrServiceId {
  if (value === "sonarr" || value === "radarr") {
    return value;
  }
  throw new ApiError(400, "invalid_service", "service must be sonarr or radarr");
}

function parsePositiveId(value: string): number {
  if (!/^\d{1,10}$/.test(value)) {
    throw new ApiError(400, "invalid_id", "id must be a positive integer");
  }
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "invalid_id", "id must be a positive integer");
  }
  return id;
}

async function loadRequestedLibrary(
  id: ArrServiceId,
  service: ServiceConfig,
  timeoutMs: number,
  mediaCache: MediaCache,
  mediaAttribution: MediaAttributionStore,
): Promise<ServiceRequestedLibrary> {
  if (!service.apiKey) {
    return failedRequestedLibrary(id, "unconfigured", unconfiguredDetail(id));
  }

  const client = createArrClient(id, service, timeoutMs);
  try {
    if (id === "sonarr") {
      const series = await client.listSeries();
      await cacheSeriesMetadata(series, mediaCache);
      const items = series
        .map(requestedSeriesItem)
        .filter((item): item is RequestedLibraryItem => item !== null)
        .map((item) => attachRequestedAttribution(item, mediaAttribution));
      return { items, status: { id, state: "ok", count: items.length } };
    }

    const movies = await client.listMovies();
    await cacheMovieMetadata(movies, mediaCache);
    const items = movies
      .map(requestedMovieItem)
      .filter((item): item is RequestedLibraryItem => item !== null)
      .map((item) => attachRequestedAttribution(item, mediaAttribution));
    return { items, status: { id, state: "ok", count: items.length } };
  } catch (error) {
    return failedRequestedLibrary(id, stateForError(error), errorMessage(error));
  }
}

async function cacheSeriesMetadata(
  series: ServarrSeriesResource[],
  mediaCache: MediaCache,
): Promise<void> {
  await Promise.all(
    series.map(async (item) => {
      const entry = seriesMetadataEntry(item);
      if (entry && !(await mediaCache.getSeries(entry.id))) {
        await mediaCache.putSeries(entry);
      }
    }),
  ).catch(() => {
    // Metadata caching is best-effort; the library response is unaffected.
  });
}

async function cacheMovieMetadata(
  movies: ServarrMovieResource[],
  mediaCache: MediaCache,
): Promise<void> {
  await Promise.all(
    movies.map(async (item) => {
      const entry = movieMetadataEntry(item);
      if (entry && !(await mediaCache.getMovie(entry.id))) {
        await mediaCache.putMovie(entry);
      }
    }),
  ).catch(() => {
    // Metadata caching is best-effort; the library response is unaffected.
  });
}

export function requestedSeriesItem(series: ServarrSeriesResource): RequestedLibraryItem | null {
  const metadata = seriesMetadata(series);
  const title = metadata.title?.trim();
  if (!title || series.id === undefined) {
    return null;
  }

  return {
    key:
      metadata.tvdbId !== undefined
        ? `series:${metadata.tvdbId}`
        : `series:sonarr:${series.id}`,
    service: "sonarr",
    kind: "series",
    arrId: series.id,
    title,
    year: metadata.year,
    overview: metadata.overview,
    network: metadata.network,
    rating: metadata.rating,
    runtimeMinutes: metadata.runtimeMinutes,
    imageUrl: metadata.imageUrl,
    tmdbId: metadata.tmdbId,
    tvdbId: metadata.tvdbId,
    imdbId: metadata.imdbId,
    available: isSeriesAvailable(series),
  };
}

export function requestedMovieItem(movie: ServarrMovieResource): RequestedLibraryItem | null {
  const metadata = movieMetadata(movie);
  const title = metadata.title?.trim();
  if (!title || movie.id === undefined) {
    return null;
  }

  return {
    key:
      metadata.tmdbId !== undefined
        ? `movie:${metadata.tmdbId}`
        : `movie:radarr:${movie.id}`,
    service: "radarr",
    kind: "movie",
    arrId: movie.id,
    title,
    year: metadata.year,
    overview: metadata.overview,
    network: metadata.network,
    rating: metadata.rating,
    runtimeMinutes: metadata.runtimeMinutes,
    imageUrl: metadata.imageUrl,
    tmdbId: metadata.tmdbId,
    imdbId: metadata.imdbId,
    available: isMovieAvailable(movie),
  };
}

function attachRequestedAttribution(
  item: RequestedLibraryItem,
  mediaAttribution: MediaAttributionStore,
): RequestedLibraryItem {
  const addedBy = mediaAttribution.get({
    kind: item.kind,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
  });
  return addedBy ? { ...item, addedBy } : item;
}

async function loadArrIdentity(
  client: ReturnType<typeof createArrClient>,
  service: ArrServiceId,
  id: number,
): Promise<MediaIdentity> {
  if (service === "sonarr") {
    const metadata = seriesMetadata(await client.getSeries(id));
    return { kind: "series", tvdbId: metadata.tvdbId, tmdbId: metadata.tmdbId };
  }
  const metadata = movieMetadata(await client.getMovie(id));
  return { kind: "movie", tmdbId: metadata.tmdbId };
}

/**
 * Additions made directly in Sonarr/Radarr do not pass through churn's request
 * route, so reconcile missing release searches whenever the library is loaded.
 * Fully available titles need no chooser options; the cache methods deduplicate
 * searches and apply a cooldown to empty results.
 */
function failedRequestedLibrary(
  id: ArrServiceId,
  state: RequestedLibraryServiceState["state"],
  detail: string,
): ServiceRequestedLibrary {
  return { items: [], status: { id, state, detail, count: 0 } };
}

function unconfiguredDetail(id: ArrServiceId): string {
  return `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`;
}
