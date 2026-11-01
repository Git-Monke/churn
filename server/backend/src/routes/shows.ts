import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { filterActiveQueueRecords } from "../activity.js";
import { ApiError, UpstreamError } from "../errors.js";
import {
  findRelease,
  releaseId,
  releaseMatchesEpisode,
  releaseMatchesSeason,
  toShowReleases,
} from "../releases.js";
import { mediaCoverUrl } from "../search.js";
import { buildShowDetail } from "../shows.js";
import type {
  ArrServiceState,
  GrabShowReleaseResponse,
  ShowDetailResponse,
  ShowReleasesResponse,
  ShowSeriesSummary,
  ShowSource,
} from "../types.js";
import { createJellyfinClient, type JellyfinItem } from "../upstream/jellyfin.js";
import {
  createArrClient,
  type ServarrQueueRecord,
  type ServarrRelease,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";
import { errorMessage, stateForError } from "../upstream/states.js";

export function registerShowRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get<{ Params: { source: string; id: string } }>(
    "/api/library/shows/:source/:id",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const source = parseSource(request.params.source);
      if (source === "jellyfin") {
        return loadJellyfinShow(config, parseJellyfinId(request.params.id));
      }
      return loadSonarrShow(config, parseSonarrId(request.params.id));
    },
  );

  app.get<{
    Params: { source: string; id: string };
    Querystring: { season?: unknown; episode?: unknown; scope?: unknown };
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
      const scope = parseReleaseScope(request.query.scope);
      return loadShowReleases(config, seriesId, seasonNumber, {
        episodeNumber,
        allSeasons: scope === "all",
      });
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
      return grabShowRelease(config, seriesId, parseGrabReleaseInput(request.body));
    },
  );
}

async function loadJellyfinShow(config: AppConfig, itemId: string): Promise<ShowDetailResponse> {
  const service = config.services.jellyfin;
  if (!service.apiKey) {
    return emptyShow("jellyfin", "unconfigured", "Set JELLYFIN_API_KEY in server/.env");
  }

  const client = createJellyfinClient(service, config.requestTimeoutMs);
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
  let queueRecords: ServarrQueueRecord[] = [];

  const tvdbId = providerNumber(item, "tvdb");
  if (tvdbId !== undefined) {
    const sonarrService = config.services.sonarr;
    if (!sonarrService.apiKey) {
      warnings.push("Sonarr API key is not configured; download status is unavailable.");
    } else {
      const sonarrClient = createArrClient("sonarr", sonarrService, config.requestTimeoutMs);
      try {
        const seriesList = await sonarrClient.listSeries();
        sonarrSeries = seriesList.find((series) => series.tvdbId === tvdbId);
        if (!sonarrSeries) {
          warnings.push("This show is not tracked in Sonarr; download status is unavailable.");
        } else if (sonarrSeries.id !== undefined) {
          const [episodesResult, queueResult] = await Promise.allSettled([
            sonarrClient.getEpisodes(sonarrSeries.id),
            sonarrClient.getQueue(),
          ]);
          if (episodesResult.status === "fulfilled") {
            sonarrEpisodes = episodesResult.value;
          } else {
            warnings.push(`Could not load Sonarr episodes: ${errorMessage(episodesResult.reason)}`);
          }
          if (queueResult.status === "fulfilled") {
            queueRecords = queueResult.value;
          } else {
            warnings.push(`Could not load the Sonarr queue: ${errorMessage(queueResult.reason)}`);
          }
        }
      } catch (error) {
        warnings.push(`Could not check Sonarr: ${errorMessage(error)}`);
      }
    }
  } else {
    warnings.push("This show has no TVDB id; download status cannot be matched.");
  }

  const series = seriesSummaryFromJellyfin(item, sonarrSeries);
  const detail = buildShowDetail({
    source: "jellyfin",
    series,
    jellyfinSeasons: seasons,
    jellyfinEpisodes: episodes,
    sonarrEpisodes,
    queueRecords: queueForSeries(queueRecords, sonarrSeries?.id),
  });

  return {
    source: "jellyfin",
    state: "ok",
    warnings: warnings.length > 0 ? warnings : undefined,
    series,
    ...detail,
  };
}

