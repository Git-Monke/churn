import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { mapWithConcurrency } from "../concurrency.js";
import { ApiError } from "../errors.js";
import {
  DEFAULT_MIN_SEEDERS,
  movieReleaseCandidate,
  pickRelease,
  qualityTierFromName,
  releaseIsTorrent,
  releaseTier,
  showReleaseCandidate,
  type ReleasePick,
} from "../release-pick.js";
import type { ReleaseEventStore } from "../release-events.js";
import {
  buildReleaseGrabPayload,
  mappedEpisodeIds,
  monitorSeriesSeasons,
  releaseMatchesSeason,
  releaseNeedsOverride,
  seasonPackSeasons,
} from "../releases.js";
import {
  DEFAULT_SWARM_POLICY,
  pickRepickRelease,
  watchSwarm,
} from "../swarm-watch.js";
import {
  arrMonitorName,
  monitorSeasons,
  pickDefaultQualityProfile,
  pickDefaultRootFolder,
  toQualityProfiles,
  toRootFolders,
} from "../search.js";
import type {
  ArrRequestOptions,
  CreateRequestInput,
  CreateRequestResponse,
  RequestDownload,
  RequestKind,
  RequestMonitor,
  RequestOptionsInput,
  RequestOptionsResponse,
} from "../types.js";
import { errorMessage, stateForError } from "../upstream/states.js";
import { createQbittorrentClient } from "../upstream/qbittorrent.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrMovieResource,
  type ServarrQualityProfile,
  type ServarrRelease,
  type ServarrRootFolder,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";

/** Release searches hit every indexer, so they need more time than a CRUD call. */
const RELEASE_SEARCH_TIMEOUT_MS = 30_000;

export function registerRequestRoutes(
  app: FastifyInstance,
  config: AppConfig,
  events?: ReleaseEventStore,
): void {
  app.get("/api/requests/options", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const checkedAt = new Date().toISOString();
    const timeoutMs = Math.max(config.requestTimeoutMs, config.searchTimeoutMs);
    const [sonarr, radarr] = await Promise.all([
      loadRequestOptions("sonarr", config.services.sonarr, timeoutMs),
      loadRequestOptions("radarr", config.services.radarr, timeoutMs),
    ]);
    const response: RequestOptionsResponse = {
      checkedAt,
      services: { sonarr, radarr },
    };
    return response;
  });

  app.post<{ Body: unknown }>("/api/requests", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const input = parseCreateRequest(request.body);
    const service: ArrServiceId = input.kind === "movie" ? "radarr" : "sonarr";
    const serviceConfig = config.services[service];
    if (!serviceConfig.apiKey) {
      throw new ApiError(
        503,
        `${service}_unconfigured`,
        `Set ${service.toUpperCase()}_API_KEY or keep server/config/${service}/config.xml`,
      );
    }

    const smartPick = input.options?.smartPick ?? true;
    const lookupTimeoutMs = Math.max(config.requestTimeoutMs, config.searchTimeoutMs);
    const client = createArrClient(
      service,
      serviceConfig,
      smartPick ? Math.max(lookupTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS) : lookupTimeoutMs,
    );
    const term = input.kind === "movie" ? `tmdb:${input.tmdbId}` : `tvdb:${input.tvdbId}`;
    const [lookupResult, libraryResult, profileResult, folderResult] = await Promise.allSettled([
      input.kind === "movie" ? client.lookupMovie(term) : client.lookupSeries(term),
      input.kind === "movie" ? client.listMovies() : client.listSeries(),
      client.getQualityProfiles(),
      client.getRootFolders(),
    ]);

    if (lookupResult.status === "rejected") {
      throw lookupResult.reason;
    }
    if (libraryResult.status === "rejected") {
      throw libraryResult.reason;
    }
    if (profileResult.status === "rejected") {
      throw profileResult.reason;
    }
    if (folderResult.status === "rejected") {
      throw folderResult.reason;
    }

    const response =
      input.kind === "movie"
        ? await addMovieRequest(client, config, events, input, lookupResult.value as ServarrMovieResource[], libraryResult.value as ServarrMovieResource[], profileResult.value, folderResult.value)
        : await addSeriesRequest(client, config, events, input, lookupResult.value as ServarrSeriesResource[], libraryResult.value as ServarrSeriesResource[], profileResult.value, folderResult.value);

    return response;
  });
}

