import { movieMetadata, queueRecordSeasons, seriesMetadata } from "./activity.js";
import { parseMediaDownloadTag } from "./direct-grab.js";
import {
  isAwaitingMetadata,
  metadataStatusMessage,
  metadataWaitExpired,
} from "./metadata-wait.js";
import { formatDuration } from "./torrent-progress.js";
import type { ActivityItem, ActivityStatus } from "./types.js";
import {
  qualityFromTitle,
  seasonNumberFromTitle,
  tokenize,
  torrentBelongsToShow,
} from "./qbittorrent-show.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import type {
  ServarrMovieResource,
  ServarrSeriesResource,
} from "./upstream/servarr.js";

const INFINITE_ETA_SECONDS = 8_640_000;

const MOVIE_RELEASE_MARKER =
  /^(?:19|20)\d{2}$|^(?:2160p?|1080p?|720p?|480p?)$|^(?:bluray|blu-ray|brrip|br|webrip|web|web-dl|webdl|dl|hdtv|dvdrip|dvd|remux)$|^(?:x264|x265|h264|h265|hevc|av1|hdr|sdr|uhd|hd)$|^(?:proper|repack|extended|unrated|imax)$/i;

export interface ActivityCatalog {
  series: ServarrSeriesResource[];
  movies: ServarrMovieResource[];
}

export interface QbittorrentActivityOptions {
  now?: () => number;
}

interface SeriesMatch {
  kind: "series";
  key: string;
  resource: ServarrSeriesResource;
  score: number;
}

interface MovieMatch {
  kind: "movie";
  key: string;
  resource: ServarrMovieResource;
  score: number;
}

type CatalogMatch = SeriesMatch | MovieMatch;

interface ActivityBucket {
  key: string;
  kind: "movie" | "series";
  service?: "sonarr" | "radarr";
  title: string;
  metadata?: ReturnType<typeof seriesMetadata> | ReturnType<typeof movieMetadata>;
  arrId?: number;
  torrents: QbittorrentTorrent[];
}

/** Active means still downloading; completed/seeding torrents are not shown. */
export function isActiveTorrent(torrent: QbittorrentTorrent): boolean {
  const progress = fraction(torrent.progress);
  const size = positive(torrent.size);
  const amountLeft = nonNegative(torrent.amount_left);
  if (progress !== undefined && progress >= 0.999) {
    return false;
  }
  if (progress === undefined && amountLeft === 0 && size !== undefined) {
    return false;
  }

  const state = (torrent.state ?? "").trim().toLowerCase();
  if (state.endsWith("up") || state === "uploading") {
    return false;
  }
  return true;
}

/**
 * Group qBittorrent's active downloads by the local Sonarr/Radarr catalog.
 * Sonarr/Radarr are used only for titles and ids; all status comes from qBit.
 */
export function buildQbittorrentActivity(
  torrents: QbittorrentTorrent[],
  catalog: ActivityCatalog,
  options: QbittorrentActivityOptions = {},
): ActivityItem[] {
  const now = options.now?.() ?? Date.now();
  const buckets = new Map<string, ActivityBucket>();

  for (const torrent of torrents) {
    if (!isActiveTorrent(torrent)) {
      continue;
    }
    const name = torrent.name?.trim();
    if (!name) {
      continue;
    }

    const link = parseMediaDownloadTag(torrent.tags);
    const match =
      taggedCatalogMatch(link, catalog) ??
      matchCatalog(name, torrent.category, catalog) ??
      matchSavePathMovie(torrent, catalog);
    const key = match?.key ?? (link ? mediaLinkKey(link) : genericKey(torrent, name));
    const existing = buckets.get(key);
    if (existing) {
      existing.torrents.push(torrent);
      continue;
    }

    const fallbackTitle = displayTitle(mediaTitleFromTorrent(torrent) ?? name);
    if (match?.kind === "series") {
      buckets.set(key, {
        key,
        kind: "series",
        service: "sonarr",
        title: match.resource.title?.trim() || fallbackTitle,
        metadata: seriesMetadata(match.resource),
        arrId: match.resource.id,
        torrents: [torrent],
      });
    } else if (match?.kind === "movie") {
      buckets.set(key, {
        key,
        kind: "movie",
        service: "radarr",
        title: match.resource.title?.trim() || fallbackTitle,
        metadata: movieMetadata(match.resource),
        arrId: match.resource.id,
        torrents: [torrent],
      });
    } else {
      buckets.set(key, {
        key,
        kind: link?.kind ?? (looksLikeSeries(name) ? "series" : "movie"),
        ...(link
          ? {
              service: link.kind === "movie" ? ("radarr" as const) : ("sonarr" as const),
              arrId: link.arrId,
            }
          : {}),
        title: fallbackTitle,
        torrents: [torrent],
      });
    }
  }

  return [...buckets.values()].map((bucket) => buildActivityItem(bucket, now));
}

