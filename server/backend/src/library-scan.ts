import type { AppConfig } from "./config.js";
import { createJellyfinClient } from "./upstream/jellyfin.js";
import {
  createQbittorrentClient,
  type QbittorrentTorrent,
} from "./upstream/qbittorrent.js";

/** How often the backend checks qBittorrent for newly completed downloads. */
export const DEFAULT_SCAN_INTERVAL_MS = 1_000;
/** Completed torrents first seen within this window still start a scan. */
export const DEFAULT_RECENT_COMPLETION_MS = 10 * 60_000;
/** Drop state for torrents that have not appeared in qBittorrent for this long. */
const STATE_TTL_MS = 60 * 60_000;

export interface LibraryScanWatcherOptions {
  now?: () => number;
  refresh?: () => Promise<void>;
  getTorrents?: () => Promise<QbittorrentTorrent[]>;
  intervalMs?: number;
  recentCompletionMs?: number;
}

export interface LibraryScanWatcher {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
}

interface TorrentState {
  complete: boolean;
  lastSeenAt: number;
}

/** True once qBittorrent has all of the torrent's data. */
export function isTorrentDownloadComplete(torrent: QbittorrentTorrent): boolean {
  if (
    typeof torrent.progress === "number" &&
    Number.isFinite(torrent.progress)
  ) {
    return torrent.progress >= 1;
  }
  return (
    torrent.amount_left === 0 &&
    typeof torrent.size === "number" &&
    Number.isFinite(torrent.size) &&
    torrent.size > 0
  );
}

/** Best-effort Jellyfin refresh shared by the watcher and cancel/delete. */
export async function refreshJellyfinLibrary(config: AppConfig): Promise<void> {
  const service = config.services.jellyfin;
  if (!service.apiKey) {
    return;
  }
  const client = createJellyfinClient(service, config.requestTimeoutMs);
  await client.refreshLibrary();
}

/**
 * Watch qBittorrent for downloads that just completed and ask Jellyfin to scan.
 * The watcher runs independently of the dashboard so a completion is not missed
 * when no browser is open.
 */
export function createLibraryScanWatcher(
  config: AppConfig,
  options: LibraryScanWatcherOptions = {},
): LibraryScanWatcher {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const recentCompletionMs =
    options.recentCompletionMs ?? DEFAULT_RECENT_COMPLETION_MS;
  const refresh = options.refresh ?? (() => refreshJellyfinLibrary(config));
  const getTorrents =
    options.getTorrents ??
    (() =>
      createQbittorrentClient(
        config.qbittorrent,
        Math.min(config.requestTimeoutMs, 2_000),
      ).getTorrents());

  const states = new Map<string, TorrentState>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let refreshing = false;
  let scanPending = false;

  const enabled = Boolean(config.qbittorrent.apiKey && config.services.jellyfin.apiKey);

  async function runScan(): Promise<void> {
    if (refreshing) {
      scanPending = true;
      return;
    }
    refreshing = true;
    try {
      do {
        scanPending = false;
        try {
          await refresh();
        } catch {
          // Jellyfin scans are best-effort; the next completion can try again.
        }
      } while (scanPending);
    } finally {
      refreshing = false;
    }
  }

  async function pollOnce(): Promise<void> {
    if (!enabled || polling) {
      return;
    }
    polling = true;
    try {
      const torrents = await getTorrents();
      const seenAt = now();
      const seen = new Set<string>();
      let completed = false;

      for (const torrent of torrents) {
        const key = torrentKey(torrent);
        if (!key) {
          continue;
        }
        seen.add(key);
        const complete = isTorrentDownloadComplete(torrent);
        const previous = states.get(key);

        if (!previous) {
          states.set(key, { complete, lastSeenAt: seenAt });
          if (complete && isRecentCompletion(torrent, seenAt, recentCompletionMs)) {
            completed = true;
          }
          continue;
        }

        if (!previous.complete && complete) {
          completed = true;
        }
        previous.complete = complete;
        previous.lastSeenAt = seenAt;
      }

      pruneStates(states, seen, seenAt);

      if (completed) {
        await runScan();
      }
    } catch {
      // qBittorrent may be restarting or temporarily unreachable. Keep polling.
    } finally {
      polling = false;
    }
  }

  return {
    start(): void {
      if (timer || !enabled) {
        return;
      }
      timer = setInterval(() => {
        void pollOnce();
      }, intervalMs);
      timer.unref?.();
      void pollOnce();
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    pollOnce,
  };
}

function torrentKey(torrent: QbittorrentTorrent): string | undefined {
  for (const value of [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]) {
    const key = value?.trim().toLowerCase();
    if (key) {
      return key;
    }
  }
  return undefined;
}

function isRecentCompletion(
  torrent: QbittorrentTorrent,
  now: number,
  recentCompletionMs: number,
): boolean {
  const completedAt = torrent.completion_on;
  if (
    typeof completedAt !== "number" ||
    !Number.isFinite(completedAt) ||
    completedAt <= 0
  ) {
    return false;
  }
  return now - completedAt * 1_000 <= recentCompletionMs;
}

function pruneStates(
  states: Map<string, TorrentState>,
  seen: Set<string>,
  now: number,
): void {
  for (const [key, state] of states) {
    if (seen.has(key)) {
      continue;
    }
    if (now - state.lastSeenAt >= STATE_TTL_MS) {
      states.delete(key);
    }
  }
}
