import type { StatsDiskUsage, StatsQbittorrent, StatsTopItem } from "./types.js";
import { parseMediaDownloadTag } from "./direct-grab.js";
import type {
  QbittorrentMainData,
  QbittorrentServerState,
  QbittorrentTorrent,
} from "./upstream/qbittorrent.js";
import type {
  ServarrDiskSpace,
  ServarrMovieResource,
  ServarrRootFolder,
  ServarrSeriesResource,
} from "./upstream/servarr.js";

/**
 * Transfer totals come from qBittorrent; capacity and free space both come
 * from a single arr `/diskspace` record so they describe the same mount.
 */
export interface StatsAggregationInput {
  mainData?: QbittorrentMainData;
  diskSpace?: ServarrDiskSpace[];
  rootFolders?: ServarrRootFolder[];
}

export interface StatsAggregate {
  qbittorrent?: StatsQbittorrent;
  disk?: StatsDiskUsage;
}

/** Aggregate raw qBittorrent/Sonarr data into the stats response shape. */
export function aggregateStats(input: StatsAggregationInput): StatsAggregate {
  const result: StatsAggregate = {};
  const qbittorrent = parseTransferTotals(input.mainData?.server_state);
  if (qbittorrent !== undefined) {
    result.qbittorrent = qbittorrent;
  }
  const disk = aggregateDiskUsage(input.diskSpace, input.rootFolders);
  if (disk !== undefined) {
    result.disk = disk;
  }
  return result;
}

/** How many entries each stats list shows. */
export const TOP_STATS_LIMIT = 5;

export interface StatsLibrary {
  series?: ServarrSeriesResource[];
  movies?: ServarrMovieResource[];
}

/** Rank the torrents qBittorrent still knows about by lifetime transfer. */
export function rankTorrents(
  torrents: QbittorrentTorrent[] | undefined,
  metric: "downloaded" | "uploaded",
  library?: StatsLibrary,
  limit = TOP_STATS_LIMIT,
): StatsTopItem[] {
  const titles = libraryTitles(library);
  const entries = (torrents ?? [])
    .map((torrent) => {
      const media = parseMediaDownloadTag(torrent.tags);
      const mapped = media ? titles.get(`${media.kind}:${media.arrId}`) : undefined;
      return {
        name: mapped ?? torrent.name ?? "Untitled torrent",
        bytes: nonNegative(torrent[metric]) ?? 0,
        ...(media ? { kind: media.kind } : {}),
        ...(mapped && torrent.name ? { detail: torrent.name } : {}),
      };
    })
    .filter((entry) => entry.bytes > 0);

  // A mapped title alone cannot tell two season packs apart; keep the release
  // name only for those collisions so unique titles stay clean.
  const titleCounts = new Map<string, number>();
  for (const entry of entries) {
    titleCounts.set(entry.name, (titleCounts.get(entry.name) ?? 0) + 1);
  }

  return entries
    .map((entry) =>
      entry.detail && titleCounts.get(entry.name) === 1
        ? { name: entry.name, bytes: entry.bytes, ...(entry.kind ? { kind: entry.kind } : {}) }
        : entry,
    )
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

/** Rank Sonarr series and Radarr movies by the bytes each occupies. */
export function rankStorage(
  library: StatsLibrary | undefined,
  limit = TOP_STATS_LIMIT,
): StatsTopItem[] {
  const entries: StatsTopItem[] = [];
  for (const series of library?.series ?? []) {
    const bytes = nonNegative(series.statistics?.sizeOnDisk) ?? 0;
    if (bytes > 0 && series.title) {
      entries.push({ name: series.title, bytes, kind: "series" });
    }
  }
  for (const movie of library?.movies ?? []) {
    const bytes = nonNegative(movie.statistics?.sizeOnDisk) ?? 0;
    if (bytes > 0 && movie.title) {
      entries.push({ name: movie.title, bytes, kind: "movie" });
    }
  }
  return entries.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

function libraryTitles(library: StatsLibrary | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  for (const series of library?.series ?? []) {
    if (series.id !== undefined && series.title) {
      titles.set(`series:${series.id}`, series.title);
    }
  }
  for (const movie of library?.movies ?? []) {
    if (movie.id !== undefined && movie.title) {
      titles.set(`movie:${movie.id}`, movie.title);
    }
  }
  return titles;
}

export function parseTransferTotals(
  serverState: QbittorrentServerState | undefined,
): StatsQbittorrent | undefined {
  const downloaded = nonNegative(serverState?.alltime_dl);
  const uploaded = nonNegative(serverState?.alltime_ul);
  if (downloaded === undefined && uploaded === undefined) {
    return undefined;
  }
  return {
    totalDownloadedBytes: downloaded ?? 0,
    totalUploadedBytes: uploaded ?? 0,
  };
}

/**
 * Pick the arr disk-space entry that backs the library. Root folders are the
 * concrete paths (`/data/media/tv`); `/diskspace` reports their mount (`/data`).
 */
export function selectDiskSpace(
  diskSpace: ServarrDiskSpace[] | undefined,
  rootFolders: ServarrRootFolder[] | undefined,
): ServarrDiskSpace | undefined {
  const candidates = (diskSpace ?? []).filter((entry) => {
    const total = nonNegative(entry.totalSpace);
    return typeof entry.path === "string" && entry.path !== "" && total !== undefined && total > 0;
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const roots = (rootFolders ?? [])
    .map((folder) => folder.path)
    .filter((path): path is string => typeof path === "string" && path !== "");

  const matching = candidates
    .filter((entry) => roots.some((root) => isPathWithin(root, entry.path)))
    .sort((a, b) => b.path.length - a.path.length);
  if (matching.length > 0) {
    return matching[0];
  }

  return candidates.sort(
    (a, b) => (nonNegative(b.totalSpace) ?? 0) - (nonNegative(a.totalSpace) ?? 0),
  )[0];
}

export function aggregateDiskUsage(
  diskSpace: ServarrDiskSpace[] | undefined,
  rootFolders?: ServarrRootFolder[],
): StatsDiskUsage | undefined {
  const entry = selectDiskSpace(diskSpace, rootFolders);
  const totalBytes = nonNegative(entry?.totalSpace);
  const entryFreeBytes = nonNegative(entry?.freeSpace);
  if (totalBytes === undefined || totalBytes <= 0 || entryFreeBytes === undefined) {
    return undefined;
  }

  // Total and free must come from the same `/diskspace` record. qBittorrent's
  // `free_space_on_disk` describes its download directory, which may live on a
  // different filesystem than the library mount (downloads on the system disk,
  // media on a bulk disk) and would inflate the used figure.
  const freeBytes = Math.min(entryFreeBytes, totalBytes);
  const usedBytes = totalBytes - freeBytes;
  const usedPercent = roundPercent((usedBytes / totalBytes) * 100);

  return { totalBytes, freeBytes, usedBytes, usedPercent };
}

/** True when `root` is `mount` itself or lives underneath it. */
export function isPathWithin(root: string, mount: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  const normalizedMount = mount.replace(/\/+$/, "");
  if (normalizedMount === "") {
    return true;
  }
  if (normalizedRoot === normalizedMount) {
    return true;
  }
  return normalizedRoot.startsWith(`${normalizedMount}/`);
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundPercent(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 10) / 10;
}