function taggedCatalogMatch(
  link: ReturnType<typeof parseMediaDownloadTag>,
  catalog: ActivityCatalog,
): CatalogMatch | undefined {
  if (!link) {
    return undefined;
  }
  if (link.kind === "movie") {
    const movie = catalog.movies.find((entry) => entry.id === link.arrId);
    return movie
      ? { kind: "movie", key: movieKey(movie), resource: movie, score: Number.MAX_SAFE_INTEGER }
      : undefined;
  }
  const series = catalog.series.find((entry) => entry.id === link.arrId);
  return series
    ? { kind: "series", key: seriesKey(series), resource: series, score: Number.MAX_SAFE_INTEGER }
    : undefined;
}

function mediaLinkKey(link: { kind: "movie" | "series"; arrId: number }): string {
  return link.kind === "movie" ? `movie:radarr:${link.arrId}` : `series:sonarr:${link.arrId}`;
}

function matchCatalog(
  name: string,
  category: string | undefined,
  catalog: ActivityCatalog,
): CatalogMatch | undefined {
  const categoryName = (category ?? "").trim().toLowerCase().split("/")[0];
  const obviouslySeries = looksLikeSeries(name);
  const seriesAllowed = categoryName === "tv" || categoryName === "series" || obviouslySeries;
  const movieAllowed =
    categoryName === "movies" ||
    categoryName === "movie" ||
    categoryName === "films" ||
    (!seriesAllowed && categoryName === "");

  let best: CatalogMatch | undefined;

  if (seriesAllowed) {
    const titleTokens = tokenize(name);
    for (const series of catalog.series) {
      const title = series.title?.trim();
      if (!title) {
        continue;
      }
      const wanted = tokenize(title);
      if (wanted.length === 0 || !torrentBelongsToShow(name, wanted)) {
        continue;
      }
      const match: SeriesMatch = {
        kind: "series",
        key: seriesKey(series),
        resource: series,
        score: wanted.length,
      };
      if (!best || match.score > best.score) {
        best = match;
      }
    }
    if (best) {
      return best;
    }
    // A title tokenization is not needed below; keep the name available for
    // debugging without retaining a large temporary array.
    void titleTokens;
  }

  if (movieAllowed) {
    for (const movie of catalog.movies) {
      const title = movie.title?.trim();
      if (!title || !movieTitleMatches(name, title, movie.year)) {
        continue;
      }
      const match: MovieMatch = {
        kind: "movie",
        key: movieKey(movie),
        resource: movie,
        score: tokenize(title).length,
      };
      if (!best || match.score > best.score) {
        best = match;
      }
    }
  }

  return best;
}

/** Torrents linked to or naming this movie, including completed ones. */
export function matchMovieTorrents(
  torrents: QbittorrentTorrent[],
  movieTitle: string,
  year?: number,
  radarrId?: number,
): QbittorrentTorrent[] {
  return torrents.filter((torrent) => {
    if (radarrId !== undefined) {
      const link = parseMediaDownloadTag(torrent.tags);
      if (link?.kind === "movie" && link.arrId === radarrId) {
        return true;
      }
    }
    const name = torrent.name?.trim();
    if (name !== undefined && movieTitleMatches(name, movieTitle, year)) {
      return true;
    }
    // Older/untagged arr magnets can still be matched by the movie folder
    // qBittorrent saved them into while their display name is just the hash.
    const saveTitle = isPlaceholderTorrentName(name)
      ? savePathTitle(torrent.save_path)
      : undefined;
    return saveTitle !== undefined && movieTitleMatches(saveTitle, movieTitle, year);
  });
}

/**
 * Live qBittorrent state for one movie, using the same aggregation as the
 * library cards. Completed torrents are excluded.
 */
export function movieTorrentActivity(
  torrents: QbittorrentTorrent[],
  movie: ServarrMovieResource,
  options: QbittorrentActivityOptions = {},
): ActivityItem | undefined {
  const title = movie.title?.trim();
  if (!title) {
    return undefined;
  }
  const active = matchMovieTorrents(torrents, title, movie.year, movie.id).filter(
    isActiveTorrent,
  );
  if (active.length === 0) {
    return undefined;
  }
  return buildQbittorrentActivity(active, { series: [], movies: [movie] }, options)[0];
}

/** Match a movie only when its full title is followed by a year or release tag. */
export function movieTitleMatches(
  torrentName: string,
  movieTitle: string,
  year?: number,
): boolean {
  const nameTokens = tokenize(torrentName);
  const titleTokens = tokenize(movieTitle);
  if (titleTokens.length === 0 || nameTokens.length < titleTokens.length) {
    return false;
  }
  if (!titleTokens.every((token, index) => nameTokens[index] === token)) {
    return false;
  }
  const next = nameTokens[titleTokens.length];
  if (next === undefined) {
    return true;
  }
  if (year !== undefined && next === String(year)) {
    return true;
  }
  return MOVIE_RELEASE_MARKER.test(next);
}

