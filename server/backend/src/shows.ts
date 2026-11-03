import type {
  ShowAvailability,
  ShowDetailResponse,
  ShowDownload,
  ShowEpisode,
  ShowSeason,
  ShowSeriesSummary,
  ShowSource,
} from "./types.js";
import {
  isSeasonPack,
  queueRecordProgress,
  queueRecordSeasons,
  queueRecordStatus,
} from "./activity.js";
import { mapShowTorrentDownloads } from "./qbittorrent-show.js";
import type { JellyfinItem } from "./upstream/jellyfin.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import type {
  ServarrEpisode,
  ServarrQueueRecord,
  ServarrSeriesResource,
} from "./upstream/servarr.js";

export interface BuildShowDetailInput {
  source: ShowSource;
  series: ShowSeriesSummary;
  jellyfinSeasons?: JellyfinItem[];
  jellyfinEpisodes?: JellyfinItem[];
  sonarrEpisodes?: ServarrEpisode[];
  queueRecords?: ServarrQueueRecord[];
  /** Used only for downloads Sonarr never queued. */
  qbittorrentTorrents?: QbittorrentTorrent[];
}

interface EpisodeCandidate {
  key: string;
  seasonNumber: number;
  episodeNumber: number;
  jellyfin?: JellyfinItem;
  sonarr?: ServarrEpisode;
}

interface DownloadCandidate {
  record: ServarrQueueRecord;
  seasonPack: boolean;
}

export function buildShowDetail(input: BuildShowDetailInput): {
  defaultSeason?: number;
  seasons: ShowSeason[];
  episodes: ShowEpisode[];
} {
  const candidates = new Map<string, EpisodeCandidate>();
  const jellyfinSeasonNames = new Map<number, string>();
  const jellyfinSeasonNumbers = new Set<number>();

  for (const season of input.jellyfinSeasons ?? []) {
    const number = season.IndexNumber;
    if (!Number.isInteger(number)) {
      continue;
    }
    jellyfinSeasonNumbers.add(number as number);
    if (season.Name) {
      jellyfinSeasonNames.set(number as number, season.Name);
    }
  }

  for (const episode of input.jellyfinEpisodes ?? []) {
    const seasonNumber = episode.ParentIndexNumber;
    const episodeNumber = episode.IndexNumber;
    if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) {
      continue;
    }
    const key = episodeKey(seasonNumber as number, episodeNumber as number);
    candidates.set(key, {
      key,
      seasonNumber: seasonNumber as number,
      episodeNumber: episodeNumber as number,
      jellyfin: episode,
    });
  }

  for (const episode of input.sonarrEpisodes ?? []) {
    if (!Number.isInteger(episode.seasonNumber) || !Number.isInteger(episode.episodeNumber)) {
      continue;
    }
    const key = episodeKey(episode.seasonNumber as number, episode.episodeNumber as number);
    const existing = candidates.get(key);
    if (existing) {
      existing.sonarr = episode;
    } else {
      candidates.set(key, {
        key,
        seasonNumber: episode.seasonNumber as number,
        episodeNumber: episode.episodeNumber as number,
        sonarr: episode,
      });
    }
  }

  const downloads = downloadOverlay(
    [...candidates.values()],
    input.sonarrEpisodes ?? [],
    input.queueRecords ?? [],
  );
  const missingEpisodes = [...candidates.values()].filter(
    (candidate) => !candidate.jellyfin && !candidate.sonarr?.hasFile,
  );
  const untrackedDownloads = mapShowTorrentDownloads(
    input.qbittorrentTorrents ?? [],
    input.series.title,
    missingEpisodes,
  );
  const fallbackImage = input.series.imageUrl;
  const episodes = [...candidates.values()]
    .sort((left, right) =>
      left.seasonNumber === right.seasonNumber
        ? left.episodeNumber - right.episodeNumber
        : left.seasonNumber - right.seasonNumber,
    )
    .map((candidate) =>
      mapEpisode(
        candidate,
        downloads.get(candidate.key),
        untrackedDownloads.get(candidate.key),
        fallbackImage,
      ),
    );

  const seasonNumbers = new Set<number>(jellyfinSeasonNumbers);
  for (const episode of episodes) {
    seasonNumbers.add(episode.seasonNumber);
  }
  for (const seasonNumber of downloads.values()) {
    if (Number.isInteger(seasonNumber.record.seasonNumber)) {
      seasonNumbers.add(seasonNumber.record.seasonNumber as number);
    }
  }

  const seasons = [...seasonNumbers]
    .sort((left, right) => left - right)
    .map((seasonNumber) => summarizeSeason(seasonNumber, seasonsName(seasonNumber, jellyfinSeasonNames), episodes));

  return {
    defaultSeason: pickDefaultSeason(seasons, episodes),
    seasons,
    episodes,
  };
}

