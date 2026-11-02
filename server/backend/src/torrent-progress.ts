import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import type { ServarrQueueRecord } from "./upstream/servarr.js";

/** qBittorrent reports this value when it cannot estimate a completion time. */
const INFINITE_ETA_SECONDS = 8_640_000;

export type TorrentIndex = Map<string, QbittorrentTorrent>;

/** Index qBittorrent's torrents by every hash variant Sonarr/Radarr may use. */
export function indexTorrents(torrents: QbittorrentTorrent[]): TorrentIndex {
  const index: TorrentIndex = new Map();
  for (const torrent of torrents) {
    for (const hash of [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]) {
      const key = hash?.trim().toLowerCase();
      if (key) {
        index.set(key, torrent);
      }
    }
  }
  return index;
}

/**
 * Overlay qBittorrent's live size/progress/ETA/speed onto matching torrent
 * records. Unmatched, usenet and non-active records are returned untouched, and
 * the arr's import/warning state is always preserved.
 */
export function applyTorrentProgress(
  records: ServarrQueueRecord[],
  torrents: TorrentIndex,
): ServarrQueueRecord[] {
  if (torrents.size === 0) {
    return records;
  }
  return records.map((record) => {
    if (record.protocol !== "torrent" || !record.downloadId) {
      return record;
    }
    const torrent = torrents.get(record.downloadId.trim().toLowerCase());
    return torrent ? mergeTorrent(record, torrent) : record;
  });
}

function mergeTorrent(
  record: ServarrQueueRecord,
  torrent: QbittorrentTorrent,
): ServarrQueueRecord {
  const merged = { ...record };

  const size = positive(torrent.size);
  const progress = fraction(torrent.progress);
  if (size !== undefined && progress !== undefined) {
    merged.size = size;
    const amountLeft = nonNegative(torrent.amount_left);
    merged.sizeleft =
      amountLeft !== undefined && amountLeft <= size
        ? amountLeft
        : Math.round(size * (1 - progress));
  }

  const eta = nonNegative(torrent.eta);
  if (eta !== undefined && eta > 0 && eta < INFINITE_ETA_SECONDS) {
    merged.timeleft = formatDuration(eta);
  }

  const speed = nonNegative(torrent.dlspeed);
  if (speed !== undefined) {
    merged.downloadSpeed = speed;
  }

  return merged;
}

/** Format seconds the same way arr's `timeleft` field does (`HH:MM:SS`). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}
