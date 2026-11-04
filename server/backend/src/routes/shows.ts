import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { isActiveQueueRecord, isSeasonPack, queueRecordSeasons } from "../activity.js";
import { requireAuth, type AuthContext } from "../auth.js";
import { ApiError, isUnauthorized, isUpstreamNotFound, UpstreamError } from "../errors.js";
import { refreshJellyfinLibrary } from "../library-scan.js";
import { directGrabError, grabTorrentDirect } from "../direct-grab.js";
import {
  markDownloadsImporting,
  recoverCompletedShowDownloads,
} from "../download-import.js";
import type { ReleaseSearchService } from "../release-search.js";
import { mediaCoverUrl } from "../search.js";
import { buildShowDetail } from "../shows.js";
import { mapShowTorrentDownloads } from "../qbittorrent-show.js";
import type {
  ArrServiceState,
  CancelEpisodeDownloadResponse,
  CachedReleasesResponse,
  GrabShowReleaseResponse,
  ShowDetailResponse,
  ShowSeriesSummary,
  ShowSource,
} from "../types.js";
import { createJellyfinClient, type JellyfinItem } from "../upstream/jellyfin.js";
import { createQbittorrentClient, type QbittorrentTorrent } from "../upstream/qbittorrent.js";
import {
  createArrClient,
  type ServarrQueueRecord,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

export function registerShowRoutes(
  app: FastifyInstance,
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
): void {
  app.get<{ Params: { source: string; id: string } }>(
    "/api/library/shows/:source/:id",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source === "jellyfin") {
        const auth = requireAuth(request);
        return loadJellyfinShow(config, parseJellyfinId(request.params.id), auth);
      }
      return loadSonarrShow(config, parseSonarrId(request.params.id));
    },
  );

  app.get<{
    Params: { source: string; id: string };
    Querystring: { season?: unknown; episode?: unknown };
  }>(
    "/api/library/shows/:source/:id/releases",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source !== "sonarr") {
        throw new ApiError(400, "invalid_source", "Releases are only available for Sonarr-backed shows");
      }
      const seriesId = parseSonarrId(request.params.id);
      const seasonNumber = parseSeasonNumber(request.query.season);
      const episodeNumber = parseOptionalEpisodeNumber(request.query.episode);
      return loadShowReleases(config, releaseSearch, seriesId, seasonNumber, {
        episodeNumber,
      });
    },
  );

  app.post<{
    Params: { source: string; id: string };
    Querystring: { season?: unknown; episode?: unknown };
  }>(
    "/api/library/shows/:source/:id/releases/refresh",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source !== "sonarr") {
        throw new ApiError(400, "invalid_source", "Releases are only available for Sonarr-backed shows");
      }
      const seriesId = parseSonarrId(request.params.id);
      const seasonNumber = parseSeasonNumber(request.query.season);
      const episodeNumber = parseOptionalEpisodeNumber(request.query.episode);
      return refreshShowReleases(
        config,
        releaseSearch,
        seriesId,
        seasonNumber,
        episodeNumber,
      );
    },
  );

  app.post<{ Params: { source: string; id: string }; Body: unknown }>(
    "/api/library/shows/:source/:id/releases/grab",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source !== "sonarr") {
        throw new ApiError(400, "invalid_source", "Releases are only available for Sonarr-backed shows");
      }
      const seriesId = parseSonarrId(request.params.id);
      return grabShowRelease(
        config,
        releaseSearch,
        seriesId,
        parseGrabReleaseInput(request.body),
      );
    },
  );

  app.delete<{
    Params: { source: string; id: string; season: string; episode: string };
  }>(
    "/api/library/shows/:source/:id/episodes/:season/:episode/download",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source !== "sonarr") {
        throw new ApiError(
          400,
          "invalid_source",
          "Episode downloads can only be cancelled for Sonarr-backed shows",
        );
      }
      return cancelEpisodeDownload(
        config,
        parseSonarrId(request.params.id),
        parseSeasonNumber(request.params.season),
        parseSeasonNumber(request.params.episode),
      );
    },
  );
}