function buildActivityItem(bucket: ActivityBucket, now: number): ActivityItem {
  const aggregate = aggregateTorrents(bucket.torrents, now);
  const metadata = bucket.metadata;
  const item: ActivityItem = {
    key: bucket.key,
    kind: bucket.kind,
    title: bucket.title,
    queueCount: bucket.torrents.length,
    status: aggregate.status,
    progress: aggregate.progress,
    downloadClients: ["qBittorrent"],
    protocols: ["torrent"],
  };

  if (bucket.service) {
    item.service = bucket.service;
  }
  if (bucket.kind === "movie" && bucket.arrId !== undefined) {
    item.movieId = bucket.arrId;
  } else if (bucket.kind === "series" && bucket.arrId !== undefined) {
    item.seriesId = bucket.arrId;
  }

  if (metadata) {
    assign(item, "year", metadata.year);
    assign(item, "overview", metadata.overview);
    assign(item, "network", metadata.network);
    assign(item, "rating", metadata.rating);
    assign(item, "runtimeMinutes", metadata.runtimeMinutes);
    assign(item, "imageUrl", metadata.imageUrl);
    assign(item, "tmdbId", metadata.tmdbId);
    assign(item, "tvdbId", metadata.tvdbId);
    assign(item, "imdbId", metadata.imdbId);
  } else {
    assign(item, "year", yearFromTitle(bucket.torrents[0]?.name));
  }

  assign(item, "sizeBytes", aggregate.sizeBytes);
  assign(item, "sizeLeftBytes", aggregate.sizeLeftBytes);
  assign(item, "downloadSpeedBytes", aggregate.downloadSpeedBytes);
  assign(item, "connectedSeeders", aggregate.connectedSeeders);
  assign(item, "swarmSeeders", aggregate.swarmSeeders);
  assign(item, "timeLeft", aggregate.timeLeft);
  assign(item, "quality", aggregate.quality);
  assign(item, "statusMessages", aggregate.statusMessages);
  assign(item, "seasons", aggregate.seasons);

  return item;
}

function aggregateTorrents(torrents: QbittorrentTorrent[], now: number): {
  status: ActivityStatus;
  progress: number;
  sizeBytes?: number;
  sizeLeftBytes?: number;
  downloadSpeedBytes?: number;
  connectedSeeders?: number;
  swarmSeeders?: number;
  timeLeft?: string;
  quality?: string;
  statusMessages?: string[];
  seasons?: number[];
} {
  const statuses = torrents.map((torrent) => torrentStatus(torrent, now));
  const status: ActivityStatus = statuses.includes("warning")
    ? "warning"
    : statuses.includes("downloading")
      ? "downloading"
      : "queued";

  const sizes = torrents
    .map((torrent) => {
      const size = positive(torrent.size);
      const progress = fraction(torrent.progress);
      if (size === undefined) {
        return undefined;
      }
      const left =
        nonNegative(torrent.amount_left) ??
        (progress === undefined ? undefined : Math.round(size * (1 - progress)));
      return left === undefined ? undefined : { size, left };
    })
    .filter((entry): entry is { size: number; left: number } => entry !== undefined);

  const totalSize = sizes.reduce((sum, entry) => sum + entry.size, 0);
  const totalLeft = sizes.reduce((sum, entry) => sum + entry.left, 0);
  const progress =
    totalSize > 0
      ? clampProgress(((totalSize - totalLeft) / totalSize) * 100)
      : clampProgress(
          torrents.reduce((sum, torrent) => sum + (fraction(torrent.progress) ?? 0), 0) /
            Math.max(1, torrents.length) *
            100,
        );

  const speeds = torrents
    .map((torrent) => nonNegative(torrent.dlspeed))
    .filter((speed): speed is number => speed !== undefined);
  const downloadSpeed = speeds.reduce((sum, speed) => sum + speed, 0);

  const connectedSeeders = sumReported(
    torrents.map((torrent) => nonNegative(torrent.num_seeds)),
  );
  const swarmSeeders = sumReported(
    torrents.map((torrent) => nonNegative(torrent.num_complete)),
  );

  const etas = torrents
    .map((torrent) => nonNegative(torrent.eta))
    .filter(
      (eta): eta is number => eta !== undefined && eta > 0 && eta < INFINITE_ETA_SECONDS,
    );
  const eta = etas.length > 0 ? Math.min(...etas) : undefined;

  const qualities = torrents
    .map((torrent) => qualityFromTitle(torrent.name ?? ""))
    .filter((quality): quality is string => Boolean(quality));

  const messages = [
    ...new Set(torrents.flatMap((torrent) => torrentMessages(torrent, now))),
  ];
  const seasons = [
    ...new Set(torrents.flatMap(torrentSeasons)),
  ].sort((left, right) => left - right);

  return {
    status,
    progress,
    ...(totalSize > 0 ? { sizeBytes: totalSize, sizeLeftBytes: totalLeft } : {}),
    ...(downloadSpeed > 0 ? { downloadSpeedBytes: downloadSpeed } : {}),
    ...(connectedSeeders !== undefined ? { connectedSeeders } : {}),
    ...(swarmSeeders !== undefined ? { swarmSeeders } : {}),
    ...(eta !== undefined ? { timeLeft: formatDuration(eta) } : {}),
    ...(qualities[0] ? { quality: qualities[0] } : {}),
    ...(messages.length > 0 ? { statusMessages: messages } : {}),
    ...(seasons.length > 0 ? { seasons } : {}),
  };
}

