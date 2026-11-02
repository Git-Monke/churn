import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { movieMetadata, seriesMetadata } from "../activity.js";
import { ApiError, isUpstreamNotFound } from "../errors.js";
import { refreshJellyfinLibrary } from "../library-scan.js";
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

export function registerRequestedLibraryRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/library/requested", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const [sonarr, radarr] = await Promise.all([
      loadRequestedLibrary("sonarr", config.services.sonarr, config.requestTimeoutMs),
      loadRequestedLibrary("radarr", config.services.radarr, config.requestTimeoutMs),
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
      return cancelRequestedTitle(config, service, id);
    },
  );
}

async function cancelRequestedTitle(
  config: AppConfig,
  service: ArrServiceId,
  id: number,
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
): Promise<ServiceRequestedLibrary> {
  if (!service.apiKey) {
    return failedRequestedLibrary(id, "unconfigured", unconfiguredDetail(id));
  }

  const client = createArrClient(id, service, timeoutMs);
  try {
    if (id === "sonarr") {
      const series = await client.listSeries();
      const items = series
        .map(requestedSeriesItem)
        .filter((item): item is RequestedLibraryItem => item !== null);
      return { items, status: { id, state: "ok", count: items.length } };
    }

    const movies = await client.listMovies();
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