async function loadRequestOptions(
  id: ArrServiceId,
  service: ServiceConfig,
  timeoutMs: number,
): Promise<ArrRequestOptions> {
  if (!service.apiKey) {
    return {
      id,
      state: "unconfigured",
      detail: `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`,
      qualityProfiles: [],
      rootFolders: [],
      defaults: defaultOptions(id),
    };
  }

  const client = createArrClient(id, service, timeoutMs);
  const [profileResult, folderResult] = await Promise.allSettled([
    client.getQualityProfiles(),
    client.getRootFolders(),
  ]);

  const profiles: ServarrQualityProfile[] =
    profileResult.status === "fulfilled" ? profileResult.value : [];
  const folders: ServarrRootFolder[] =
    folderResult.status === "fulfilled" ? folderResult.value : [];
  const failure = [profileResult, folderResult].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  if (failure) {
    return {
      id,
      state: stateForError(failure.reason),
      detail: errorMessage(failure.reason),
      qualityProfiles: toQualityProfiles(profiles),
      rootFolders: toRootFolders(folders),
      defaults: defaultOptions(id, profiles, folders),
    };
  }

  return {
    id,
    state: "ok",
    qualityProfiles: toQualityProfiles(profiles),
    rootFolders: toRootFolders(folders),
    defaults: defaultOptions(id, profiles, folders),
  };
}

function defaultOptions(
  id: ArrServiceId,
  profiles: ServarrQualityProfile[] = [],
  folders: ServarrRootFolder[] = [],
) {
  const profile = pickDefaultQualityProfile(profiles);
  const folder = pickDefaultRootFolder(folders);
  return {
    qualityProfileId: profile?.id,
    rootFolderPath: folder?.path,
    ...(id === "sonarr" ? { monitor: "all" as const } : {}),
    searchOnAdd: true,
    smartPick: true,
    minSeeders: DEFAULT_MIN_SEEDERS,
  };
}

async function addMovieRequest(
  client: ReturnType<typeof createArrClient>,
  config: AppConfig,
  events: ReleaseEventStore | undefined,
  input: CreateRequestInput,
  lookup: ServarrMovieResource[],
  library: ServarrMovieResource[],
  profiles: ServarrQualityProfile[],
  folders: ServarrRootFolder[],
): Promise<CreateRequestResponse> {
  const tmdbId = input.tmdbId;
  if (tmdbId === undefined) {
    throw new ApiError(400, "invalid_request", "tmdbId is required for a movie request");
  }
  const resource = lookup.find((movie) => movie.tmdbId === tmdbId);
  if (!resource) {
    throw new ApiError(404, "not_found", "Movie not found upstream");
  }

  const existing = library.find((movie) => movie.tmdbId === tmdbId);
  if (existing) {
    return {
      status: "already_exists",
      service: "radarr",
      title: existing.title ?? resource.title ?? "Unknown title",
      year: existing.year ?? resource.year,
      id: existing.id,
    };
  }

  const resolved = resolveOptions(profiles, folders, input.options);
  const smartPick = resolved.searchOnAdd && resolved.smartPick;
  const { id: _ignored, ...metadata } = resource;
  const added = await client.addMovie({
    ...metadata,
    qualityProfileId: resolved.qualityProfileId,
    rootFolderPath: resolved.rootFolderPath,
    monitored: true,
    minimumAvailability: "released",
    // When churn picks the release itself, Radarr must not start its own
    // quality-profile-only search and grab a dead 720p torrent in parallel.
    addOptions: { searchForMovie: smartPick ? false : resolved.searchOnAdd },
  });

  const mediaTitle = added.title ?? resource.title ?? "Unknown title";
  const downloads =
    smartPick && added.id !== undefined
      ? await smartPickMovie(client, config, events, added.id, mediaTitle, resolved)
      : [];

  return {
    status: "added",
    service: "radarr",
    title: mediaTitle,
    year: added.year ?? resource.year,
    id: added.id,
    ...(downloads.length > 0 ? { downloads } : {}),
  };
}

