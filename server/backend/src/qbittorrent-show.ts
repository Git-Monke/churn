import { queueRecordSeasons } from "./activity.js";
import { isDirectDownloadTorrent } from "./direct-grab.js";
import {
  isAwaitingMetadata,
  metadataStatusMessage,
  metadataWaitExpired,
} from "./metadata-wait.js";
import { formatDuration } from "./torrent-progress.js";
import type { ShowDownload } from "./types.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";

interface ShowEpisodeIdentity {
  key: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface ShowTorrentMapOptions {
  now?: () => number;
}

/**
 * qBittorrent can contain a download that Sonarr never queued, for example when
 * the torrent already existed and Sonarr's add was rejected. Match those
 * torrents by the show title and season/episode markers so the show page can
 * still show live progress instead of prompting for another release.
 */
export function mapShowTorrentDownloads(
  torrents: QbittorrentTorrent[],
  seriesTitle: string,
  episodes: ShowEpisodeIdentity[],
  options: ShowTorrentMapOptions = {},
): Map<string, ShowDownload> {
  const now = options.now?.() ?? Date.now();
  const downloads = new Map<string, ShowDownload>();
  const titleTokens = tokenize(seriesTitle);
  if (titleTokens.length === 0) {
    return downloads;
  }

  for (const torrent of torrents) {
    const name = torrent.name?.trim();
    if (!name || !torrentBelongsToShow(name, titleTokens)) {
      continue;
    }

    const seasonNumber = seasonNumberFromTitle(name);
    const seasons = queueRecordSeasons({ title: name, seasonNumber });
    if (seasons.length === 0) {
      continue;
    }
    const episodeNumber = episodeNumberFromTitle(name);
    if (episodeNumber !== undefined && seasonNumber === undefined) {
      continue;
    }

    const download = torrentDownload(torrent, name, now);
    const covered = episodes.filter((episode) => {
      if (!seasons.includes(episode.seasonNumber)) {
        return false;
      }
      return episodeNumber === undefined || episode.episodeNumber === episodeNumber;
    });
    for (const episode of covered) {
      // A real Sonarr queue record is more accurate; buildShowDetail merges
      // those afterwards, so keep the first fallback per episode stable.
      if (!downloads.has(episode.key)) {
        downloads.set(episode.key, download);
      }
    }
  }

  return downloads;
}

/** Compare the title words before the `S01`/`S01E02` marker. */
export function torrentBelongsToShow(name: string, titleTokens: string[]): boolean {
  const tokens = tokenize(name);
  const markerIndex = tokens.findIndex((token) => /^s\d{1,3}(?:e\d{1,3})?$/.test(token));
  if (markerIndex < titleTokens.length) {
    return false;
  }
  if (!titleTokens.every((token, index) => tokens[index] === token)) {
    return false;
  }
  // Permit a year or country qualifier between the show title and season, such
  // as "The.Office.US.S01" or "Show.2020.S01", but nothing else.
  return tokens
    .slice(titleTokens.length, markerIndex)
    .every((token) => /^(?:19|20)\d{2}$/.test(token) || /^(?:us|uk|au|ca)$/.test(token));
}

function torrentDownload(
  torrent: QbittorrentTorrent,
  name: string,
  now: number,
): ShowDownload {
  const progress = fraction(torrent.progress);
  const percent = progress === undefined ? 0 : Math.round(progress * 100);
  const state = (torrent.state ?? "").toLowerCase();
  const complete = progress !== undefined && progress >= 0.999;
  const failed = state === "error" || state === "missingfiles";
  const queued = isQueued(torrent);
  const awaitingMetadata = isAwaitingMetadata(torrent);

  const download: ShowDownload = {
    status: failed
      ? "warning"
      : complete
        ? "importing"
        : awaitingMetadata
          ? metadataWaitExpired(torrent, now)
            ? "warning"
            : "queued"
          : queued
            ? "queued"
            : "downloading",
    progress: percent,
    downloadClient: "qBittorrent",
    protocol: "torrent",
    untracked: true,
  };
  const size = positive(torrent.size);
  if (size !== undefined) {
    download.sizeBytes = size;
    const amountLeft = nonNegative(torrent.amount_left);
    const remaining =
      amountLeft !== undefined && amountLeft <= size
        ? amountLeft
        : progress !== undefined
          ? Math.round(size * (1 - progress))
          : undefined;
    if (remaining !== undefined) {
      download.sizeLeftBytes = remaining;
    }
  }
  const speed = nonNegative(torrent.dlspeed);
  if (speed !== undefined) {
    download.downloadSpeedBytes = speed;
  }
  const connectedSeeders = nonNegative(torrent.num_seeds);
  if (connectedSeeders !== undefined) {
    download.connectedSeeders = connectedSeeders;
  }
  const swarmSeeders = nonNegative(torrent.num_complete);
  if (swarmSeeders !== undefined) {
    download.swarmSeeders = swarmSeeders;
  }
  const eta = nonNegative(torrent.eta);
  if (eta !== undefined && eta > 0 && eta < 8_640_000) {
    download.timeLeft = formatDuration(eta);
  }
  const quality = qualityFromTitle(name);
  if (quality) {
    download.quality = quality;
  }
  if (episodeNumberFromTitle(name) === undefined) {
    download.seasonPack = true;
  }
  if (failed) {
    download.statusMessages = [`qBittorrent reports ${torrent.state}.`];
  } else if (awaitingMetadata) {
    download.statusMessages = [metadataStatusMessage(torrent, now)];
  } else if (complete) {
    download.statusMessages = [
      isDirectDownloadTorrent(torrent)
        ? "Download finished in qBittorrent. Jellyfin has not indexed it yet."
        : "Download finished in qBittorrent. Sonarr has not imported it yet.",
    ];
  } else if (state === "stalleddl") {
    download.statusMessages = ["qBittorrent is stalled and not receiving data."];
  }
  return download;
}

function isQueued(torrent: QbittorrentTorrent): boolean {
  const state = torrent.state?.toLowerCase() ?? "";
  return (
    state.startsWith("queued") ||
    state.startsWith("paused") ||
    state.startsWith("stalled") ||
    state === "metadl"
  );
}

export function seasonNumberFromTitle(name: string): number | undefined {
  const match = name.match(/(?:^|[^A-Za-z0-9])S(\d{1,3})(?:[\s._-]*E\d{1,3})?(?=$|[^A-Za-z0-9])/i);
  if (!match) {
    return undefined;
  }
  const season = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(season) ? season : undefined;
}

function episodeNumberFromTitle(name: string): number | undefined {
  const match = name.match(/(?:^|[^A-Za-z0-9])S\d{1,3}[\s._-]*E(\d{1,3})(?=$|[^A-Za-z0-9])/i);
  if (!match) {
    return undefined;
  }
  const episode = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(episode) ? episode : undefined;
}

export function qualityFromTitle(name: string): string | undefined {
  const match = name.match(/(?:^|[^0-9])(2160p|1080p|720p|480p)(?=$|[^0-9])/i);
  return match?.[1]?.toLowerCase();
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
