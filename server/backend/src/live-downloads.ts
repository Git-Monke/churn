import type { AppConfig } from "./config.js";
import { movieTorrentActivity } from "./qbittorrent-activity.js";
import { mapShowTorrentDownloads } from "./qbittorrent-show.js";
import type { ActivityItem, ShowAvailability, ShowDownload } from "./types.js";
import { createQbittorrentClient, type QbittorrentTorrent } from "./upstream/qbittorrent.js";

export interface MovieDownloadIdentity {
  title: string;
  year?: number;
}

export interface ShowEpisodeIdentity {
  key: string;
  seasonNumber: number;
  episodeNumber: number;
  availability: ShowAvailability;
  imported?: boolean;
}

export interface ShowDownloadIdentity {
  title: string;
  episodes: ShowEpisodeIdentity[];
}

export interface LiveDownloadStore {
  rememberMovie(key: string, identity: MovieDownloadIdentity): void;
  movie(key: string): MovieDownloadIdentity | undefined;
  rememberShow(key: string, identity: ShowDownloadIdentity): void;
  show(key: string): ShowDownloadIdentity | undefined;
}

export interface LiveDownloadStoreOptions {
  /** How long a cached movie/show identity stays usable. */
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Movie and show identities change rarely, so the fast download endpoints reuse
 * what the full detail route already loaded instead of re-reading Jellyfin,
 * Sonarr or Radarr on every 500ms poll.
 */
export function createLiveDownloadStore(
  options: LiveDownloadStoreOptions = {},
): LiveDownloadStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const movies = new Map<string, CacheEntry<MovieDownloadIdentity>>();
  const shows = new Map<string, CacheEntry<ShowDownloadIdentity>>();

  function read<T>(entries: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const cached = entries.get(key);
    if (!cached) {
      return undefined;
    }
    if (now() >= cached.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    return cached.value;
  }

  function write<T>(entries: Map<string, CacheEntry<T>>, key: string, value: T): void {
    entries.set(key, { value, expiresAt: now() + ttlMs });
  }

  return {
    rememberMovie(key, identity) {
      write(movies, key, identity);
    },
    movie(key) {
      return read(movies, key);
    },
    rememberShow(key, identity) {
      write(shows, key, identity);
    },
    show(key) {
      return read(shows, key);
    },
  };
}

/** Shared read-only qBittorrent lookup used by the detail and fast routes. */
export async function loadQbittorrentTorrents(
  config: AppConfig,
): Promise<QbittorrentTorrent[]> {
  if (!config.qbittorrent.apiKey) {
    return [];
  }
  const client = createQbittorrentClient(
    config.qbittorrent,
    Math.min(config.requestTimeoutMs, 2_000),
  );
  return client.getTorrents();
}

export async function movieLiveDownload(
  config: AppConfig,
  identity: MovieDownloadIdentity,
): Promise<ActivityItem | undefined> {
  const torrents = await loadQbittorrentTorrents(config);
  return movieTorrentActivity(torrents, identity);
}

export async function showLiveDownloads(
  config: AppConfig,
  identity: ShowDownloadIdentity,
): Promise<Record<string, ShowDownload>> {
  const torrents = await loadQbittorrentTorrents(config);
  const mapped = mapShowTorrentDownloads(torrents, identity.title, identity.episodes);
  const episodes = new Map(identity.episodes.map((episode) => [episode.key, episode]));
  const downloads: Record<string, ShowDownload> = {};
  for (const [key, download] of mapped) {
    const episode = episodes.get(key);
    // Mirror the full detail route: a finished torrent that is still seeding is
    // not worth showing once Jellyfin has the episode. Keep active upgrades.
    const staleImport =
      download.status === "importing" &&
      episode !== undefined &&
      (episode.availability === "jellyfin" || episode.imported === true);
    if (!staleImport) {
      downloads[key] = download;
    }
  }
  return downloads;
}