function downloadOverlay(
  candidates: EpisodeCandidate[],
  sonarrEpisodes: ServarrEpisode[],
  queueRecords: ServarrQueueRecord[],
): Map<string, DownloadCandidate> {
  const best = new Map<string, DownloadCandidate>();
  const episodeById = new Map<number, EpisodeCandidate>();
  for (const episode of sonarrEpisodes) {
    if (episode.id === undefined) {
      continue;
    }
    const candidate = candidates.find(
      (item) =>
        item.seasonNumber === episode.seasonNumber && item.episodeNumber === episode.episodeNumber,
    );
    if (candidate) {
      episodeById.set(episode.id, candidate);
    }
  }

  const consider = (key: string, candidate: DownloadCandidate) => {
    const current = best.get(key);
    if (!current || compareDownloads(candidate, current) > 0) {
      best.set(key, candidate);
    }
  };

  for (const record of queueRecords) {
    const recordSeasons = queueRecordSeasons(record);
    const multiSeason = recordSeasons.length > 1;
    if (record.episodeId !== undefined && !multiSeason) {
      const episode = episodeById.get(record.episodeId);
      if (episode) {
        consider(episode.key, { record, seasonPack: false });
        continue;
      }
    }
    if (recordSeasons.length > 0) {
      const covered = new Set(recordSeasons);
      for (const candidate of candidates) {
        if (covered.has(candidate.seasonNumber)) {
          consider(candidate.key, { record, seasonPack: multiSeason || isSeasonPack(record) });
        }
      }
    }
  }

  return best;
}

function mapEpisode(
  candidate: EpisodeCandidate,
  download: DownloadCandidate | undefined,
  untrackedDownload: ShowDownload | undefined,
  fallbackImage: string | undefined,
): ShowEpisode {
  const { jellyfin, sonarr } = candidate;
  const episode: ShowEpisode = {
    key: candidate.key,
    seasonNumber: candidate.seasonNumber,
    episodeNumber: candidate.episodeNumber,
    title:
      jellyfin?.Name?.trim() ||
      sonarr?.title?.trim() ||
      `Episode ${candidate.episodeNumber}`,
    availability: availabilityFor(candidate),
  };

  assignIfDefined(episode, "overview", jellyfin?.Overview ?? sonarr?.overview);
  assignIfDefined(episode, "airDate", jellyfin?.PremiereDate ?? sonarr?.airDateUtc);
  assignIfDefined(episode, "runtimeMinutes", runtimeMinutes(jellyfin?.RunTimeTicks));
  assignIfDefined(episode, "imageUrl", jellyfinImageUrl(jellyfin) ?? fallbackImage);
  assignIfDefined(episode, "monitored", sonarr?.monitored);
  assignIfDefined(episode, "jellyfinId", jellyfin?.Id);

  if (download) {
    episode.download = mapDownload(download);
  } else if (untrackedDownload) {
    episode.download = untrackedDownload;
  }
  return episode;
}

