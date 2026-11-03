import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { movieMetadataEntry, seriesMetadataEntry, type MediaCache } from "../media-cache.js";
import type { ReleaseSearchService } from "../release-search.js";
import {
  pickDefaultQualityProfile,
  pickDefaultRootFolder,
  toQualityProfiles,
  toRootFolders,
} from "../search.js";
import type {
  ArrRequestOptions,
  CreateRequestInput,
  CreateRequestResponse,
  RequestOptionsInput,
  RequestOptionsResponse,
} from "../types.js";
import { errorMessage, stateForError } from "../upstream/states.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrMovieResource,
  type ServarrQualityProfile,
  type ServarrRootFolder,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";

export function registerRequestRoutes(
  app: FastifyInstance,
  config: AppConfig,
  mediaCache: MediaCache,
  releaseSearch: ReleaseSearchService,
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

    const timeoutMs = Math.max(config.requestTimeoutMs, config.searchTimeoutMs);
    const client = createArrClient(service, serviceConfig, timeoutMs);
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

    return input.kind === "movie"
      ? addMovieRequest(
          client,
          mediaCache,
          releaseSearch,
          input,
          lookupResult.value as ServarrMovieResource[],
          libraryResult.value as ServarrMovieResource[],
          profileResult.value,
          folderResult.value,
        )
      : addSeriesRequest(
          client,
          mediaCache,
          releaseSearch,
          input,
          lookupResult.value as ServarrSeriesResource[],
          libraryResult.value as ServarrSeriesResource[],
          profileResult.value,
          folderResult.value,
        );
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
  _id: ArrServiceId,
  profiles: ServarrQualityProfile[] = [],
  folders: ServarrRootFolder[] = [],
) {
  const profile = pickDefaultQualityProfile(profiles);
  const folder = pickDefaultRootFolder(folders);
  return {
    qualityProfileId: profile?.id,
    rootFolderPath: folder?.path,
  };
}

async function addMovieRequest(
  client: ReturnType<typeof createArrClient>,
  mediaCache: MediaCache,
  releaseSearch: ReleaseSearchService,
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
    const entry = movieMetadataEntry(existing);
    if (entry) {
      await mediaCache.putMovie(entry);
    }
    return {
      status: "already_exists",
      service: "radarr",
      title: existing.title ?? resource.title ?? "Unknown title",
      year: existing.year ?? resource.year,
      id: existing.id,
    };
  }

  const resolved = resolveOptions(profiles, folders, input.options);
  const { id: _ignored, ...metadata } = resource;
  const added = await client.addMovie({
    ...metadata,
    qualityProfileId: resolved.qualityProfileId,
    rootFolderPath: resolved.rootFolderPath,
    monitored: false,
    minimumAvailability: "released",
    addOptions: { searchForMovie: false },
  });

  const entry = movieMetadataEntry(added) ?? movieMetadataEntry(resource);
  if (entry) {
    await mediaCache.putMovie(entry);
  }
  if (added.id !== undefined) {
    void releaseSearch.warmMovie(added.id);
  }

  const mediaTitle = added.title ?? resource.title ?? "Unknown title";
  return {
    status: "added",
    service: "radarr",
    title: mediaTitle,
    year: added.year ?? resource.year,
    id: added.id,
    searching: added.id !== undefined,
  };
}

async function addSeriesRequest(
  client: ReturnType<typeof createArrClient>,
  mediaCache: MediaCache,
  releaseSearch: ReleaseSearchService,
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
    const entry = seriesMetadataEntry(existing);
    if (entry) {
      await mediaCache.putSeries(entry);
    }
    return {
      status: "already_exists",
      service: "sonarr",
      title: existing.title ?? resource.title ?? "Unknown title",
      year: existing.year ?? resource.year,
      id: existing.id,
    };
  }

  const resolved = resolveOptions(profiles, folders, input.options);
  const seasons = (resource.seasons ?? []).map((season) => ({
    ...season,
    monitored: false,
  }));
  const { id: _ignored, ...metadata } = resource;
  const added = await client.addSeries({
    ...metadata,
    qualityProfileId: resolved.qualityProfileId,
    rootFolderPath: resolved.rootFolderPath,
    monitored: false,
    seasonFolder: true,
    seasons,
    addOptions: {
      monitor: "none",
      searchForMissingEpisodes: false,
    },
  });

  const entry = seriesMetadataEntry(added) ?? seriesMetadataEntry(resource);
  if (entry) {
    await mediaCache.putSeries(entry);
    if (added.id !== undefined) {
      void releaseSearch.warmSeries(added.id, entry.seasons);
    }
  }

  const mediaTitle = added.title ?? resource.title ?? "Unknown title";
  return {
    status: "added",
    service: "sonarr",
    title: mediaTitle,
    year: added.year ?? resource.year,
    id: added.id,
    searching: added.id !== undefined,
  };
}


interface ResolvedOptions {
  qualityProfileId: number;
  rootFolderPath: string;
}

function resolveOptions(
  profiles: ServarrQualityProfile[],
  folders: ServarrRootFolder[],
  options: RequestOptionsInput | undefined,
): ResolvedOptions {
  const defaultProfile = pickDefaultQualityProfile(profiles);
  const qualityProfileId = options?.qualityProfileId ?? defaultProfile?.id;
  if (
    qualityProfileId === undefined ||
    !profiles.some((profile) => profile.id === qualityProfileId)
  ) {
    throw new ApiError(400, "invalid_quality_profile", "Choose an available quality profile");
  }

  const defaultFolder = pickDefaultRootFolder(folders);
  const rootFolderPath = options?.rootFolderPath ?? defaultFolder?.path;
  const folder = folders.find((entry) => entry.path === rootFolderPath);
  if (!folder) {
    throw new ApiError(400, "invalid_root_folder", "Choose an available root folder");
  }
  if (!folder.accessible) {
    throw new ApiError(
      400,
      "root_folder_inaccessible",
      `Root folder is not accessible: ${folder.path}`,
    );
  }

  return {
    qualityProfileId,
    rootFolderPath: folder.path,
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

  const input: CreateRequestInput = { kind };
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
  return options;
}

function positiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