/** Indexer searches routinely take longer than the general API timeout. */
const RELEASE_SEARCH_TIMEOUT_MS = 30_000;

interface ReleaseSearchOptions {
  episodeNumber?: number;
  allSeasons?: boolean;
}

async function loadShowReleases(
  config: AppConfig,
  seriesId: number,
  seasonNumber: number,
  options: ReleaseSearchOptions = {},
): Promise<ShowReleasesResponse> {
  const service = config.services.sonarr;
  if (!service.apiKey) {
    throw new ApiError(503, "sonarr_unconfigured", unconfiguredDetail("sonarr"));
  }

  const client = createArrClient(
    "sonarr",
    service,
    Math.max(config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
  const checkedAt = new Date().toISOString();

  if (options.episodeNumber !== undefined) {
    let releases: ServarrRelease[];
    try {
      releases = await getEpisodeReleases(client, seriesId, seasonNumber, options.episodeNumber);
    } catch (error) {
      throw releaseApiError(error, "Could not search Sonarr for releases");
    }
    return {
      seriesId,
      seasonNumber,
      episodeNumber: options.episodeNumber,
      checkedAt,
      releases: toShowReleases(
        releases.filter((release) =>
          releaseMatchesEpisode(release, seasonNumber, options.episodeNumber as number),
        ),
      ),
    };
  }

  if (options.allSeasons) {
    let matches: Array<{ release: ServarrRelease; searchSeasonNumber: number; id: string }>;
    try {
      matches = await getAllSeasonReleaseMatches(
        client,
        seriesId,
        seasonNumber,
      );
    } catch (error) {
      throw releaseApiError(error, "Could not search Sonarr for releases");
    }
    const releases = toShowReleases(matches.map((match) => match.release));
    const searchSeasons = new Map(matches.map((match) => [match.id, match.searchSeasonNumber]));
    for (const release of releases) {
      const searchSeasonNumber = searchSeasons.get(release.id);
      if (searchSeasonNumber !== undefined) {
        release.searchSeasonNumber = searchSeasonNumber;
      }
    }
    return { seriesId, seasonNumber, checkedAt, releases };
  }

  let releases: ServarrRelease[];
  try {
    releases = await client.getSeasonReleases(seriesId, seasonNumber);
  } catch (error) {
    throw releaseApiError(error, "Could not search Sonarr for releases");
  }

  return {
    seriesId,
    seasonNumber,
    checkedAt,
    releases: toShowReleases(
      releases.filter((release) => releaseMatchesSeason(release, seasonNumber)),
    ),
  };
}

async function getEpisodeReleases(
  client: ReturnType<typeof createArrClient>,
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<ServarrRelease[]> {
  const episodes = await client.getEpisodes(seriesId);
  const episode = episodes.find(
    (item) =>
      item.seasonNumber === seasonNumber && item.episodeNumber === episodeNumber,
  );
  if (episode?.id === undefined) {
    throw new ApiError(404, "episode_not_found", "Episode not found in Sonarr");
  }
  return client.getEpisodeReleases(seriesId, episode.id);
}

async function getAllSeasonReleaseMatches(
  client: ReturnType<typeof createArrClient>,
  seriesId: number,
  requestedSeason: number,
): Promise<Array<{ release: ServarrRelease; searchSeasonNumber: number; id: string }>> {
  const series = await client.getSeries(seriesId);
  const seasons = [...new Set((series.seasons ?? []).map((season) => season.seasonNumber))]
    .filter((season) => Number.isInteger(season) && season > 0)
    .sort((left, right) => left - right);
  if (!seasons.includes(requestedSeason)) {
    seasons.push(requestedSeason);
    seasons.sort((left, right) => left - right);
  }

  const failures: unknown[] = [];
  const bySeason = await mapWithConcurrency(seasons, 3, async (searchSeasonNumber) => {
    try {
      return {
        searchSeasonNumber,
        releases: await client.getSeasonReleases(seriesId, searchSeasonNumber),
      };
    } catch (error) {
      failures.push(error);
      return { searchSeasonNumber, releases: [] };
    }
  });
  if (seasons.length > 0 && failures.length === seasons.length) {
    throw failures[0];
  }

  const seen = new Set<string>();
  const matches: Array<{ release: ServarrRelease; searchSeasonNumber: number; id: string }> = [];
  for (const result of bySeason) {
    for (const release of result.releases) {
      if (!releaseMatchesSeason(release, requestedSeason)) {
        continue;
      }
      const id = releaseId(release);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      matches.push({ release, searchSeasonNumber: result.searchSeasonNumber, id });
    }
  }
  return matches;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function grabShowRelease(
  config: AppConfig,
  seriesId: number,
  input: ReturnType<typeof parseGrabReleaseInput>,
): Promise<GrabShowReleaseResponse> {
  const service = config.services.sonarr;
  if (!service.apiKey) {
    throw new ApiError(503, "sonarr_unconfigured", unconfiguredDetail("sonarr"));
  }

  const client = createArrClient(
    "sonarr",
    service,
    Math.max(config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
  let release: ServarrRelease | undefined;
  let releases: ServarrRelease[];
  try {
    releases =
      input.episodeNumber !== undefined
        ? await getEpisodeReleases(client, seriesId, input.seasonNumber, input.episodeNumber)
        : await client.getSeasonReleases(
            seriesId,
            input.searchSeasonNumber ?? input.seasonNumber,
          );
    release = findRelease(releases, input.releaseId);
  } catch (error) {
    throw releaseApiError(error, "Could not search Sonarr for releases");
  }

  if (!release) {
    throw new ApiError(404, "release_not_found", "That release is no longer available; search again");
  }

  const mappedEpisodeIds = (release.mappedEpisodeInfo ?? [])
    .map((episode) => episode.id)
    .filter((id): id is number => Number.isInteger(id));
  const needsOverride = release.rejected === true || release.downloadAllowed === false;
  if (needsOverride && mappedEpisodeIds.length === 0) {
    throw new ApiError(
      409,
      "release_unmapped",
      "Sonarr cannot map this release to any episodes, so it cannot be grabbed",
    );
  }

  const payload: Record<string, unknown> = {
    guid: release.guid,
    indexerId: release.indexerId,
    seriesId,
  };
  if (needsOverride) {
    payload.shouldOverride = true;
    payload.episodeIds = mappedEpisodeIds;
    payload.quality = release.quality;
    payload.languages = release.languages ?? [{ id: 0, name: "Unknown" }];
  }

  try {
    await client.grabRelease(payload);
  } catch (error) {
    throw releaseApiError(error, "Sonarr could not grab that release", 409);
  }

  return { status: "grabbed", title: release.title?.trim() || "Release" };
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

async function loadSonarrShow(config: AppConfig, seriesId: number): Promise<ShowDetailResponse> {
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
  const [episodesResult, queueResult] = await Promise.allSettled([
    client.getEpisodes(seriesId),
    client.getQueue(),
  ]);
  if (episodesResult.status === "rejected") {
    warnings.push(`Could not load Sonarr episodes: ${errorMessage(episodesResult.reason)}`);
  }
  if (queueResult.status === "rejected") {
    warnings.push(`Could not load the Sonarr queue: ${errorMessage(queueResult.reason)}`);
  }

  const series = seriesSummaryFromSonarr(serverSeries);
  const detail = buildShowDetail({
    source: "sonarr",
    series,
    sonarrEpisodes: episodesResult.status === "fulfilled" ? episodesResult.value : [],
    queueRecords: queueForSeries(
      queueResult.status === "fulfilled" ? queueResult.value : [],
      seriesId,
    ),
  });

  return {
    source: "sonarr",
    state: "ok",
    warnings: warnings.length > 0 ? warnings : undefined,
    series,
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

function queueForSeries(
  records: ServarrQueueRecord[],
  seriesId: number | undefined,
): ServarrQueueRecord[] {
  if (seriesId === undefined) {
    return [];
  }
  return filterActiveQueueRecords(records.filter((record) => record.seriesId === seriesId));
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

function parseReleaseScope(value: unknown): "season" | "all" {
  if (value === undefined || value === "season") {
    return "season";
  }
  if (value === "all") {
    return "all";
  }
  throw new ApiError(400, "invalid_scope", "scope must be season or all");
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