async function loadJellyfinShow(
  config: AppConfig,
  itemId: string,
  auth: AuthContext,
): Promise<ShowDetailResponse> {
  const service = config.services.jellyfin;
  if (!service.apiKey) {
    return emptyShow("jellyfin", "unconfigured", "Set JELLYFIN_API_KEY in server/.env");
  }

  const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken);
  let item: JellyfinItem;
  let seasons: JellyfinItem[];
  let episodes: JellyfinItem[];
  try {
    [item, seasons, episodes] = await Promise.all([
      client.getItem(itemId),
      client.getSeasons(itemId),
      client.getEpisodes(itemId),
    ]);
  } catch (error) {
    if (isUnauthorized(error)) {
      auth.destroySession();
      throw new ApiError(
        401,
        "session_expired",
        "Your Jellyfin session expired. Sign in again.",
      );
    }
    if (
      error instanceof UpstreamError &&
      (error.status === 400 || error.status === 404)
    ) {
      throw new ApiError(404, "show_not_found", "Show not found");
    }
    return emptyShow("jellyfin", stateForError(error), errorMessage(error));
  }

  if (item.Type !== "Series") {
    throw new ApiError(404, "show_not_found", "Item is not a series");
  }

  const warnings: string[] = [];
  let sonarrSeries: ServarrSeriesResource | undefined;
  let sonarrEpisodes = undefined as Awaited<
    ReturnType<ReturnType<typeof createArrClient>["getEpisodes"]>
  > | undefined;
  let qbittorrentTorrents: QbittorrentTorrent[] = [];

  try {
    qbittorrentTorrents = await loadQbittorrentTorrents(config);
  } catch (error) {
    warnings.push(`Could not load qBittorrent downloads: ${errorMessage(error)}`);
  }

  const tvdbId = providerNumber(item, "tvdb");
  if (tvdbId !== undefined) {
    const sonarrService = config.services.sonarr;
    if (!sonarrService.apiKey) {
      warnings.push("Sonarr API key is not configured; release search and missing episodes are unavailable.");
    } else {
      const sonarrClient = createArrClient("sonarr", sonarrService, config.requestTimeoutMs);
      try {
        const seriesList = await sonarrClient.listSeries();
        sonarrSeries = seriesList.find((series) => series.tvdbId === tvdbId);
        if (!sonarrSeries) {
          warnings.push("This show is not tracked in Sonarr; release search is unavailable.");
        } else if (sonarrSeries.id !== undefined) {
          try {
            sonarrEpisodes = await sonarrClient.getEpisodes(sonarrSeries.id);
          } catch (error) {
            warnings.push(`Could not load Sonarr episodes: ${errorMessage(error)}`);
          }
        }
      } catch (error) {
        warnings.push(`Could not check Sonarr: ${errorMessage(error)}`);
      }
    }
  } else {
    warnings.push("This show has no TVDB id; it cannot be matched to Sonarr for release search.");
  }

  const series = seriesSummaryFromJellyfin(item, sonarrSeries);
  const detail = buildShowDetail({
    source: "jellyfin",
    series,
    jellyfinSeasons: seasons,
    jellyfinEpisodes: episodes,
    sonarrEpisodes,
    qbittorrentTorrents,
  });
  const recovering = sonarrSeries?.id === undefined
    ? new Set<string>()
    : await recoverCompletedShowDownloads(
        config,
        sonarrSeries.id,
        series.title,
        detail.episodes,
        qbittorrentTorrents,
      );
  markDownloadsImporting(detail.episodes, recovering);
  const scanning = detail.episodes.length === 0 && (await refreshJellyfinSeries(config, itemId));

  return {
    source: "jellyfin",
    state: "ok",
    warnings: warnings.length > 0 ? warnings : undefined,
    series,
    ...(sonarrSeries?.id !== undefined ? { sonarrId: sonarrSeries.id } : {}),
    ...(scanning ? { scanning: true } : {}),
    ...detail,
  };
}

/**
 * Jellyfin can keep a series but not link its on-disk episodes, for example
 * after a restart or an interrupted import. A full library scan repairs that,
 * so request one when a show loads without episodes and keep the page polling
 * quickly for a short while.
 */
const JELLYFIN_SCAN_POLL_MS = 2 * 60_000;
const JELLYFIN_SCAN_RETRY_MS = 5 * 60_000;
const jellyfinScanRequests = new Map<string, number>();