/**
 * Search Radarr's indexers, pick the fastest release that respects the quality
 * profile and clears the seeder gate, then grab it. Any failure falls back to
 * Radarr's own `MoviesSearch` command so a request always keeps working.
 */
async function smartPickMovie(
  client: ReturnType<typeof createArrClient>,
  config: AppConfig,
  events: ReleaseEventStore | undefined,
  movieId: number,
  mediaTitle: string,
  resolved: ResolvedOptions,
): Promise<RequestDownload[]> {
  try {
    const releases = await client.getMovieReleases(movieId);
    const pick = pickRelease(
      releases.map((release) => movieReleaseCandidate(release)),
      pickPolicy(resolved),
    );
    if (pick) {
      await grabPickedRelease(client, pick, { movieId });
      scheduleSwarmWatch({
        config,
        events,
        service: "radarr",
        mediaTitle,
        target: { movieId },
        release: pick.release,
        candidates: releases,
        preferredTier: pickPolicy(resolved).preferredTier,
        minSeeders: resolved.minSeeders,
      });
      return [toRequestDownload(pick)];
    }
  } catch {
    // Fall through to Radarr's own search; the title is already added.
  }

  await runSearchCommand(client, { name: "MoviesSearch", movieIds: [movieId] });
  return [];
}

async function addSeriesRequest(
  client: ReturnType<typeof createArrClient>,
  config: AppConfig,
  events: ReleaseEventStore | undefined,
  input: CreateRequestInput,
  lookup: ServarrSeriesResource[],
  library: ServarrSeriesResource[],
  profiles: ServarrQualityProfile[],
  folders: ServarrRootFolder[],
): Promise<CreateRequestResponse> {
  const tvdbId = input.tvdbId;
  if (tvdbId === undefined) {
    throw new ApiError(400, "invalid_request", "tvdbId is required for a series request");
  }
  const resource = lookup.find((series) => series.tvdbId === tvdbId);
  if (!resource) {
    throw new ApiError(404, "not_found", "Series not found upstream");
  }

  const existing = library.find((series) => series.tvdbId === tvdbId);
  if (existing) {
    return {
      status: "already_exists",
      service: "sonarr",
      title: existing.title ?? resource.title ?? "Unknown title",
      year: existing.year ?? resource.year,
      id: existing.id,
    };
  }

  const resolved = resolveOptions(profiles, folders, input.options);
  const monitor = input.options?.monitor ?? "all";
  const monitoredSeasons = monitorSeasons(resource.seasons, monitor);
  const smartPick =
    resolved.searchOnAdd &&
    resolved.smartPick &&
    monitor !== "none" &&
    monitor !== "future";
  const { id: _ignored, ...metadata } = resource;
  const added = await client.addSeries({
    ...metadata,
    qualityProfileId: resolved.qualityProfileId,
    rootFolderPath: resolved.rootFolderPath,
    monitored: true,
    seasonFolder: true,
    seasons: monitoredSeasons,
    addOptions: {
      monitor: arrMonitorName(monitor),
      searchForMissingEpisodes: smartPick ? false : resolved.searchOnAdd,
    },
  });

  const mediaTitle = added.title ?? resource.title ?? "Unknown title";
  const downloads =
    smartPick && added.id !== undefined
      ? await smartPickSeasons(
          client,
          config,
          events,
          added.id,
          mediaTitle,
          (monitoredSeasons ?? [])
            .filter((season) => season.monitored && season.seasonNumber > 0)
            .map((season) => season.seasonNumber),
          resolved,
        )
      : [];

  return {
    status: "added",
    service: "sonarr",
    title: mediaTitle,
    year: added.year ?? resource.year,
    id: added.id,
    ...(downloads.length > 0 ? { downloads } : {}),
  };
}

/**
 * Prefer well-seeded season packs for every monitored season. When a pack
 * covers several seasons, all of them are marked monitored before the grab so
 * Sonarr imports the whole pack rather than just the requested season. Seasons
 * without a usable pack fall back to Sonarr's own `SeasonSearch`, which still
 * picks individual episodes. A whole-series `SeriesSearch` is the last resort.
 */
