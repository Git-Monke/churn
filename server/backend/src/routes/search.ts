import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { ApiError, UpstreamError } from "../errors.js";
import {
  interleaveResults,
  isAllowedMediaCoverPath,
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
    const [sonarr, radarr] = await Promise.all([
      searchSonarr(config.services.sonarr, query, config.requestTimeoutMs),
      searchRadarr(config.services.radarr, query, config.requestTimeoutMs),
    ]);

    const response: SearchResponse = {
      query,
      searchedAt: new Date().toISOString(),
      results: interleaveResults([sonarr.results, radarr.results]),
      services: [sonarr.status, radarr.status],
    };
    return response;
  });

  app.get<{ Params: { service: string }; Querystring: { path?: unknown } }>(
    "/api/search/images/:service",
    async (request, reply) => {
      const service = parseImageService(request.params.service);
      const path = parseImagePath(request.query.path);
      const serviceConfig = config.services[service];
      if (!serviceConfig.apiKey) {
        throw new ApiError(
          503,
          `${service}_unconfigured`,
          `Set ${service.toUpperCase()}_API_KEY or keep server/config/${service}/config.xml`,
        );
      }

      const client = createArrClient(service, serviceConfig, config.requestTimeoutMs);
      try {
        const image = await client.getMediaCover(path);
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

  const existingIds =
    library.status === "fulfilled"
      ? new Set(library.value.map((series) => series.tvdbId).filter(isNumber))
      : null;
  const detail =
    library.status === "rejected"
      ? `Could not check the Sonarr library: ${errorMessage(library.reason)}`
      : undefined;

  const results = lookup.value
    .map((series) =>
      mapSeriesResource(
        series,
        existingIds
          ? series.tvdbId !== undefined && existingIds.has(series.tvdbId)
          : series.id !== undefined && series.id > 0
            ? true
            : null,
      ),
    )
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

  const existingIds =
    library.status === "fulfilled"
      ? new Set(library.value.map((movie) => movie.tmdbId).filter(isNumber))
      : null;
  const detail =
    library.status === "rejected"
      ? `Could not check the Radarr library: ${errorMessage(library.reason)}`
      : undefined;

  const results = lookup.value
    .map((movie) =>
      mapMovieResource(
        movie,
        existingIds
          ? movie.tmdbId !== undefined && existingIds.has(movie.tmdbId)
          : movie.id !== undefined && movie.id > 0
            ? true
            : null,
      ),
    )
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

function isNumber(value: number | undefined): value is number {
  return typeof value === "number";
}

function parseImageService(value: string): ArrServiceId {
  if (value !== "sonarr" && value !== "radarr") {
    throw new ApiError(404, "unknown_service", "Image service must be sonarr or radarr");
  }
  return value;
}

function parseImagePath(value: unknown): string {
  if (typeof value !== "string" || !isAllowedMediaCoverPath(value)) {
    throw new ApiError(400, "invalid_path", "Invalid image path");
  }
  return value;
}
