import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";

/** How long a magnet may wait for metadata before the UI calls it a problem. */
export const METADATA_WARNING_AFTER_MS = 5_000;

/** qBittorrent reports `metaDL` until a peer sends the torrent's info dictionary. */
export function isAwaitingMetadata(torrent: QbittorrentTorrent): boolean {
  const state = (torrent.state ?? "").trim().toLowerCase();
  return torrent.has_metadata === false || state === "metadl";
}

/**
 * Elapsed time since qBittorrent added the torrent. `added_on` is Unix seconds;
 * without a usable timestamp we never warn, to avoid a false alarm on a healthy
 * torrent whose producer omitted the field.
 */
export function metadataWaitElapsedMs(
  torrent: QbittorrentTorrent,
  now: number,
): number | undefined {
  const addedOn =
    typeof torrent.added_on === "number" && Number.isFinite(torrent.added_on) && torrent.added_on > 0
      ? torrent.added_on * 1_000
      : undefined;
  return addedOn === undefined ? undefined : Math.max(0, now - addedOn);
}

export function metadataWaitExpired(torrent: QbittorrentTorrent, now: number): boolean {
  if (!isAwaitingMetadata(torrent)) {
    return false;
  }
  const elapsed = metadataWaitElapsedMs(torrent, now);
  return elapsed !== undefined && elapsed >= METADATA_WARNING_AFTER_MS;
}

/** Message for a magnet that has not received its info dictionary yet. */
export function metadataStatusMessage(torrent: QbittorrentTorrent, now: number): string {
  if (metadataWaitExpired(torrent, now)) {
    return "qBittorrent has not received torrent metadata after 5 seconds. No peer is sharing it; cancel this download and pick another release.";
  }
  return "Waiting for qBittorrent to fetch torrent metadata.";
}