function torrentStatus(torrent: QbittorrentTorrent, now: number): ActivityStatus {
  const state = (torrent.state ?? "").trim().toLowerCase();
  if (state === "error" || state === "missingfiles") {
    return "warning";
  }
  if (isAwaitingMetadata(torrent)) {
    return metadataWaitExpired(torrent, now) ? "warning" : "queued";
  }
  if (/queued|paused|stopped|meta|allocating|checking/.test(state)) {
    return "queued";
  }
  return "downloading";
}

function torrentMessages(torrent: QbittorrentTorrent, now: number): string[] {
  const state = (torrent.state ?? "").trim().toLowerCase();
  if (state === "error" || state === "missingfiles") {
    return [`qBittorrent reports ${torrent.state}.`];
  }
  if (isAwaitingMetadata(torrent)) {
    return [metadataStatusMessage(torrent, now)];
  }
  if (state === "stalleddl") {
    return ["qBittorrent is stalled and not receiving data."];
  }
  return [];
}

function torrentSeasons(torrent: QbittorrentTorrent): number[] {
  const name = torrent.name;
  if (!name) {
    return [];
  }
  const seasonNumber = seasonNumberFromTitle(name);
  return queueRecordSeasons({ title: name, seasonNumber });
}

function matchSavePathMovie(
  torrent: QbittorrentTorrent,
  catalog: ActivityCatalog,
): MovieMatch | undefined {
  if (!isPlaceholderTorrentName(torrent.name)) {
    return undefined;
  }
  const title = savePathTitle(torrent.save_path);
  if (!title) {
    return undefined;
  }
  let best: MovieMatch | undefined;
  for (const movie of catalog.movies) {
    const movieTitle = movie.title?.trim();
    if (!movieTitle || !movieTitleMatches(title, movieTitle, movie.year)) {
      continue;
    }
    const match: MovieMatch = {
      kind: "movie",
      key: movieKey(movie),
      resource: movie,
      score: tokenize(movieTitle).length,
    };
    if (!best || match.score > best.score) {
      best = match;
    }
  }
  return best;
}

function isPlaceholderTorrentName(name: string | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || /^[a-f0-9]{40}$/i.test(trimmed);
}

function savePathTitle(savePath: string | undefined): string | undefined {
  const segment = (savePath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.trim();
  if (!segment || /^(?:data|media|movies?|tv|series)$/i.test(segment)) {
    return undefined;
  }
  return segment;
}

function mediaTitleFromTorrent(torrent: QbittorrentTorrent): string | undefined {
  return isPlaceholderTorrentName(torrent.name)
    ? savePathTitle(torrent.save_path)
    : undefined;
}

function genericKey(torrent: QbittorrentTorrent, name: string): string {
  const hash = (torrent.hash ?? torrent.infohash_v1 ?? "").trim().toLowerCase();
  return hash ? `torrent:${hash}` : `torrent:${name}`;
}

function seriesKey(series: ServarrSeriesResource): string {
  return series.tvdbId !== undefined ? `series:${series.tvdbId}` : `series:sonarr:${series.id}`;
}

function movieKey(movie: ServarrMovieResource): string {
  return movie.tmdbId !== undefined ? `movie:${movie.tmdbId}` : `movie:radarr:${movie.id}`;
}

function looksLikeSeries(name: string): boolean {
  return tokenize(name).some((token) => /^s\d{1,3}(?:e\d{1,3})?$/.test(token));
}

function displayTitle(name: string | undefined): string {
  return (name ?? "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Download";
}

function yearFromTitle(name: string | undefined): number | undefined {
  const match = name?.match(/(?:^|[^0-9])((?:19|20)\d{2})(?=$|[^0-9])/);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Sum peer counts that the client actually reported, preserving a real zero. */
function sumReported(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value !== undefined);
  return reported.length === 0
    ? undefined
    : reported.reduce((sum, value) => sum + value, 0);
}

function fraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