async function smartPickSeasons(
  client: ReturnType<typeof createArrClient>,
  config: AppConfig,
  events: ReleaseEventStore | undefined,
  seriesId: number,
  mediaTitle: string,
  seasonNumbers: number[],
  resolved: ResolvedOptions,
): Promise<RequestDownload[]> {
  const uniqueSeasons = [...new Set(seasonNumbers)].sort((left, right) => left - right);
  if (uniqueSeasons.length === 0) {
    return [];
  }

  // Search every season first, then grab sequentially so two seasons cannot
  // pick the same multi-season pack and download it twice.
  const searched = await mapWithConcurrency(uniqueSeasons, 3, async (seasonNumber) => {
    try {
      return {
        seasonNumber,
        releases: await client.getSeasonReleases(seriesId, seasonNumber),
      };
    } catch {
      return { seasonNumber, releases: undefined };
    }
  });

  const downloads: RequestDownload[] = [];
  const claimedSeasons = new Set<number>();

  for (const { seasonNumber, releases } of searched) {
    if (claimedSeasons.has(seasonNumber)) {
      continue;
    }

    let grabbed = false;
    if (releases) {
      const packs: Array<{ release: ServarrRelease; seasons: number[] }> = [];
      for (const release of releases) {
        if (!releaseMatchesSeason(release, seasonNumber)) {
          continue;
        }
        const seasons = seasonPackSeasons(release, seasonNumber);
        // Do not re-grab a season another pack in this request already covers.
        if (!seasons || seasons.some((season) => claimedSeasons.has(season))) {
          continue;
        }
        packs.push({ release, seasons });
      }

      const pick = pickRelease(
        packs.map(({ release }) =>
          showReleaseCandidate(release, mappedEpisodeIds(release).length),
        ),
        pickPolicy(resolved),
      );
      const chosen = pick
        ? packs.find(({ release }) => release === pick.release)
        : undefined;
      // A below-threshold pack is worse than letting Sonarr search episode by
      // episode, which can find well-seeded single episodes instead.
      if (pick && chosen && pick.reason !== "below_threshold") {
        try {
          if (chosen.seasons.length > 1) {
            await monitorSeriesSeasons(client, seriesId, chosen.seasons);
          }
          await grabPickedRelease(client, pick, { seriesId });
          for (const season of chosen.seasons) {
            claimedSeasons.add(season);
          }
          scheduleSwarmWatch({
            config,
            events,
            service: "sonarr",
            mediaTitle,
            target: { seriesId },
            seasonNumber,
            release: pick.release,
            candidates: packs.map(({ release }) => release),
            preferredTier: pickPolicy(resolved).preferredTier,
            minSeeders: resolved.minSeeders,
          });
          downloads.push(toRequestDownload(pick, seasonNumber));
          grabbed = true;
        } catch {
          grabbed = false;
        }
      }
    }

    if (!grabbed && !claimedSeasons.has(seasonNumber)) {
      await runSearchCommand(client, {
        name: "SeasonSearch",
        seriesId,
        seasonNumber,
      });
    }
  }

  return downloads.sort(
    (left, right) => (left.seasonNumber ?? 0) - (right.seasonNumber ?? 0),
  );
}

async function grabPickedRelease(
  client: ReturnType<typeof createArrClient>,
  pick: ReleasePick<ServarrRelease>,
  target: { seriesId?: number; movieId?: number },
): Promise<void> {
  const episodeIds = mappedEpisodeIds(pick.release);
  const override = pick.requiresOverride || releaseNeedsOverride(pick.release);
  await client.grabRelease(
    buildReleaseGrabPayload(
      pick.release,
      target,
      override ? { override: true, episodeIds } : {},
    ),
  );
}

function toRequestDownload(
  pick: ReleasePick<ServarrRelease>,
  seasonNumber?: number,
): RequestDownload {
  return {
    title: pick.release.title?.trim() || "Release",
    quality: pick.release.quality?.quality?.name,
    seeders: pick.release.seeders,
    sizeBytes: pick.release.size,
    seasonNumber,
    reason: pick.reason,
    override: pick.requiresOverride || releaseNeedsOverride(pick.release),
  };
}

