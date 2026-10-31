import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { filterActiveQueueRecords } from "../activity.js";
import { ApiError, UpstreamError } from "../errors.js";
import { mediaCoverUrl } from "../search.js";
import { buildShowDetail } from "../shows.js";
import type {
  ArrServiceState,
  ShowDetailResponse,
  ShowSeriesSummary,
  ShowSource,
} from "../types.js";
import { createJellyfinClient, type JellyfinItem } from "../upstream/jellyfin.js";
import {
  createArrClient,
  type ServarrQueueRecord,
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