function mapDownload(candidate: DownloadCandidate): ShowDownload {
  const { record } = candidate;
  const download: ShowDownload = {
    status: queueRecordStatus(record),
    progress: queueRecordProgress(record),
  };
  assignIfDefined(download, "timeLeft", record.timeleft);
  assignIfDefined(download, "estimatedCompletionTime", record.estimatedCompletionTime);
  assignIfDefined(download, "sizeBytes", record.size);
  assignIfDefined(download, "downloadClient", record.downloadClient);
  assignIfDefined(download, "protocol", protocol(record.protocol));
  assignIfDefined(download, "quality", record.quality?.quality?.name);
  if (candidate.seasonPack) {
    download.seasonPack = true;
  }
  const messages = (record.statusMessages ?? []).flatMap((message) => [
    ...(message.title ? [message.title] : []),
    ...(message.messages ?? []),
  ]);
  if (messages.length > 0) {
    download.statusMessages = [...new Set(messages)];
  }
  return download;
}

function availabilityFor(candidate: EpisodeCandidate): ShowAvailability {
  if (candidate.jellyfin) {
    return "jellyfin";
  }
  if (candidate.sonarr?.hasFile) {
    return "sonarr";
  }
  if (candidate.sonarr?.airDateUtc && Date.parse(candidate.sonarr.airDateUtc) > Date.now()) {
    return "upcoming";
  }
  return "missing";
}

function summarizeSeason(seasonNumber: number, name: string, episodes: ShowEpisode[]): ShowSeason {
  const inSeason = episodes.filter((episode) => episode.seasonNumber === seasonNumber);
  return {
    seasonNumber,
    name,
    episodeCount: inSeason.length,
    availableCount: inSeason.filter((episode) => episode.availability === "jellyfin").length,
    downloadingCount: inSeason.filter((episode) => episode.download !== undefined).length,
  };
}

function pickDefaultSeason(seasons: ShowSeason[], episodes: ShowEpisode[]): number | undefined {
  const available = seasons.find((season) => season.availableCount > 0);
  if (available) {
    return available.seasonNumber;
  }
  const downloading = seasons.find((season) => season.downloadingCount > 0);
  if (downloading) {
    return downloading.seasonNumber;
  }
  const nonSpecial = seasons.find((season) => season.seasonNumber > 0);
  if (nonSpecial) {
    return nonSpecial.seasonNumber;
  }
  return seasons[0]?.seasonNumber ?? episodes[0]?.seasonNumber;
}

function compareDownloads(left: DownloadCandidate, right: DownloadCandidate): number {
  const statusDifference = downloadScore(left.record) - downloadScore(right.record);
  if (statusDifference !== 0) {
    return statusDifference;
  }
  return queueRecordProgress(left.record) - queueRecordProgress(right.record);
}

function downloadScore(record: ServarrQueueRecord): number {
  switch (queueRecordStatus(record)) {
    case "warning":
      return 4;
    case "downloading":
      return 3;
    case "importing":
      return 2;
    default:
      return 1;
  }
}

function seasonsName(seasonNumber: number, jellyfinNames: Map<number, string>): string {
  if (seasonNumber === 0) {
    return jellyfinNames.get(0) ?? "Specials";
  }
  return jellyfinNames.get(seasonNumber) ?? `Season ${seasonNumber}`;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `s${String(seasonNumber).padStart(2, "0")}e${String(episodeNumber).padStart(2, "0")}`;
}

function jellyfinImageUrl(item: JellyfinItem | undefined): string | undefined {
  const tag = item?.ImageTags?.Primary;
  if (!item?.Id || !tag) {
    return undefined;
  }
  return `/api/library/images/${encodeURIComponent(item.Id)}?tag=${encodeURIComponent(tag)}`;
}

function runtimeMinutes(ticks: number | undefined): number | undefined {
  return ticks === undefined ? undefined : Math.round(ticks / 600_000_000);
}

function protocol(value: string | undefined): "torrent" | "usenet" | undefined {
  return value === "torrent" || value === "usenet" ? value : undefined;
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