interface ScheduleSwarmWatchOptions {
  config: AppConfig;
  events: ReleaseEventStore | undefined;
  service: "sonarr" | "radarr";
  mediaTitle: string;
  target: { movieId?: number; seriesId?: number };
  seasonNumber?: number;
  release: ServarrRelease;
  candidates: ServarrRelease[];
  preferredTier?: number;
  minSeeders: number;
}

/**
 * Start a background check of the real swarm. It never blocks the request and
 * only runs when the release list has a plausible better-seeded alternative.
 */
function scheduleSwarmWatch(options: ScheduleSwarmWatchOptions): void {
  if (!options.config.qbittorrent.apiKey || !releaseIsTorrent(options.release)) {
    return;
  }

  const currentTier = releaseTier(options.release);
  const maxTier =
    options.preferredTier === undefined ? undefined : options.preferredTier + 1;
  const alternative = pickRepickRelease(
    options.candidates.map((release) => toCandidate(options.service, release)),
    {
      current: options.release,
      attempted: [],
      currentTier,
      preferredTier: options.preferredTier,
      maxTier,
      minSeeders: options.minSeeders,
      gainFactor: DEFAULT_SWARM_POLICY.minSeederGainFactor,
    },
  );
  if (!alternative) {
    return;
  }

  const arr = createArrClient(
    options.service,
    options.config.services[options.service],
    Math.max(options.config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
  );
  const torrents = createQbittorrentClient(
    options.config.qbittorrent,
    Math.max(options.config.requestTimeoutMs, 5_000),
  );

  void watchSwarm(
    {
      service: options.service,
      mediaTitle: options.mediaTitle,
      target: options.target,
      seasonNumber: options.seasonNumber,
      release: options.release,
      candidates: options.candidates,
      preferredTier: options.preferredTier,
      minSeeders: options.minSeeders,
    },
    {
      getQueue: () => arr.getQueue(),
      getTorrents: () => torrents.getTorrents(),
      removeQueueRecord: (queueId) =>
        arr.removeQueueRecord(queueId, {
          blocklist: true,
          skipRedownload: true,
        }),
      grab: async (release, override) => {
        try {
          await arr.grabRelease(
            buildReleaseGrabPayload(
              release,
              options.target,
              override
                ? { override: true, episodeIds: mappedEpisodeIds(release) }
                : {},
            ),
          );
        } catch (error) {
          // The stalled download is already gone; make sure the arr searches
          // again instead of leaving the title with nothing queued.
          await runSearchCommand(
            arr,
            options.service === "radarr"
              ? { name: "MoviesSearch", movieIds: [options.target.movieId] }
              : options.seasonNumber !== undefined
                ? {
                    name: "SeasonSearch",
                    seriesId: options.target.seriesId,
                    seasonNumber: options.seasonNumber,
                  }
                : { name: "SeriesSearch", seriesId: options.target.seriesId },
          );
          throw error;
        }
      },
      onRepick: (event) => {
        options.events?.record(event);
      },
    },
  ).catch(() => {
    // The watch is best effort; the download and the arr stay authoritative.
  });
}

function toCandidate(service: "sonarr" | "radarr", release: ServarrRelease) {
  return service === "sonarr"
    ? showReleaseCandidate(release, mappedEpisodeIds(release).length)
    : movieReleaseCandidate(release);
}

async function runSearchCommand(
  client: ReturnType<typeof createArrClient>,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await client.runCommand(payload);
  } catch {
    // The title is already added; a failed search command must not fail the request.
  }
}

interface ResolvedOptions {
  qualityProfileId: number;
  qualityProfileName?: string;
  rootFolderPath: string;
  searchOnAdd: boolean;
  smartPick: boolean;
  minSeeders: number;
}

