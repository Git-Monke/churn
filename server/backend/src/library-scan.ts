import { seasonRangeFromTitle } from "./activity.js";
import type { AppConfig } from "./config.js";
import { isDirectDownloadTorrent } from "./direct-grab.js";
import { isCompletedTorrent } from "./download-import.js";
import {
  createJellyfinClient,
  providerString,
  type JellyfinItem,
} from "./upstream/jellyfin.js";
import { seasonNumberFromTitle } from "./qbittorrent-show.js";
import { createQbittorrentClient, type QbittorrentTorrent } from "./upstream/qbittorrent.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrHistoryRecord,
} from "./upstream/servarr.js";

/** How often the backend checks the arrs and qBittorrent for finished downloads. */
export const DEFAULT_SCAN_INTERVAL_MS = 5_000;
/** Imports older than this are treated as already handled at startup. */
export const DEFAULT_RECENT_IMPORT_MS = 10 * 60_000;
/** How long an import may take to appear in Jellyfin before churn re-scans. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 90_000;
/** How often the resolution check looks at Jellyfin while it scans. */
export const DEFAULT_RESOLVE_POLL_MS = 5_000;
/** How often a completed direct download asks Jellyfin to scan again. */
export const DEFAULT_DIRECT_REFRESH_MS = 15_000;
/** How long a completed direct download keeps asking Jellyfin to scan. */
export const DEFAULT_DIRECT_RETRY_WINDOW_MS = 10 * 60_000;
/**
 * `history/since` returns rows newer than the timestamp, so asking again from
 * exactly the newest row would drop imports that share its second. Re-ask from
 * slightly before it and dedupe by history id instead.
 */
const SINCE_OVERLAP_MS = 60_000;
/** Forget history ids after this long; the overlap window is much shorter. */
const STATE_TTL_MS = 60 * 60_000;

/** A download that an arr finished importing into the media folders. */
export interface ImportEvent {
  service: ArrServiceId;
  /** Servarr history row id. Stable, so the same import is only scanned once. */
  id: number;
  /** ISO 8601 timestamp of the import. */
  date: string;
  seriesId?: number;
  movieId?: number;
  title?: string;
}

export interface LibraryScanWatcherOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  refresh?: () => Promise<void>;
  getImports?: (since: string) => Promise<ImportEvent[]>;
  /** qBittorrent torrents used to notice finished direct downloads. */
  getTorrents?: () => Promise<QbittorrentTorrent[]>;
  /** Returns the imports that are not visible in Jellyfin yet. */
  resolve?: (imports: ImportEvent[]) => Promise<ImportEvent[]>;
  /** True once Jellyfin exposes a completed direct download. */
  resolveDirect?: (torrent: QbittorrentTorrent) => Promise<boolean>;
  intervalMs?: number;
  recentImportMs?: number;
  resolveTimeoutMs?: number;
  resolvePollMs?: number;
  directRefreshMs?: number;
  directRetryWindowMs?: number;
}

