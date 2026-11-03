import type { AppConfig } from "./config.js";
import {
  buildQbittorrentActivity,
  isActiveTorrent,
  type ActivityCatalog,
} from "./qbittorrent-activity.js";
import type { ActivityResponse, ActivityServiceState } from "./types.js";
import { errorMessage, stateForError } from "./upstream/states.js";
import {
  createArrClient,
  type ServarrMovieResource,
  type ServarrSeriesResource,
} from "./upstream/servarr.js";
import { createQbittorrentClient } from "./upstream/qbittorrent.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface ActivityFeedOptions {
  now?: () => number;
  /** How long a whole activity snapshot is reused before re-reading qBittorrent. */
  snapshotTtlMs?: number;
  /** How long the Sonarr/Radarr catalog used for title matching is reused. */
  metadataTtlMs?: number;
}

export interface ActivityFeed {
  get(): Promise<ActivityResponse>;
}

/**
 * The UI polls this frequently, so requests need to be cheap. A snapshot cache
 * coalesces every browser tab into one qBittorrent refresh, and the catalog
 * cache keeps the per-title library lookups out of the hot path.
 */
const DEFAULT_SNAPSHOT_TTL_MS = 400;
const DEFAULT_METADATA_TTL_MS = 5 * 60_000;

export function createActivityFeed(
  config: AppConfig,
  options: ActivityFeedOptions = {},
): ActivityFeed {
  const now = options.now ?? Date.now;
  const snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const catalogTtlMs = options.metadataTtlMs ?? DEFAULT_METADATA_TTL_MS;

  let snapshot: CacheEntry<ActivityResponse> | undefined;
  let inFlight: Promise<ActivityResponse> | undefined;
  let seriesCache: CacheEntry<ServarrSeriesResource[]> | undefined;
  let movieCache: CacheEntry<ServarrMovieResource[]> | undefined;

  async function loadCatalog(): Promise<ActivityCatalog> {
    const [series, movies] = await Promise.all([
      loadCachedSeries(config, now, catalogTtlMs, () => seriesCache, (entry) => {
        seriesCache = entry;
      }),
      loadCachedMovies(config, now, catalogTtlMs, () => movieCache, (entry) => {
        movieCache = entry;
      }),
    ]);
    return { series, movies };
  }

  async function load(): Promise<ActivityResponse> {
    const [catalog, qbittorrent] = await Promise.all([
      loadCatalog(),
      loadQbittorrent(config),
    ]);
    const items = buildQbittorrentActivity(qbittorrent.torrents, catalog);

    return {
      checkedAt: new Date(now()).toISOString(),
      services: [qbittorrent.status],
      items,
      total: items.length,
    };
  }

  return {
    get(): Promise<ActivityResponse> {
      if (snapshot && now() < snapshot.expiresAt) {
        return Promise.resolve(snapshot.value);
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = load()
        .then((response) => {
          snapshot = { value: response, expiresAt: now() + snapshotTtlMs };
          return response;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}

async function loadCachedSeries(
  config: AppConfig,
  now: () => number,
  ttlMs: number,
  getCache: () => CacheEntry<ServarrSeriesResource[]> | undefined,
  setCache: (entry: CacheEntry<ServarrSeriesResource[]>) => void,
): Promise<ServarrSeriesResource[]> {
  const cached = getCache();
  if (cached && now() < cached.expiresAt) {
    return cached.value;
  }
  const service = config.services.sonarr;
  if (!service.apiKey) {
    return [];
  }
  try {
    const client = createArrClient("sonarr", service, config.requestTimeoutMs);
    const value = await client.listSeries();
    setCache({ value, expiresAt: now() + ttlMs });
    return value;
  } catch {
    return [];
  }
}

async function loadCachedMovies(
  config: AppConfig,
  now: () => number,
  ttlMs: number,
  getCache: () => CacheEntry<ServarrMovieResource[]> | undefined,
  setCache: (entry: CacheEntry<ServarrMovieResource[]>) => void,
): Promise<ServarrMovieResource[]> {
  const cached = getCache();
  if (cached && now() < cached.expiresAt) {
    return cached.value;
  }
  const service = config.services.radarr;
  if (!service.apiKey) {
    return [];
  }
  try {
    const client = createArrClient("radarr", service, config.requestTimeoutMs);
    const value = await client.listMovies();
    setCache({ value, expiresAt: now() + ttlMs });
    return value;
  } catch {
    return [];
  }
}

async function loadQbittorrent(config: AppConfig): Promise<{
  torrents: Awaited<ReturnType<ReturnType<typeof createQbittorrentClient>["getTorrents"]>>;
  status: ActivityServiceState;
}> {
  if (!config.qbittorrent.apiKey) {
    return {
      torrents: [],
      status: {
        id: "qbittorrent",
        state: "unconfigured",
        detail: "Set QBITTORRENT_API_KEY or keep the seeded qBittorrent config file",
        count: 0,
      },
    };
  }
  try {
    const client = createQbittorrentClient(
      config.qbittorrent,
      Math.min(config.requestTimeoutMs, 2_000),
    );
    const torrents = await client.getTorrents();
    return {
      torrents,
      status: {
        id: "qbittorrent",
        state: "ok",
        count: torrents.filter(isActiveTorrent).length,
      },
    };
  } catch (error) {
    return {
      torrents: [],
      status: {
        id: "qbittorrent",
        state: stateForError(error),
        detail: errorMessage(error),
        count: 0,
      },
    };
  }
}