async function refreshJellyfinSeries(config: AppConfig, itemId: string): Promise<boolean> {
  const now = Date.now();
  const requestedAt = jellyfinScanRequests.get(itemId);
  if (requestedAt !== undefined) {
    if (now - requestedAt < JELLYFIN_SCAN_POLL_MS) {
      return true;
    }
    if (now - requestedAt < JELLYFIN_SCAN_RETRY_MS) {
      return false;
    }
  }

  jellyfinScanRequests.set(itemId, now);
  try {
    await refreshJellyfinLibrary(config);
    return true;
  } catch {
    return false;
  }
}

/** Indexer and grab lookups routinely take longer than a normal CRUD call. */
interface ReleaseSearchOptions {
  episodeNumber?: number;
}

async function loadShowReleases(
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
  seriesId: number,
  seasonNumber: number,
  options: ReleaseSearchOptions = {},
): Promise<CachedReleasesResponse> {
  if (!config.services.sonarr.apiKey) {
    throw new ApiError(503, "sonarr_unconfigured", unconfiguredDetail("sonarr"));
  }

  return options.episodeNumber === undefined
    ? releaseSearch.getSeriesSeason(seriesId, seasonNumber)
    : releaseSearch.getSeriesEpisode(seriesId, seasonNumber, options.episodeNumber);
}

async function refreshShowReleases(
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
  seriesId: number,
  seasonNumber: number,
  episodeNumber?: number,
): Promise<CachedReleasesResponse> {
  if (!config.services.sonarr.apiKey) {
    throw new ApiError(503, "sonarr_unconfigured", unconfiguredDetail("sonarr"));
  }
  return episodeNumber === undefined
    ? releaseSearch.refreshSeriesSeason(seriesId, seasonNumber)
    : releaseSearch.refreshSeriesEpisode(seriesId, seasonNumber, episodeNumber);
}

async function grabShowRelease(
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
  seriesId: number,
  input: ReturnType<typeof parseGrabReleaseInput>,
): Promise<GrabShowReleaseResponse> {
  const searchSeasonNumber = input.searchSeasonNumber ?? input.seasonNumber;
  const found = await releaseSearch.findRelease(
    { kind: "series", seriesId, seasonNumber: searchSeasonNumber },
    input.releaseId,
  );
  if (!found) {
    throw new ApiError(
      404,
      "release_not_found",
      "That release is no longer in the search results; search again",
    );
  }

  try {
    const result = await grabTorrentDirect(config, found.release, {
      kind: "series",
      arrId: seriesId,
      title: found.media.title || found.release.title,
      ...(found.media.year !== undefined ? { year: found.media.year } : {}),
      seasonNumber: searchSeasonNumber,
      multiSeason: found.release.parsed.seasonNumbers.length > 1,
    });
    return { status: "grabbed", title: result.title };
  } catch (error) {
    throw directGrabError(error);
  }
}