export interface LibraryScanWatcher {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
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
 * Watch Sonarr and Radarr for finished imports and ask Jellyfin to scan.
 *
 * qBittorrent hitting 100% is the wrong signal: the arr still has to move (or
 * hardlink) the files into the library, and a Jellyfin scan started before that
 * finishes indexes nothing. The arr's `downloadFolderImported` history event is
 * emitted after the move, so churn triggers on that instead, then checks that
 * the item actually became visible and rescans once if it did not.
 *
 * churn-direct downloads never reach an arr, so for those qBittorrent's
 * completion state is the signal: the files were saved straight into the
 * library path and only need a Jellyfin scan. They are tracked until Jellyfin
 * exposes them, with a refresh requested every 15 seconds for up to 10 minutes.
 *
 * The watcher runs independently of the dashboard so an import is not missed
 * when no browser is open.
 */
export function createLibraryScanWatcher(
  config: AppConfig,
  options: LibraryScanWatcherOptions = {},
): LibraryScanWatcher {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const recentImportMs = options.recentImportMs ?? DEFAULT_RECENT_IMPORT_MS;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const resolvePollMs = options.resolvePollMs ?? DEFAULT_RESOLVE_POLL_MS;
  const directRefreshMs = options.directRefreshMs ?? DEFAULT_DIRECT_REFRESH_MS;
  const directRetryWindowMs =
    options.directRetryWindowMs ?? DEFAULT_DIRECT_RETRY_WINDOW_MS;
  const refresh = options.refresh ?? (() => refreshJellyfinLibrary(config));
  const getImports = options.getImports ?? ((since: string) => fetchImports(config, since));
  const getTorrents =
    options.getTorrents ??
    (() => createQbittorrentClient(config.qbittorrent, config.requestTimeoutMs).getTorrents());
  const resolve =
    options.resolve ?? ((imports: ImportEvent[]) => findUnresolved(config, imports));
  const resolveDirect =
    options.resolveDirect ?? ((torrent: QbittorrentTorrent) => isDirectDownloadIndexed(config, torrent));

  const jellyfinEnabled = Boolean(config.services.jellyfin.apiKey);
  const directEnabled = jellyfinEnabled && Boolean(config.qbittorrent.apiKey);
  const enabled =
    jellyfinEnabled &&
    Boolean(
      config.services.sonarr.apiKey ||
      config.services.radarr.apiKey ||
      directEnabled,
    );

  let since = new Date(now() - recentImportMs).toISOString();
  const seen = new Map<string, number>();
  const pendingDirect = new Map<string, DirectPending>();
  /** Direct torrents that were indexed or exhausted their retry window. */
  const finishedDirect = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;

  async function pollOnce(): Promise<void> {
    if (!enabled || polling) {
      return;
    }
    polling = true;
    try {
      // Direct downloads never reach Sonarr/Radarr, so their imports do not
      // appear in arr history. A finished churn-direct torrent is already in
      // the library path; keep asking Jellyfin to index it until it appears.
      await pollDirectCompletions();

      let imports: ImportEvent[];
      try {
        imports = await getImports(since);
      } catch {
        // Both arrs may be restarting. Keep the old cursor and try next poll.
        return;
      }

      advanceCursor(imports);
      const fresh = imports.filter((event) => !seen.has(importKey(event)));
      if (fresh.length === 0) {
        pruneSeen(seen, now());
        return;
      }
      const markedAt = now();
      for (const event of fresh) {
        seen.set(importKey(event), markedAt);
      }
      pruneSeen(seen, markedAt);

      await runScan(fresh);
    } finally {
      polling = false;
    }
  }

  /**
   * Track finished direct downloads and keep asking Jellyfin to scan until it
   * exposes the media, or until the retry window runs out.
   */
  async function pollDirectCompletions(): Promise<void> {
    if (!directEnabled) {
      return;
    }
    let torrents: QbittorrentTorrent[];
    try {
      torrents = await getTorrents();
    } catch {
      // qBittorrent may be restarting; the next poll can still catch the import.
      return;
    }

    const current = now();
    const cutoff = current - recentImportMs;
    for (const torrent of torrents) {
      if (!isDirectDownloadTorrent(torrent) || !isCompletedTorrent(torrent)) {
        continue;
      }
      const completedAt = (torrent.completion_on ?? torrent.added_on ?? 0) * 1_000;
      if (completedAt < cutoff) {
        continue;
      }
      const key = `${torrent.hash ?? torrent.infohash_v1 ?? torrent.name ?? ""}:${completedAt}`;
      if (finishedDirect.has(key)) {
        continue;
      }
      const pending = pendingDirect.get(key);
      if (pending) {
        pending.torrent = torrent;
      } else {
        pendingDirect.set(key, { torrent, firstSeenAt: current });
      }
    }

    let needsRefresh = false;
    for (const [key, pending] of pendingDirect) {
      if (current - pending.firstSeenAt >= directRetryWindowMs) {
        pendingDirect.delete(key);
        finishedDirect.set(key, current);
        continue;
      }

      let visible: boolean;
      try {
        visible = await resolveDirect(pending.torrent);
      } catch {
        // Jellyfin is temporarily unreachable; do not rescan blindly.
        continue;
      }
      if (visible) {
        pendingDirect.delete(key);
        finishedDirect.set(key, current);
        continue;
      }

      if (
        pending.lastRefreshAt !== undefined &&
        current - pending.lastRefreshAt < directRefreshMs
      ) {
        continue;
      }
      pending.lastRefreshAt = current;
      needsRefresh = true;
    }

    for (const [key, finishedAt] of finishedDirect) {
      if (current - finishedAt >= recentImportMs) {
        finishedDirect.delete(key);
      }
    }

    if (needsRefresh) {
      await tryRefresh();
    }
  }

  /** Refresh, then give Jellyfin a chance to index; retry the refresh once. */
  async function runScan(imports: ImportEvent[]): Promise<void> {
    await tryRefresh();
    let unresolved = await waitForResolution(imports, resolveTimeoutMs);
    if (unresolved.length === 0) {
      return;
    }
    // A scan that started before the arr finished writing its hardlinks finds
    // nothing. One retry covers that; after it churn gives up, because Jellyfin's
    // real-time monitoring (enabled by the installer) also picks the files up.
    await tryRefresh();
    await waitForResolution(unresolved, resolveTimeoutMs);
  }

  async function waitForResolution(
    pending: ImportEvent[],
    timeoutMs: number,
  ): Promise<ImportEvent[]> {
    const deadline = now() + timeoutMs;
    let remaining = pending;
    for (;;) {
      try {
        remaining = await resolve(remaining);
      } catch {
        // Cannot verify right now; do not rescan blindly.
        return [];
      }
      if (remaining.length === 0 || now() >= deadline) {
        return remaining;
      }
      await sleep(Math.min(resolvePollMs, Math.max(0, deadline - now())));
    }
  }

  async function tryRefresh(): Promise<void> {
    try {
      await refresh();
    } catch {
      // Jellyfin scans are best-effort; a later import can try again.
    }
  }

  function advanceCursor(imports: ImportEvent[]): void {
    const current = Date.parse(since);
    let newest = Number.isFinite(current) ? current : 0;
    for (const event of imports) {
      const parsed = Date.parse(event.date);
      if (Number.isFinite(parsed) && parsed > newest) {
        newest = parsed;
      }
    }
    if (newest > current) {
      since = new Date(newest - SINCE_OVERLAP_MS).toISOString();
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

/** Import rows from every configured arr; a broken arr does not block the other. */
async function fetchImports(config: AppConfig, since: string): Promise<ImportEvent[]> {
  const services: ArrServiceId[] = ["sonarr", "radarr"];
  const settled = await Promise.allSettled(
    services.map(async (service) => {
      const serviceConfig = config.services[service];
      if (!serviceConfig.apiKey) {
        return [];
      }
      const client = createArrClient(
        service,
        serviceConfig,
        Math.min(config.requestTimeoutMs, 5_000),
      );
      const records = await client.getImportsSince(since);
      return records.flatMap((record) => toImportEvent(service, record));
    }),
  );
  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

function toImportEvent(service: ArrServiceId, record: ServarrHistoryRecord): ImportEvent[] {
  if (record.eventType !== undefined && record.eventType !== "downloadFolderImported") {
    return [];
  }
  if (typeof record.id !== "number" || record.date === undefined) {
    return [];
  }
  const date = new Date(record.date);
  if (!Number.isFinite(date.getTime())) {
    return [];
  }
  const event: ImportEvent = { service, id: record.id, date: date.toISOString() };
  if (service === "sonarr" && typeof record.seriesId === "number") {
    event.seriesId = record.seriesId;
  }
  if (service === "radarr" && typeof record.movieId === "number") {
    event.movieId = record.movieId;
  }
  if (record.sourceTitle) {
    event.title = record.sourceTitle;
  }
  return [event];
}

interface DirectPending {
  torrent: QbittorrentTorrent;
  firstSeenAt: number;
  lastRefreshAt?: number;
}

/**
 * True when Jellyfin exposes a completed direct download. Use the same Jellyfin
 * series/episode and movie data the show and movie pages use; the item path only
 * locates the item inside the library.
 */
export async function isDirectDownloadIndexed(
  config: AppConfig,
  torrent: QbittorrentTorrent,
): Promise<boolean> {
  const contentPath = torrent.content_path?.trim();
  if (!contentPath) {
    return false;
  }
  const jellyfin = createJellyfinClient(config.services.jellyfin, config.requestTimeoutMs);
  const [seriesResult, moviesResult] = await Promise.allSettled([
    jellyfin.listItemsByType("Series"),
    jellyfin.listItemsByType("Movie"),
  ]);
  if (seriesResult.status === "rejected" && moviesResult.status === "rejected") {
    throw seriesResult.reason;
  }
  const items = [
    ...(seriesResult.status === "fulfilled" ? seriesResult.value : []),
    ...(moviesResult.status === "fulfilled" ? moviesResult.value : []),
  ];
  const item = findItemForContentPath(items, contentPath);
  if (!item?.Id) {
    return false;
  }
  if (item.Type === "Movie") {
    return Boolean(item.Path);
  }
  if (item.Type !== "Series") {
    return false;
  }

  const episodes = await jellyfin.getEpisodes(item.Id);
  const seasons = directDownloadSeasons(torrent);
  if (seasons.length === 0) {
    return episodes.length > 0;
  }
  return episodes.some(
    (episode) =>
      typeof episode.ParentIndexNumber === "number" &&
      seasons.includes(episode.ParentIndexNumber),
  );
}

function directDownloadSeasons(torrent: QbittorrentTorrent): number[] {
  const name = torrent.name?.trim() ?? "";
  const fromName = seasonRangeFromTitle(name);
  if (fromName.length > 0) {
    return fromName;
  }
  const single = seasonNumberFromTitle(name);
  if (single !== undefined) {
    return [single];
  }
  const fromPath = torrent.content_path?.match(
    /(?:^|\/)Season[ ._-]*0*(\d{1,3})(?:\/|$)/i,
  );
  if (!fromPath) {
    return [];
  }
  const season = Number.parseInt(fromPath[1] ?? "", 10);
  return Number.isInteger(season) ? [season] : [];
}

function findItemForContentPath(
  items: JellyfinItem[],
  contentPath: string,
): JellyfinItem | undefined {
  let best: JellyfinItem | undefined;
  let bestLength = -1;
  for (const item of items) {
    const itemPath = item.Path?.trim();
    if (!itemPath || !pathsOverlap(itemPath, contentPath)) {
      continue;
    }
    if (itemPath.length > bestLength) {
      best = item;
      bestLength = itemPath.length;
    }
  }
  return best;
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/, "");
  const normalizedRight = right.replace(/\/+$/, "");
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

/**
 * Which imports Jellyfin has not linked yet. A series counts as resolved once it
 * has at least one season and episode: a series row without children is exactly
 * the half-indexed state an early scan leaves behind.
 */
async function findUnresolved(
  config: AppConfig,
  imports: ImportEvent[],
): Promise<ImportEvent[]> {
  const jellyfin = createJellyfinClient(config.services.jellyfin, config.requestTimeoutMs);
  const [seriesResult, moviesResult] = await Promise.allSettled([
    jellyfin.listItemsByType("Series"),
    jellyfin.listItemsByType("Movie"),
  ]);
  if (seriesResult.status === "rejected" && moviesResult.status === "rejected") {
    return [];
  }
  const series = seriesResult.status === "fulfilled" ? seriesResult.value : [];
  const movies = moviesResult.status === "fulfilled" ? moviesResult.value : [];

  const unresolved: ImportEvent[] = [];
  const checked = new Map<string, boolean>();

  for (const event of imports) {
    const target = targetKey(event);
    if (target === undefined) {
      continue;
    }
    let resolved = checked.get(target);
    if (resolved === undefined) {
      resolved = await isResolved(config, jellyfin, event, series, movies);
      checked.set(target, resolved);
    }
    if (!resolved) {
      unresolved.push(event);
    }
  }
  return unresolved;
}

async function isResolved(
  config: AppConfig,
  jellyfin: ReturnType<typeof createJellyfinClient>,
  event: ImportEvent,
  series: JellyfinItem[],
  movies: JellyfinItem[],
): Promise<boolean> {
  try {
    if (event.service === "sonarr" && event.seriesId !== undefined) {
      const sonarr = createArrClient(
        "sonarr",
        config.services.sonarr,
        Math.min(config.requestTimeoutMs, 5_000),
      );
      const tvdbId = (await sonarr.getSeries(event.seriesId)).tvdbId;
      if (tvdbId === undefined) {
        return true;
      }
      const item = findByProvider(series, "tvdb", tvdbId);
      if (!item?.Id) {
        return false;
      }
      const [seasons, episodes] = await Promise.allSettled([
        jellyfin.getSeasons(item.Id),
        jellyfin.getEpisodes(item.Id),
      ]);
      const hasSeasons = seasons.status === "fulfilled" && seasons.value.length > 0;
      const hasEpisodes = episodes.status === "fulfilled" && episodes.value.length > 0;
      return hasSeasons && hasEpisodes;
    }

    if (event.service === "radarr" && event.movieId !== undefined) {
      const radarr = createArrClient(
        "radarr",
        config.services.radarr,
        Math.min(config.requestTimeoutMs, 5_000),
      );
      const tmdbId = (await radarr.getMovie(event.movieId)).tmdbId;
      if (tmdbId === undefined) {
        return true;
      }
      const item = findByProvider(movies, "tmdb", tmdbId);
      return Boolean(item?.Id && item.Path);
    }

    return true;
  } catch {
    // A lookup failure is not evidence that Jellyfin missed the import.
    return true;
  }
}

function findByProvider(
  items: JellyfinItem[],
  provider: string,
  value: number,
): JellyfinItem | undefined {
  const expected = String(value);
  return items.find((item) => providerString(item, provider) === expected);
}

function targetKey(event: ImportEvent): string | undefined {
  if (event.service === "sonarr" && event.seriesId !== undefined) {
    return `sonarr:${event.seriesId}`;
  }
  if (event.service === "radarr" && event.movieId !== undefined) {
    return `radarr:${event.movieId}`;
  }
  return undefined;
}

function importKey(event: ImportEvent): string {
  return `${event.service}:${event.id}`;
}

function pruneSeen(seen: Map<string, number>, at: number): void {
  for (const [key, markedAt] of seen) {
    if (at - markedAt >= STATE_TTL_MS) {
      seen.delete(key);
    }
  }
}
