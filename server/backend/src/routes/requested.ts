import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { movieMetadata, seriesMetadata } from "../activity.js";
import type {
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