function resolveOptions(
  profiles: ServarrQualityProfile[],
  folders: ServarrRootFolder[],
  options: RequestOptionsInput | undefined,
): ResolvedOptions {
  const defaultProfile = pickDefaultQualityProfile(profiles);
  const qualityProfileId = options?.qualityProfileId ?? defaultProfile?.id;
  if (qualityProfileId === undefined || !profiles.some((profile) => profile.id === qualityProfileId)) {
    throw new ApiError(400, "invalid_quality_profile", "Choose an available quality profile");
  }

  const defaultFolder = pickDefaultRootFolder(folders);
  const rootFolderPath = options?.rootFolderPath ?? defaultFolder?.path;
  const folder = folders.find((entry) => entry.path === rootFolderPath);
  if (!folder) {
    throw new ApiError(400, "invalid_root_folder", "Choose an available root folder");
  }
  if (!folder.accessible) {
    throw new ApiError(400, "root_folder_inaccessible", `Root folder is not accessible: ${folder.path}`);
  }

  return {
    qualityProfileId,
    qualityProfileName: profiles.find((profile) => profile.id === qualityProfileId)?.name,
    rootFolderPath: folder.path,
    searchOnAdd: options?.searchOnAdd ?? true,
    smartPick: options?.smartPick ?? true,
    minSeeders: options?.minSeeders ?? DEFAULT_MIN_SEEDERS,
  };
}

function pickPolicy(resolved: ResolvedOptions) {
  return {
    preferredTier: qualityTierFromName(resolved.qualityProfileName),
    minSeeders: resolved.minSeeders,
  };
}

function parseCreateRequest(value: unknown): CreateRequestInput {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_request", "Request body must be an object");
  }
  const kind = value.kind;
  if (kind !== "movie" && kind !== "series") {
    throw new ApiError(400, "invalid_kind", "kind must be movie or series");
  }

  const input: CreateRequestInput = { kind: kind satisfies RequestKind };
  if (kind === "movie") {
    input.tmdbId = positiveInteger(value.tmdbId, "tmdbId");
  } else {
    input.tvdbId = positiveInteger(value.tvdbId, "tvdbId");
  }

  if (value.options !== undefined) {
    if (!isRecord(value.options)) {
      throw new ApiError(400, "invalid_options", "options must be an object");
    }
    input.options = parseRequestOptions(value.options);
  }
  return input;
}

function parseRequestOptions(value: Record<string, unknown>): RequestOptionsInput {
  const options: RequestOptionsInput = {};
  if (value.qualityProfileId !== undefined) {
    options.qualityProfileId = positiveInteger(value.qualityProfileId, "qualityProfileId");
  }
  if (value.rootFolderPath !== undefined) {
    if (typeof value.rootFolderPath !== "string" || !value.rootFolderPath.trim()) {
      throw new ApiError(400, "invalid_root_folder", "rootFolderPath must be a non-empty string");
    }
    options.rootFolderPath = value.rootFolderPath;
  }
  if (value.monitor !== undefined) {
    if (!isMonitor(value.monitor)) {
      throw new ApiError(400, "invalid_monitor", "monitor must be all, firstSeason, future or none");
    }
    options.monitor = value.monitor;
  }
  if (value.searchOnAdd !== undefined) {
    if (typeof value.searchOnAdd !== "boolean") {
      throw new ApiError(400, "invalid_search_on_add", "searchOnAdd must be a boolean");
    }
    options.searchOnAdd = value.searchOnAdd;
  }
  if (value.smartPick !== undefined) {
    if (typeof value.smartPick !== "boolean") {
      throw new ApiError(400, "invalid_smart_pick", "smartPick must be a boolean");
    }
    options.smartPick = value.smartPick;
  }
  if (value.minSeeders !== undefined) {
    if (
      typeof value.minSeeders !== "number" ||
      !Number.isSafeInteger(value.minSeeders) ||
      value.minSeeders < 0 ||
      value.minSeeders > 1000
    ) {
      throw new ApiError(
        400,
        "invalid_min_seeders",
        "minSeeders must be an integer between 0 and 1000",
      );
    }
    options.minSeeders = value.minSeeders;
  }
  return options;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "invalid_request", `${name} must be a positive integer`);
  }
  return value;
}

function isMonitor(value: unknown): value is RequestMonitor {
  return value === "all" || value === "firstSeason" || value === "future" || value === "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
