import type { ActivityItem, ActivityStatus } from "./types.js";
import { mediaCoverUrl } from "./search.js";
import type { ServarrMovieResource, ServarrQueueRecord, ServarrSeriesResource } from "./upstream/servarr.js";

const ACTIVE_STATUSES = new Set(["queued", "downloading"]);
const ACTIVE_IMPORT_STATES = new Set(["importpending", "importing", "importblocked"]);
const INACTIVE_STATES = new Set(["imported", "downloadfailed", "failed"]);

export interface ActivityAggregate {
  queueCount: number;
  status: ActivityStatus;
  progress: number;
  sizeBytes?: number;
  sizeLeftBytes?: number;
  /** Sum of live qBittorrent download speeds over unique downloads. */
  downloadSpeedBytes?: number;
  /** Seeds currently connected to the torrents in this item. */
  connectedSeeders?: number;
  /** Seeds the trackers report for the swarm. */
  swarmSeeders?: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  downloadClients: string[];
  protocols: Array<"torrent" | "usenet">;
  quality?: string;
  statusMessages?: string[];
  seasons?: number[];
}

export interface ActivityMetadata {
  title?: string;
  year?: number;
  overview?: string;
  network?: string;
  rating?: number;
  runtimeMinutes?: number;
  imageUrl?: string;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

interface BuildActivityItemOptions {
  service: "sonarr" | "radarr";
  kind: "movie" | "series";
  mediaId?: number;
  key?: string;
  records: ServarrQueueRecord[];
  metadata?: ActivityMetadata;
}

export function isActiveQueueRecord(record: ServarrQueueRecord): boolean {
  const status = normalize(record.status);
  const state = normalize(record.trackedDownloadState);

  if (INACTIVE_STATES.has(state) || status === "failed") {
    return false;
  }
  if (ACTIVE_STATUSES.has(status) || ACTIVE_IMPORT_STATES.has(state)) {
    return true;
  }
  // Sonarr reports status "warning" for some records that are still
  // downloading, for example when the download client reports a non-fatal
  // warning. Keep those records unless their tracked state is terminal.
  return status === "warning";
}

export function filterActiveQueueRecords(records: ServarrQueueRecord[]): ServarrQueueRecord[] {
  return records.filter(isActiveQueueRecord);
}

export function isSeasonPack(record: ServarrQueueRecord): boolean {
  return Number.isInteger(record.seasonNumber) && record.episodeId === undefined;
}

/**
 * Seasons represented by a queue record. Sonarr can attach every episode of a
 * multi-season pack to one season in the API, but the release title still says
 * which seasons the download covers (for example `S01-03`).
 */
export function queueRecordSeasons(record: ServarrQueueRecord): number[] {
  const fromTitle = seasonRangeFromTitle(record.title);
  if (fromTitle.length > 0) {
    return fromTitle;
  }
  return Number.isInteger(record.seasonNumber) ? [record.seasonNumber as number] : [];
}

/** Expand `S01-03` / `Season 1-3` into [1, 2, 3]. */
export function seasonRangeFromTitle(title: string | undefined): number[] {
  if (!title) {
    return [];
  }
  const match = title.match(
    /(?:^|[^A-Za-z0-9])(?:S|Season)\s*0*(\d{1,3})\s*[-–]\s*(?:S|Season)?\s*0*(\d{1,3})(?![A-Za-z0-9])/i,
  );
  if (!match) {
    return [];
  }
  const start = Number.parseInt(match[1] ?? "", 10);
  const end = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end - start > 50
  ) {
    return [];
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function queueRecordProgress(record: ServarrQueueRecord): number {
  const size = finite(record.size);
  const sizeLeft = finite(record.sizeleft);
  if (size === undefined || sizeLeft === undefined || size <= 0) {
    return 0;
  }
  return clampProgress(((size - sizeLeft) / size) * 100);
}

export function queueRecordStatus(record: ServarrQueueRecord): ActivityStatus {
  const state = normalize(record.trackedDownloadState);
  const tracked = normalize(record.trackedDownloadStatus);
  if (tracked === "warning" || tracked === "error") {
    return "warning";
  }
  const status = normalize(record.status);
  if (ACTIVE_IMPORT_STATES.has(state)) {
    return "importing";
  }
  if (status === "queued") {
    return "queued";
  }
  if (state === "downloading" || status === "downloading") {
    return "downloading";
  }
  return "queued";
}

export function aggregateQueueRecords(records: ServarrQueueRecord[]): ActivityAggregate {
  const queueCount = records.length;
  const downloads = uniqueQueueDownloads(records);
  const sizes = downloads
    .map((record) => ({ size: finite(record.size), sizeLeft: finite(record.sizeleft) }))
    .filter(
      (entry): entry is { size: number; sizeLeft: number } =>
        entry.size !== undefined && entry.sizeLeft !== undefined && entry.size > 0,
    );
  const totalSize = sizes.reduce((sum, entry) => sum + entry.size, 0);
  const totalLeft = sizes.reduce((sum, entry) => sum + entry.sizeLeft, 0);

  const progress =
    totalSize > 0
      ? clampProgress(((totalSize - totalLeft) / totalSize) * 100)
      : downloads.length > 0
        ? clampProgress(
            downloads.reduce((sum, record) => sum + queueRecordProgress(record), 0) /
              downloads.length,
          )
        : 0;

  const aggregate: ActivityAggregate = {
    queueCount,
    status: aggregateStatus(records),
    progress,
    downloadClients: uniqueStrings(records.map((record) => record.downloadClient)),
    protocols: uniqueProtocols(records.map((record) => record.protocol)),
    statusMessages: statusMessages(records),
  };

  if (totalSize > 0) {
    aggregate.sizeBytes = totalSize;
    aggregate.sizeLeftBytes = totalLeft;
  }

  const downloadSpeedBytes = downloads.reduce(
    (sum, record) => sum + (finite(record.downloadSpeed) ?? 0),
    0,
  );
  if (downloadSpeedBytes > 0) {
    aggregate.downloadSpeedBytes = downloadSpeedBytes;
  }

  const etaRecord = records
    .filter((record) => record.estimatedCompletionTime)
    .sort((left, right) =>
      String(left.estimatedCompletionTime).localeCompare(String(right.estimatedCompletionTime)),
    )[0];
  if (etaRecord?.estimatedCompletionTime) {
    aggregate.estimatedCompletionTime = etaRecord.estimatedCompletionTime;
  }
  const timeLeftRecord = etaRecord ?? records.find((record) => record.timeleft);
  if (timeLeftRecord?.timeleft) {
    aggregate.timeLeft = timeLeftRecord.timeleft;
  }

  const quality = records
    .map((record) => record.quality?.quality?.name)
    .find((value): value is string => Boolean(value));
  if (quality) {
    aggregate.quality = quality;
  }

  const seasons = uniqueNumbers(records.flatMap((record) => queueRecordSeasons(record)));
  if (seasons.length > 0) {
    aggregate.seasons = seasons;
  }

  return aggregate;
}

export function buildActivityItem(options: BuildActivityItemOptions): ActivityItem | null {
  const { service, kind, mediaId, records, metadata } = options;
  if (records.length === 0) {
    return null;
  }
  const title = metadata?.title?.trim() || records[0]?.title?.trim();
  if (!title) {
    return null;
  }

  const aggregate = aggregateQueueRecords(records);
  const item: ActivityItem = {
    key: options.key ?? activityKey(kind, service, mediaId, metadata),
    service,
    kind,
    title,
    queueCount: aggregate.queueCount,
    status: aggregate.status,
    progress: aggregate.progress,
    downloadClients: aggregate.downloadClients,
    protocols: aggregate.protocols,
  };

  assignIfDefined(item, "year", metadata?.year);
  assignIfDefined(item, "overview", metadata?.overview);
  assignIfDefined(item, "network", metadata?.network);
  assignIfDefined(item, "rating", metadata?.rating);
  assignIfDefined(item, "runtimeMinutes", metadata?.runtimeMinutes);
  assignIfDefined(item, "imageUrl", metadata?.imageUrl);
  assignIfDefined(item, "tmdbId", metadata?.tmdbId);
  assignIfDefined(item, "tvdbId", metadata?.tvdbId);
  assignIfDefined(item, "imdbId", metadata?.imdbId);
  assignIfDefined(item, "sizeBytes", aggregate.sizeBytes);
  assignIfDefined(item, "sizeLeftBytes", aggregate.sizeLeftBytes);
  assignIfDefined(item, "downloadSpeedBytes", aggregate.downloadSpeedBytes);
  assignIfDefined(item, "connectedSeeders", aggregate.connectedSeeders);
  assignIfDefined(item, "swarmSeeders", aggregate.swarmSeeders);
  assignIfDefined(item, "timeLeft", aggregate.timeLeft);
  assignIfDefined(item, "estimatedCompletionTime", aggregate.estimatedCompletionTime);
  assignIfDefined(item, "quality", aggregate.quality);
  assignIfDefined(item, "statusMessages", aggregate.statusMessages);
  assignIfDefined(item, "seasons", aggregate.seasons);
  if (kind === "movie") {
    assignIfDefined(item, "movieId", mediaId);
  } else {
    assignIfDefined(item, "seriesId", mediaId);
  }

  return item;
}

export function buildSeriesActivityItem(
  seriesId: number,
  records: ServarrQueueRecord[],
  series?: ServarrSeriesResource,
): ActivityItem | null {
  return buildActivityItem({
    service: "sonarr",
    kind: "series",
    mediaId: seriesId,
    records,
    metadata: series ? seriesMetadata(series) : undefined,
  });
}

export function buildMovieActivityItem(
  movieId: number,
  records: ServarrQueueRecord[],
  movie?: ServarrMovieResource,
): ActivityItem | null {
  return buildActivityItem({
    service: "radarr",
    kind: "movie",
    mediaId: movieId,
    records,
    metadata: movie ? movieMetadata(movie) : undefined,
  });
}

export function seriesMetadata(series: ServarrSeriesResource): ActivityMetadata {
  return {
    title: series.title,
    year: series.year,
    overview: series.overview,
    network: series.network,
    rating: finite(series.ratings?.value),
    runtimeMinutes: finite(series.runtime),
    imageUrl: mediaCoverUrl("sonarr", series.images),
    tmdbId: series.tmdbId,
    tvdbId: series.tvdbId,
    imdbId: series.imdbId,
  };
}

export function movieMetadata(movie: ServarrMovieResource): ActivityMetadata {
  return {
    title: movie.title,
    year: movie.year,
    overview: movie.overview,
    network: movie.studio,
    rating: finite(movie.ratings?.imdb?.value ?? movie.ratings?.tmdb?.value),
    runtimeMinutes: finite(movie.runtime),
    imageUrl: mediaCoverUrl("radarr", movie.images),
    tmdbId: movie.tmdbId,
    imdbId: movie.imdbId,
  };
}

function activityKey(
  kind: "movie" | "series",
  service: "sonarr" | "radarr",
  mediaId: number | undefined,
  metadata: ActivityMetadata | undefined,
): string {
  if (kind === "movie") {
    if (metadata?.tmdbId !== undefined) {
      return `movie:${metadata.tmdbId}`;
    }
    return mediaId === undefined ? `movie:${service}` : `movie:${service}:${mediaId}`;
  }
  if (metadata?.tvdbId !== undefined) {
    return `series:${metadata.tvdbId}`;
  }
  return mediaId === undefined ? `series:${service}` : `series:${service}:${mediaId}`;
}

function aggregateStatus(records: ServarrQueueRecord[]): ActivityStatus {
  const statuses = records.map(queueRecordStatus);
  if (statuses.includes("warning")) {
    return "warning";
  }
  if (statuses.includes("importing")) {
    return "importing";
  }
  if (statuses.includes("downloading")) {
    return "downloading";
  }
  return "queued";
}

function statusMessages(records: ServarrQueueRecord[]): string[] | undefined {
  const messages = records.flatMap((record) =>
    (record.statusMessages ?? []).flatMap((message) => [
      ...(message.title ? [message.title] : []),
      ...(message.messages ?? []),
    ]),
  );
  const unique = uniqueStrings(messages);
  return unique.length > 0 ? unique : undefined;
}

/**
 * Sonarr queues one record per episode for a season pack, all sharing the same
 * download id. Count the underlying download once when totalling bytes.
 */
function uniqueQueueDownloads(records: ServarrQueueRecord[]): ServarrQueueRecord[] {
  const seen = new Set<string>();
  const downloads: ServarrQueueRecord[] = [];
  for (const record of records) {
    const key =
      record.downloadId !== undefined
        ? `download:${record.downloadId}`
        : record.id !== undefined
          ? `record:${record.id}`
          : `record:${record.title ?? ""}:${record.size ?? ""}:${record.sizeleft ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    downloads.push(record);
  }
  return downloads;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function uniqueProtocols(values: Array<string | undefined>): Array<"torrent" | "usenet"> {
  const protocols: Array<"torrent" | "usenet"> = [];
  for (const value of values) {
    if ((value === "torrent" || value === "usenet") && !protocols.includes(value)) {
      protocols.push(value);
    }
  }
  return protocols;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => Number.isInteger(value)))].sort(
    (left, right) => left - right,
  );
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
