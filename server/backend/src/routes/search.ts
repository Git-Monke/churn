import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { ApiError, UpstreamError } from "../errors.js";
import {
  interleaveResults,
  isAllowedArtworkUrl,
  isMovieAvailable,
  isSeriesAvailable,
  mapMovieResource,
  mapSeriesResource,
} from "../search.js";
import type { SearchResponse, SearchResult, SearchServiceState } from "../types.js";
import { createArrClient, type ArrServiceId } from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

interface ServiceSearch {
  results: SearchResult[];
  status: SearchServiceState;
}

export function registerSearchRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get<{ Querystring: { q?: unknown } }>("/api/search", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = parseSearchQuery(request.query.q);
    const timeoutMs = Math.max(config.requestTimeoutMs, config.searchTimeoutMs);
    const [sonarr, radarr] = await Promise.all([
      searchSonarr(config.services.sonarr, query, timeoutMs),
      searchRadarr(config.services.radarr, query, timeoutMs),
    ]);

    const response: SearchResponse = {
      query,
      searchedAt: new Date().toISOString(),
      results: interleaveResults([sonarr.results, radarr.results]),
      services: [sonarr.status, radarr.status],
    };
    return response;
  });

  app.get<{ Params: { service: string }; Querystring: { url?: unknown } }>(
    "/api/search/images/:service",
    async (request, reply) => {
      const service = parseImageService(request.params.service);
      const url = parseImageUrl(request.query.url);
      const serviceConfig = config.services[service];

      const client = createArrClient(service, serviceConfig, config.requestTimeoutMs);
      try {
        const image = await client.getRemoteImage(url);
        if (!image) {
          throw new ApiError(404, "image_not_found", "Image not found");
        }
        reply.header("cache-control", "public, max-age=86400");
        return reply.type(image.contentType).send(image.body);
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (error instanceof UpstreamError) {
          if (error.status === 404) {
            throw new ApiError(404, "image_not_found", "Image not found");
          }
          throw new ApiError(502, `${service}_image_failed`, error.message);
        }
        throw error;
      }
    },
  );
}

async function searchSonarr(
  service: ServiceConfig,
  query: string,
  timeoutMs: number,
): Promise<ServiceSearch> {
  if (!service.apiKey) {
    return failedSearch("sonarr", "unconfigured", unconfiguredDetail("sonarr"));
  }

  const client = createArrClient("sonarr", service, timeoutMs);
  const [lookup, library] = await Promise.allSettled([
    client.lookupSeries(query),
    client.listSeries(),
  ]);

  if (lookup.status === "rejected") {
    return failedSearch("sonarr", stateForError(lookup.reason), errorMessage(lookup.reason));
  }

  const libraryByTvdbId =
    library.status === "fulfilled"
      ? new Map(
          library.value
            .filter((series) => series.tvdbId !== undefined)
            .map((series) => [series.tvdbId, series] as const),
        )
      : null;
  const detail =
    library.status === "rejected"
      ? `Could not check the Sonarr library: ${errorMessage(library.reason)}`
      : undefined;

  const results = lookup.value
    .map((series) => {
      const existing =
        series.tvdbId !== undefined ? libraryByTvdbId?.get(series.tvdbId) : undefined;
      return mapSeriesResource(
        series,
        libraryByTvdbId
          ? existing !== undefined
          : series.id !== undefined && series.id > 0
            ? true
            : null,
        existing ? isSeriesAvailable(existing) : libraryByTvdbId ? false : undefined,
      );
    })
    .filter((result): result is SearchResult => result !== null);

  return { results, status: { id: "sonarr", state: "ok", count: results.length, detail } };
}

async function searchRadarr(
  service: ServiceConfig,
  query: string,
  timeoutMs: number,
): Promise<ServiceSearch> {
  if (!service.apiKey) {
    return failedSearch("radarr", "unconfigured", unconfiguredDetail("radarr"));
  }

  const client = createArrClient("radarr", service, timeoutMs);
  const [lookup, library] = await Promise.allSettled([
    client.lookupMovie(query),
    client.listMovies(),
  ]);

  if (lookup.status === "rejected") {
    return failedSearch("radarr", stateForError(lookup.reason), errorMessage(lookup.reason));
  }

  const libraryByTmdbId =
    library.status === "fulfilled"
      ? new Map(
          library.value
            .filter((movie) => movie.tmdbId !== undefined)
            .map((movie) => [movie.tmdbId, movie] as const),
        )
      : null;
  const detail =
    library.status === "rejected"
      ? `Could not check the Radarr library: ${errorMessage(library.reason)}`
      : undefined;

  const results = lookup.value
    .map((movie) => {
      const existing =
        movie.tmdbId !== undefined ? libraryByTmdbId?.get(movie.tmdbId) : undefined;
      return mapMovieResource(
        movie,
        libraryByTmdbId
          ? existing !== undefined
          : movie.id !== undefined && movie.id > 0
            ? true
            : null,
        existing ? isMovieAvailable(existing) : libraryByTmdbId ? false : undefined,
      );
    })
    .filter((result): result is SearchResult => result !== null);

  return { results, status: { id: "radarr", state: "ok", count: results.length, detail } };
}

function parseSearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_query", "Search query is required");
  }
  const query = value.trim();
  if (query.length < 2) {
    throw new ApiError(400, "invalid_query", "Search query must be at least 2 characters");
  }
  if (query.length > 120) {
    throw new ApiError(400, "invalid_query", "Search query must be 120 characters or fewer");
  }
  return query;
}

function failedSearch(
  id: "sonarr" | "radarr",
  state: SearchServiceState["state"],
  detail: string,
): ServiceSearch {
  return { results: [], status: { id, state, detail, count: 0 } };
}

function unconfiguredDetail(id: "sonarr" | "radarr"): string {
  return `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`;
}


function parseImageService(value: string): ArrServiceId {
  if (value !== "sonarr" && value !== "radarr") {
    throw new ApiError(404, "unknown_service", "Image service must be sonarr or radarr");
  }
  return value;
}

function parseImageUrl(value: unknown): string {
  if (typeof value !== "string" || !isAllowedArtworkUrl(value)) {
    throw new ApiError(400, "invalid_url", "Invalid image URL");
  }
  return value;
}
