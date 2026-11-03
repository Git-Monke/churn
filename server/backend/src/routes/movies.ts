import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { movieMetadata } from "../activity.js";
import { requireAuth, type AuthContext } from "../auth.js";
import { ApiError, isUnauthorized, isUpstreamNotFound, UpstreamError } from "../errors.js";
import { grabWithDuplicateRecovery } from "../download-recovery.js";
import { findMatchingArrRelease, type ReleaseSearchService } from "../release-search.js";
import { buildReleaseGrabPayload, releaseNeedsOverride } from "../releases.js";
import { requestedMovieItem } from "../routes/requested.js";
import type { GrabShowReleaseResponse, MovieDetailResponse } from "../types.js";
import { createJellyfinClient, type JellyfinItem } from "../upstream/jellyfin.js";
import { createArrClient, type ServarrMovieResource } from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

const RELEASE_SEARCH_TIMEOUT_MS = 30_000;

export function registerMovieRoutes(
  app: FastifyInstance,
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
): void {
  app.get<{ Params: { source: string; id: string } }>(
    "/api/library/movies/:source/:id",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source === "jellyfin") {
        return loadJellyfinMovie(config, parseJellyfinId(request.params.id), requireAuth(request));
      }
      return loadRadarrMovie(config, parseMovieId(request.params.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/library/movies/:id/releases",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const movieId = parseMovieId(request.params.id);
      return releaseSearch.getMovie(movieId);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/library/movies/:id/releases/refresh",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const movieId = parseMovieId(request.params.id);
      return releaseSearch.refreshMovie(movieId);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/library/movies/:id/releases/grab",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const movieId = parseMovieId(request.params.id);
      return grabMovieRelease(config, releaseSearch, movieId, parseGrabInput(request.body));
    },
  );
}

async function loadRadarrMovie(
  config: AppConfig,
  movieId: number,
): Promise<MovieDetailResponse> {
  const service = config.services.radarr;
  if (!service.apiKey) {
    return {
      source: "radarr",
      state: "unconfigured",
      detail: "Set RADARR_API_KEY or keep server/config/radarr/config.xml",
      movie: { title: "" },
    };
  }

  const client = createArrClient("radarr", service, config.requestTimeoutMs);
  try {
    const movie = await client.getMovie(movieId);
    return {
      source: "radarr",
      state: "ok",
      movie: movieDetailFromResource(movie),
      radarrId: movieId,
    };
  } catch (error) {
    if (isUpstreamNotFound(error)) {
      throw new ApiError(404, "movie_not_found", "Movie not found");
    }
    return {
      source: "radarr",
      state: stateForError(error),
      detail: errorMessage(error),
      movie: { title: "" },
    };
  }
}

async function loadJellyfinMovie(
  config: AppConfig,
  itemId: string,
  auth: AuthContext,
): Promise<MovieDetailResponse> {
  const service = config.services.jellyfin;
  if (!service.apiKey) {
    return {
      source: "jellyfin",
      state: "unconfigured",
      detail: "Set JELLYFIN_API_KEY in server/.env",
      movie: { title: "" },
    };
  }

  const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken);
  let item: JellyfinItem;
  try {
    item = await client.getItem(itemId);
  } catch (error) {
    if (isUnauthorized(error)) {
      auth.destroySession();
      throw new ApiError(401, "session_expired", "Your Jellyfin session expired. Sign in again.");
    }
    if (error instanceof UpstreamError && (error.status === 400 || error.status === 404)) {
      throw new ApiError(404, "movie_not_found", "Movie not found");
    }
    return {
      source: "jellyfin",
      state: stateForError(error),
      detail: errorMessage(error),
      movie: { title: "" },
    };
  }

  if (item.Type !== "Movie") {
    throw new ApiError(404, "movie_not_found", "Item is not a movie");
  }

  const tmdbId = providerNumber(item, "tmdb");
  let radarrMovie: ServarrMovieResource | undefined;
  let radarrDetail: string | undefined;
  const radarrService = config.services.radarr;
  if (!radarrService.apiKey || tmdbId === undefined) {
    radarrDetail =
      tmdbId === undefined
        ? "This movie has no TMDB id; release search is unavailable."
        : "Radarr API key is not configured; release search is unavailable.";
  } else {
    const radarrClient = createArrClient("radarr", radarrService, config.requestTimeoutMs);
    try {
      const movies = await radarrClient.listMovies();
      radarrMovie = movies.find((movie) => movie.tmdbId === tmdbId);
    } catch (error) {
      radarrDetail = `Could not match this movie in Radarr: ${errorMessage(error)}`;
    }
  }

  const imageTag = item.ImageTags?.Primary;
  const metadata = radarrMovie ? movieMetadata(radarrMovie) : undefined;
  const movie = {
    title: item.Name?.trim() || metadata?.title || "Unknown movie",
    ...(item.ProductionYear ?? metadata?.year
      ? { year: item.ProductionYear ?? metadata?.year }
      : {}),
    ...(item.Overview ?? metadata?.overview
      ? { overview: item.Overview ?? metadata?.overview }
      : {}),
    ...(metadata?.network ? { network: metadata.network } : {}),
    ...(item.CommunityRating ?? metadata?.rating
      ? { rating: item.CommunityRating ?? metadata?.rating }
      : {}),
    ...(metadata?.runtimeMinutes ? { runtimeMinutes: metadata.runtimeMinutes } : {}),
    imageUrl: imageTag
      ? `/api/library/images/${encodeURIComponent(item.Id ?? "")}?tag=${encodeURIComponent(imageTag)}`
      : metadata?.imageUrl ?? "",
    ...(tmdbId !== undefined ? { tmdbId } : {}),
    ...(providerString(item, "imdb")
      ? { imdbId: providerString(item, "imdb") }
      : metadata?.imdbId
        ? { imdbId: metadata.imdbId }
        : {}),
  };

  return {
    source: "jellyfin",
    state: "ok",
    ...(radarrDetail ? { detail: radarrDetail } : {}),
    movie,
    ...(item.Id ? { jellyfinId: item.Id } : {}),
    ...(radarrMovie?.id !== undefined ? { radarrId: radarrMovie.id } : {}),
  };
}

