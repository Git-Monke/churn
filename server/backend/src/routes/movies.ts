import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { movieMetadata } from "../activity.js";
import { requireAuth, type AuthContext } from "../auth.js";
import { ApiError, isUnauthorized, isUpstreamNotFound, UpstreamError } from "../errors.js";
import { directGrabError, grabTorrentDirect } from "../direct-grab.js";
import {
  createLiveDownloadStore,
  movieLiveDownload,
  type MovieDownloadIdentity,
} from "../live-downloads.js";
import {
  isActiveTorrent,
  matchMovieTorrents,
} from "../qbittorrent-activity.js";
import type { ReleaseSearchService } from "../release-search.js";
import { requestedMovieItem } from "../routes/requested.js";
import type {
  CancelMovieDownloadResponse,
  GrabShowReleaseResponse,
  MovieDetailResponse,
  MovieDownloadResponse,
} from "../types.js";
import { createJellyfinClient, type JellyfinItem } from "../upstream/jellyfin.js";
import { createQbittorrentClient } from "../upstream/qbittorrent.js";
import {
  createArrClient,
  type ServarrMovieResource,
  type ServarrQueueRecord,
} from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

export function registerMovieRoutes(
  app: FastifyInstance,
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
): void {
  const downloads = createLiveDownloadStore();

  app.get<{ Params: { source: string; id: string } }>(
    "/api/library/movies/:source/:id",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      const detail =
        source === "jellyfin"
          ? await loadJellyfinMovie(
              config,
              parseJellyfinId(request.params.id),
              requireAuth(request),
            )
          : await loadRadarrMovie(config, parseMovieId(request.params.id));
      if (detail.state === "ok") {
        downloads.rememberMovie(movieCacheKey(source, request.params.id), {
          title: detail.movie.title,
          ...(detail.movie.year !== undefined ? { year: detail.movie.year } : {}),
        });
      }
      return detail;
    },
  );

  app.get<{ Params: { source: string; id: string } }>(
    "/api/library/movies/:source/:id/download",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      const identity = downloads.movie(movieCacheKey(source, request.params.id));
      if (!identity) {
        return {
          checkedAt: new Date().toISOString(),
          ready: false,
        } satisfies MovieDownloadResponse;
      }
      const download = await movieLiveDownload(config, identity);
      return {
        checkedAt: new Date().toISOString(),
        ready: true,
        ...(download ? { download } : {}),
      } satisfies MovieDownloadResponse;
    },
  );

  app.delete<{ Params: { source: string; id: string } }>(
    "/api/library/movies/:source/:id/download",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      const detail =
        source === "jellyfin"
          ? await loadJellyfinMovie(
              config,
              parseJellyfinId(request.params.id),
              requireAuth(request),
            )
          : await loadRadarrMovie(config, parseMovieId(request.params.id));
      if (detail.state !== "ok" || !detail.movie.title) {
        throw new ApiError(
          503,
          "movie_unavailable",
          detail.detail ?? "Could not load this movie to cancel its download",
        );
      }
      return cancelMovieDownload(
        config,
        detail.movie.title,
        detail.movie.year,
        detail.radarrId,
      );
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
    const download = await loadMovieDownload(config, movie);
    return {
      source: "radarr",
      state: "ok",
      movie: movieDetailFromResource(movie),
      radarrId: movieId,
      ...(download ? { download } : {}),
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

  const download = await loadMovieDownload(
    config,
    radarrMovie ?? {
      title: movie.title,
      year: movie.year,
      ...(tmdbId !== undefined ? { tmdbId } : {}),
    },
  );
  return {
    source: "jellyfin",
    state: "ok",
    ...(radarrDetail ? { detail: radarrDetail } : {}),
    movie,
    ...(item.Id ? { jellyfinId: item.Id } : {}),
    ...(radarrMovie?.id !== undefined ? { radarrId: radarrMovie.id } : {}),
    ...(download ? { download } : {}),
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

/** Best-effort live download state; a qBittorrent outage must not hide the movie. */
async function loadMovieDownload(
  config: AppConfig,
  movie: ServarrMovieResource,
) {
  if (!config.qbittorrent.apiKey) {
    return undefined;
  }
  const title = movie.title?.trim();
  if (!title) {
    return undefined;
  }
  const identity: MovieDownloadIdentity = {
    title,
    ...(movie.year !== undefined ? { year: movie.year } : {}),
  };
  try {
    return await movieLiveDownload(config, identity);
  } catch {
    return undefined;
  }
}

async function cancelMovieDownload(
  config: AppConfig,
  title: string,
  year: number | undefined,
  radarrId: number | undefined,
): Promise<CancelMovieDownloadResponse> {
  let queueRemoved = 0;

  // Radarr still owns the queue record until the import completes. Remove that
  // first so Radarr does not immediately re-add a torrent we remove below.
  if (radarrId !== undefined && config.services.radarr.apiKey) {
    const client = createArrClient(
      "radarr",
      config.services.radarr,
      config.requestTimeoutMs,
    );
    let records: ServarrQueueRecord[] = [];
    try {
      records = (await client.getQueue()).filter(
        (record) => record.movieId === radarrId && record.id !== undefined,
      );
    } catch {
      // The qBittorrent fallback can still cancel a direct download.
    }
    await Promise.all(
      records.map(async (record) => {
        try {
          await client.removeQueueRecord(record.id as number, {
            blocklist: true,
            skipRedownload: true,
          });
        } catch (error) {
          if (!isUpstreamNotFound(error)) {
            throw error;
          }
        }
      }),
    );
    queueRemoved = records.length;
  }

  let downloadClientRemoved = 0;
  try {
    downloadClientRemoved = await cancelMovieTorrents(config, title, year);
  } catch (error) {
    // Radarr already removed the download; a qBittorrent hiccup must not turn
    // that success into a failed cancel.
    if (queueRemoved === 0) {
      throw error;
    }
  }
  if (queueRemoved === 0 && downloadClientRemoved === 0) {
    throw new ApiError(
      404,
      "download_not_found",
      "This movie has no active download to cancel",
    );
  }

  return {
    status: "cancelled",
    service: "radarr",
    queueRemoved,
    ...(downloadClientRemoved > 0 ? { downloadClientRemoved } : {}),
  };
}

/** Cancel direct/untracked downloads, matching the movie title and year. */
async function cancelMovieTorrents(
  config: AppConfig,
  title: string,
  year: number | undefined,
): Promise<number> {
  if (!config.qbittorrent.apiKey) {
    return 0;
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  const torrents = await client.getTorrents();
  const matched = matchMovieTorrents(torrents, title, year).filter(isActiveTorrent);
  const hashes = [
    ...new Set(
      matched
        .map((torrent) => torrent.hash ?? torrent.infohash_v1 ?? torrent.infohash_v2)
        .filter((hash): hash is string => Boolean(hash?.trim())),
    ),
  ];
  let removed = 0;
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        await client.removeTorrent(hash, false);
        removed += 1;
      } catch {
        // Report only torrents qBittorrent confirmed it removed.
      }
    }),
  );
  return removed;
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

  try {
    const result = await grabTorrentDirect(config, found.release, {
      kind: "movie",
      arrId: movieId,
      title: found.media.title || found.release.title,
      ...(found.media.year !== undefined ? { year: found.media.year } : {}),
    });
    return { status: "grabbed", title: result.title };
  } catch (error) {
    throw directGrabError(error);
  }
}


function parseSource(value: string): "jellyfin" | "radarr" {
  if (value === "jellyfin" || value === "radarr") {
    return value;
  }
  throw new ApiError(400, "invalid_source", "Movie source must be jellyfin or radarr");
}

function movieCacheKey(source: "jellyfin" | "radarr", id: string): string {
  return `${source}:${
    source === "jellyfin" ? parseJellyfinId(id) : String(parseMovieId(id))
  }`;
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