async function cancelEpisodeDownload(
  config: AppConfig,
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<CancelEpisodeDownloadResponse> {
  const service = config.services.sonarr;
  if (!service.apiKey) {
    throw new ApiError(503, "sonarr_unconfigured", unconfiguredDetail("sonarr"));
  }

  const client = createArrClient("sonarr", service, config.requestTimeoutMs);
  let episodeId: number | undefined;
  let queue: ServarrQueueRecord[] = [];
  try {
    const episodes = await client.getEpisodes(seriesId);
    episodeId = episodes.find(
      (episode) =>
        episode.seasonNumber === seasonNumber &&
        episode.episodeNumber === episodeNumber,
    )?.id;
  } catch (error) {
    throw releaseApiError(error, "Could not load Sonarr episode details");
  }

  if (episodeId === undefined) {
    throw new ApiError(404, "episode_not_found", "Episode not found in Sonarr");
  }

  try {
    queue = await client.getQueue();
  } catch {
    // qBittorrent can still cancel an untracked download when Sonarr's queue is
    // unavailable, so keep going with an empty queue.
  }

  // Match the same queue records the show overlay used, so cancelling from an
  // episode does not touch downloads for another season or episode.
  const records = queue.filter((record) => {
    if (record.seriesId !== seriesId || !isActiveQueueRecord(record)) {
      return false;
    }
    const seasons = queueRecordSeasons(record);
    const multiSeason = seasons.length > 1;
    if (record.episodeId !== undefined && !multiSeason) {
      return record.episodeId === episodeId;
    }
    return seasons.includes(seasonNumber);
  });
  const removable = records.filter(
    (record): record is ServarrQueueRecord & { id: number } => record.id !== undefined,
  );
  if (removable.length === 0) {
    let seriesTitle: string | undefined;
    try {
      seriesTitle = (await client.getSeries(seriesId)).title?.trim();
    } catch {
      // qBittorrent fallback is best-effort when Sonarr metadata is unavailable.
    }
    const removed = seriesTitle
      ? await cancelUntrackedEpisodeDownload(
          config,
          seriesTitle,
          seasonNumber,
          episodeNumber,
        )
      : 0;
    if (removed === 0) {
      throw new ApiError(
        404,
        "download_not_found",
        "This episode has no active download to cancel",
      );
    }
    return {
      status: "cancelled",
      service: "sonarr",
      seriesId,
      seasonNumber,
      episodeNumber,
      queueRemoved: 0,
      downloadClientRemoved: removed,
      seasonPack: false,
    };
  }

  // A season pack can produce several queue records for one download. Removing
  // one can already remove its siblings, so a 404 for the rest is expected.
  await Promise.all(
    removable.map(async (record) => {
      try {
        await client.removeQueueRecord(record.id, {
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

  return {
    status: "cancelled",
    service: "sonarr",
    seriesId,
    seasonNumber,
    episodeNumber,
    queueRemoved: removable.length,
    seasonPack: records.some(
      (record) => isSeasonPack(record) || queueRecordSeasons(record).length > 1,
    ),
  };
}

async function cancelUntrackedEpisodeDownload(
  config: AppConfig,
  seriesTitle: string,
  seasonNumber: number,
  episodeNumber: number,
): Promise<number> {
  if (!config.qbittorrent.apiKey) {
    return 0;
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  const torrents = await client.getTorrents();
  const identity = { key: "target", seasonNumber, episodeNumber };
  const matched = torrents.filter(
    (torrent) =>
      torrent.name !== undefined &&
      mapShowTorrentDownloads([torrent], seriesTitle, [identity]).size > 0,
  );
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
        // Report only the torrents qBittorrent confirmed it removed.
      }
    }),
  );
  return removed;
}

function releaseApiError(error: unknown, fallback: string, status = 502): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof UpstreamError) {
    if (error.status === 400 || error.status === 404) {
      return new ApiError(error.status, "sonarr_release_failed", error.message);
    }
    return new ApiError(status, "sonarr_release_failed", `${fallback}: ${error.message}`);
  }
  return new ApiError(status, "sonarr_release_failed", errorMessage(error));
}

async function loadSonarrShow(
  config: AppConfig,
  seriesId: number,
): Promise<ShowDetailResponse> {
  const service = config.services.sonarr;
  if (!service.apiKey) {
    return emptyShow("sonarr", "unconfigured", unconfiguredDetail("sonarr"));
  }

  const client = createArrClient("sonarr", service, config.requestTimeoutMs);
  let serverSeries: ServarrSeriesResource;
  try {
    serverSeries = await client.getSeries(seriesId);
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) {
      throw new ApiError(404, "show_not_found", "Show not found");
    }
    return emptyShow("sonarr", stateForError(error), errorMessage(error));
  }

  const warnings: string[] = [];
  const [episodesResult, torrentsResult] = await Promise.allSettled([
    client.getEpisodes(seriesId),
    loadQbittorrentTorrents(config),
  ]);
  if (episodesResult.status === "rejected") {
    warnings.push(`Could not load Sonarr episodes: ${errorMessage(episodesResult.reason)}`);
  }
  if (torrentsResult.status === "rejected") {
    warnings.push(`Could not load qBittorrent downloads: ${errorMessage(torrentsResult.reason)}`);
  }

  const series = seriesSummaryFromSonarr(serverSeries);
  const torrents =
    torrentsResult.status === "fulfilled" ? torrentsResult.value : [];
  const detail = buildShowDetail({
    source: "sonarr",
    series,
    sonarrEpisodes: episodesResult.status === "fulfilled" ? episodesResult.value : [],
    qbittorrentTorrents: torrents,
  });

  const recovering = await recoverCompletedShowDownloads(
    config,
    seriesId,
    series.title,
    detail.episodes,
    torrents,
  );
  markDownloadsImporting(detail.episodes, recovering);

  return {
    source: "sonarr",
    state: "ok",
    warnings: warnings.length > 0 ? warnings : undefined,
    series,
    sonarrId: seriesId,
    ...detail,
  };
}

function seriesSummaryFromJellyfin(
  item: JellyfinItem,
  sonarr: ServarrSeriesResource | undefined,
): ShowSeriesSummary {
  const imageTag = item.ImageTags?.Primary;
  return {
    title: item.Name?.trim() || sonarr?.title?.trim() || "Unknown show",
    year: item.ProductionYear ?? sonarr?.year,
    overview: item.Overview ?? sonarr?.overview,
    network: sonarr?.network,
    rating: item.CommunityRating ?? sonarr?.ratings?.value,
    imageUrl: imageTag
      ? `/api/library/images/${encodeURIComponent(item.Id ?? "")}?tag=${encodeURIComponent(imageTag)}`
      : mediaCoverUrl("sonarr", sonarr?.images),
    tvdbId: providerNumber(item, "tvdb") ?? sonarr?.tvdbId,
    tmdbId: providerNumber(item, "tmdb") ?? sonarr?.tmdbId,
    imdbId: providerString(item, "imdb") ?? sonarr?.imdbId,
  };
}

function seriesSummaryFromSonarr(series: ServarrSeriesResource): ShowSeriesSummary {
  return {
    title: series.title?.trim() || "Unknown show",
    year: series.year,
    overview: series.overview,
    network: series.network,
    rating: series.ratings?.value,
    imageUrl: mediaCoverUrl("sonarr", series.images),
    tvdbId: series.tvdbId,
    tmdbId: series.tmdbId,
    imdbId: series.imdbId,
  };
}

/** Optional: a missing key or unavailable qBittorrent just disables the fallback. */
async function loadQbittorrentTorrents(config: AppConfig): Promise<QbittorrentTorrent[]> {
  if (!config.qbittorrent.apiKey) {
    return [];
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  return client.getTorrents();
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

function parseSource(value: string): ShowSource {
  if (value !== "jellyfin" && value !== "sonarr") {
    throw new ApiError(400, "invalid_source", "Show source must be jellyfin or sonarr");
  }
  return value;
}

function parseJellyfinId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new ApiError(400, "invalid_item_id", "Invalid Jellyfin item id");
  }
  return value;
}

function parseSonarrId(value: string): number {
  if (!/^\d{1,10}$/.test(value)) {
    throw new ApiError(400, "invalid_series_id", "Invalid Sonarr series id");
  }
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "invalid_series_id", "Invalid Sonarr series id");
  }
  return id;
}