function movieDetailFromResource(movie: ServarrMovieResource) {
  const metadata = movieMetadata(movie);
  return {
    title: metadata.title?.trim() || "Unknown movie",
    ...(metadata.year !== undefined ? { year: metadata.year } : {}),
    ...(metadata.overview !== undefined ? { overview: metadata.overview } : {}),
    ...(metadata.network !== undefined ? { network: metadata.network } : {}),
    ...(metadata.rating !== undefined ? { rating: metadata.rating } : {}),
    ...(metadata.runtimeMinutes !== undefined ? { runtimeMinutes: metadata.runtimeMinutes } : {}),
    ...(metadata.imageUrl !== undefined ? { imageUrl: metadata.imageUrl } : {}),
    ...(metadata.tmdbId !== undefined ? { tmdbId: metadata.tmdbId } : {}),
    ...(metadata.imdbId !== undefined ? { imdbId: metadata.imdbId } : {}),
  };
}

async function grabMovieRelease(
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
  movieId: number,
  input: { releaseId: string },
): Promise<GrabShowReleaseResponse> {
  const found = await releaseSearch.findRelease({ kind: "movie", movieId }, input.releaseId);
  if (!found) {
    throw new ApiError(
      404,
      "release_not_found",
      "That release is no longer in the search results; search again",
    );
  }

  const indexerId =
    found.arrIndexerId ??
    (await releaseSearch.resolveArrIndexer("movie", found.release.indexer));
  if (indexerId === undefined) {
    throw new ApiError(
      409,
      "indexer_not_in_radarr",
      `Radarr does not have the ${found.release.indexer} indexer. Add it in Prowlarr's app sync and retry.`,
    );
  }

  const client = releaseClient(config);
  let release: ReturnType<typeof findMatchingArrRelease>;
  try {
    const releases = await client.getMovieReleases(movieId, { indexerId });
    release = findMatchingArrRelease(releases, found.release);
  } catch (error) {
    throw releaseApiError(error, "Could not prepare that release in Radarr");
  }

  if (!release) {
    throw new ApiError(
      404,
      "release_not_found",
      "Radarr could not find that release on its indexer; search again",
    );
  }

  try {
    const movie = await client.getMovie(movieId);
    await client.updateMovie(movieId, { ...movie, monitored: true });
  } catch (error) {
    throw releaseApiError(error, "Radarr could not enable monitoring for this movie");
  }

  const payload = buildReleaseGrabPayload(
    release,
    { movieId },
    { override: releaseNeedsOverride(release) },
  );
  try {
    await grabWithDuplicateRecovery(config, release, () => client.grabRelease(payload));
  } catch (error) {
    throw releaseApiError(error, "Radarr could not grab that release", 409);
  }

  return { status: "grabbed", title: release.title?.trim() || found.release.title };
}

function releaseClient(config: AppConfig) {
  return createArrClient(
    "radarr",
    config.services.radarr,
    Math.max(config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
}

function releaseApiError(error: unknown, fallback: string, status = 502): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof UpstreamError) {
    if (error.status === 400 || error.status === 404) {
      return new ApiError(error.status, "radarr_release_failed", error.message);
    }
    return new ApiError(status, "radarr_release_failed", `${fallback}: ${error.message}`);
  }
  return new ApiError(status, "radarr_release_failed", errorMessage(error));
}

function parseSource(value: string): "jellyfin" | "radarr" {
  if (value === "jellyfin" || value === "radarr") {
    return value;
  }
  throw new ApiError(400, "invalid_source", "Movie source must be jellyfin or radarr");
}

function parseJellyfinId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new ApiError(400, "invalid_item_id", "Invalid Jellyfin item id");
  }
  return value;
}

function parseMovieId(value: string): number {
  if (!/^\d{1,10}$/.test(value)) {
    throw new ApiError(400, "invalid_movie_id", "Invalid Radarr movie id");
  }
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "invalid_movie_id", "Invalid Radarr movie id");
  }
  return id;
}

function parseGrabInput(value: unknown): { releaseId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.releaseId !== "string" || !/^[a-f0-9]{24}$/.test(body.releaseId)) {
    throw new ApiError(400, "invalid_release_id", "releaseId is invalid");
  }
  return { releaseId: body.releaseId };
}

function providerNumber(item: JellyfinItem, key: string): number | undefined {
  const value = providerString(item, key);
  if (value === undefined) {
    return undefined;
  }
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function providerString(item: JellyfinItem, key: string): string | undefined {
  const entry = Object.entries(item.ProviderIds ?? {}).find(
    ([providerKey]) => providerKey.toLowerCase() === key.toLowerCase(),
  );
  return entry?.[1]?.trim() || undefined;
}
