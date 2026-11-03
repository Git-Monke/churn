import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { movieMetadata, seriesMetadata } from "../activity.js";
import { mapWithConcurrency } from "../concurrency.js";
import { ApiError, isUpstreamNotFound } from "../errors.js";
import { refreshJellyfinLibrary } from "../library-scan.js";
import type { ReleaseCache } from "../release-cache.js";
import type {
  CancelLibraryItemResponse,
  RequestedLibraryItem,
  RequestedLibraryResponse,
  RequestedLibraryServiceState,
} from "../types.js";
import { isMovieAvailable, isSeriesAvailable } from "../search.js";
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

const RELEASE_SEARCH_TIMEOUT_MS = 30_000;

export function registerRequestedLibraryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  releaseCache: ReleaseCache,
): void {
  app.get("/api/library/requested", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const [sonarr, radarr] = await Promise.all([
      loadRequestedLibrary(
        "sonarr",
        config.services.sonarr,
        config.requestTimeoutMs,
        releaseCache,
      ),
      loadRequestedLibrary(
        "radarr",
        config.services.radarr,
        config.requestTimeoutMs,
        releaseCache,
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
      return cancelRequestedTitle(config, service, id, releaseCache);
    },
  );
}

async function cancelRequestedTitle(
  config: AppConfig,
  service: ArrServiceId,
  id: number,
  releaseCache: ReleaseCache,
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

  if (service === "sonarr") {
    await releaseCache.invalidateSeries(id);
  } else {
    await releaseCache.invalidateMovie(id);
  }

  // Jellyfin scans best-effort; a failure must not make the cancel look failed.
  try {
    await refreshJellyfinLibrary(config);
  } catch {
    // The arr delete already succeeded; Jellyfin will notice on its next scan.
  }

  return {
    status: "cancelled",
    service,
    kind: service === "sonarr" ? "series" : "movie",
    id,
    queueRemoved: records.filter((record) => record.id !== undefined).length,
  };
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
  releaseCache: ReleaseCache,
): Promise<ServiceRequestedLibrary> {
  if (!service.apiKey) {
    return failedRequestedLibrary(id, "unconfigured", unconfiguredDetail(id));
  }

  const client = createArrClient(id, service, timeoutMs);
  try {
    if (id === "sonarr") {
      const series = await client.listSeries();
      prefetchSeriesReleases(service, timeoutMs, releaseCache, series);
      const items = series
        .map(requestedSeriesItem)
        .filter((item): item is RequestedLibraryItem => item !== null);
      return { items, status: { id, state: "ok", count: items.length } };
    }

    const movies = await client.listMovies();
    prefetchMovieReleases(service, timeoutMs, releaseCache, movies);
    const items = movies
      .map(requestedMovieItem)
      .filter((item): item is RequestedLibraryItem => item !== null);
    return { items, status: { id, state: "ok", count: items.length } };
  } catch (error) {
    return failedRequestedLibrary(id, stateForError(error), errorMessage(error));
  }
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

/**
 * Additions made directly in Sonarr/Radarr do not pass through churn's request
 * route, so reconcile missing release searches whenever the library is loaded.
 * Fully available titles need no chooser options; the cache methods deduplicate
 * searches and apply a cooldown to empty results.
 */
function prefetchSeriesReleases(
  service: ServiceConfig,
  requestTimeoutMs: number,
  releaseCache: ReleaseCache,
  series: ServarrSeriesResource[],
): void {
  const missing = series.filter(
    (item) => item.id !== undefined && !isSeriesAvailable(item),
  );
  if (missing.length === 0) {
    return;
  }
  const client = createArrClient(
    "sonarr",
    service,
    Math.max(requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
  void mapWithConcurrency(missing, 2, async (item) => {
    const seriesId = item.id as number;
    const seasonNumbers = regularSeasons(item.seasons);
    if (seasonNumbers.length === 0) {
      try {
        const full = await client.getSeries(seriesId);
        await releaseCache.warmMissingSeries(seriesId, regularSeasons(full.seasons), (season) =>
          client.getSeasonReleases(seriesId, season),
        );
      } catch {
        // The show page will retry if the cache is still empty.
      }
      return;
    }
    await releaseCache.warmMissingSeries(seriesId, seasonNumbers, (season) =>
      client.getSeasonReleases(seriesId, season),
    );
  }).catch(() => {
    // Prefetch is best-effort; the requested library response is unaffected.
  });
}

function prefetchMovieReleases(
  service: ServiceConfig,
  requestTimeoutMs: number,
  releaseCache: ReleaseCache,
  movies: ServarrMovieResource[],
): void {
  const missing = movies.filter(
    (item) => item.id !== undefined && !isMovieAvailable(item),
  );
  if (missing.length === 0) {
    return;
  }
  const client = createArrClient(
    "radarr",
    service,
    Math.max(requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
  void mapWithConcurrency(missing, 2, (item) =>
    releaseCache.warmMissingMovie(item.id as number, () =>
      client.getMovieReleases(item.id as number),
    ),
  ).catch(() => {
    // Prefetch is best-effort; the requested library response is unaffected.
  });
}

function regularSeasons(seasons: ServarrSeriesResource["seasons"]): number[] {
  return [...new Set((seasons ?? []).map((season) => season.seasonNumber))]
    .filter((season) => Number.isInteger(season) && season > 0)
    .sort((left, right) => left - right);
}

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