function parseSeasonNumber(value: unknown): number {
  const season =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,3}$/.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(season) || season < 0) {
    throw new ApiError(400, "invalid_season", "season must be a non-negative integer");
  }
  return season;
}

function parseGrabReleaseInput(value: unknown): {
  seasonNumber: number;
  episodeNumber?: number;
  searchSeasonNumber?: number;
  releaseId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const seasonNumber = parseSeasonNumber(body.seasonNumber);
  const episodeNumber = parseOptionalEpisodeNumber(body.episodeNumber);
  const searchSeasonNumber = parseOptionalSeasonNumber(body.searchSeasonNumber);
  if (typeof body.releaseId !== "string" || !/^[a-f0-9]{24}$/.test(body.releaseId)) {
    throw new ApiError(400, "invalid_release_id", "releaseId is invalid");
  }
  return { seasonNumber, episodeNumber, searchSeasonNumber, releaseId: body.releaseId };
}

function parseOptionalEpisodeNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : parseSeasonNumber(value);
}

function parseOptionalSeasonNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : parseSeasonNumber(value);
}

function emptyShow(source: ShowSource, state: ArrServiceState, detail: string): ShowDetailResponse {
  return {
    source,
    state,
    detail,
    series: { title: "" },
    seasons: [],
    episodes: [],
  };
}

function unconfiguredDetail(id: "sonarr"): string {
  return `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`;
}
