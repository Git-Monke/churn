import type { AppConfig } from "./config.js";
import { isDirectDownloadTorrent } from "./direct-grab.js";
import { mapShowTorrentDownloads } from "./qbittorrent-show.js";
import type { ShowEpisode } from "./types.js";
import type { QbittorrentTorrent } from "./upstream/qbittorrent.js";
import { createArrClient } from "./upstream/servarr.js";

/**
 * Sonarr normally discovers completed downloads through its queue. A queue
 * record can disappear when a series is deleted and re-added, or when Sonarr
 * restarts while the torrent keeps running. qBittorrent still has the finished
 * payload, but Sonarr never imports it and Jellyfin never sees the files.
 *
 * Ask Sonarr to scan the torrent's content path instead. This is the same
 * operation as Sonarr's manual "Downloaded Episodes Scan"; Sonarr still matches
 * the files to episodes itself, so a bad path is a no-op rather than a blind
 * import.
 */
const RETRY_AFTER_MS = 60_000;
const scanRequests = new Map<string, number>();

export async function recoverCompletedShowDownloads(
  config: AppConfig,
  seriesId: number,
  seriesTitle: string,
  episodes: ShowEpisode[],
  torrents: QbittorrentTorrent[],
): Promise<Set<string>> {
  const service = config.services.sonarr;
  if (!service.apiKey || episodes.length === 0 || torrents.length === 0) {
    return new Set();
  }

  const missing = episodes.filter(
    (episode) =>
      episode.availability === "missing" &&
      (episode.download === undefined || episode.download.untracked),
  );
  if (missing.length === 0) {
    return new Set();
  }

  const paths = new Map<string, string[]>();
  for (const torrent of torrents) {
    if (!isCompletedTorrent(torrent) || isDirectDownloadTorrent(torrent)) {
      continue;
    }
    const contentPath = torrent.content_path?.trim();
    if (!contentPath) {
      continue;
    }
    const covered = mapShowTorrentDownloads([torrent], seriesTitle, missing);
    if (covered.size === 0) {
      continue;
    }
    const episodeKeys = [...covered.keys()];
    if (episodeKeys.length > 0) {
      paths.set(contentPath, episodeKeys);
    }
  }

  const client = createArrClient(
    "sonarr",
    service,
    Math.max(config.requestTimeoutMs, 10_000),
  );
  const recovering = new Set<string>();
  const now = Date.now();

  for (const [contentPath, episodeKeys] of paths) {
    const requestKey = `${seriesId}:${contentPath}`;
    const requestedAt = scanRequests.get(requestKey);
    if (requestedAt !== undefined && now - requestedAt < RETRY_AFTER_MS) {
      // A previous page load already queued this scan. Keep reporting the
      // import as in progress while Sonarr works through it.
      for (const key of episodeKeys) {
        recovering.add(key);
      }
      continue;
    }

    scanRequests.set(requestKey, now);
    try {
      await client.runCommand({
        name: "DownloadedEpisodesScan",
        path: contentPath,
        importMode: "auto",
      });
      for (const key of episodeKeys) {
        recovering.add(key);
      }
    } catch {
      // Allow the next show load to retry instead of hiding the warning for a
      // full minute when Sonarr was briefly unreachable.
      scanRequests.delete(requestKey);
    }
  }

  return recovering;
}

export function isCompletedTorrent(torrent: QbittorrentTorrent): boolean {
  return (
    typeof torrent.progress === "number" &&
    Number.isFinite(torrent.progress) &&
    torrent.progress >= 0.999
  );
}

/** Update the fallback download rows once Sonarr has been asked to import them. */
export function markDownloadsImporting(episodes: ShowEpisode[], recovering: Set<string>): void {
  for (const episode of episodes) {
    if (!recovering.has(episode.key) || !episode.download?.untracked) {
      continue;
    }
    episode.download.status = "importing";
    episode.download.progress = 100;
    episode.download.statusMessages = [
      "Download finished in qBittorrent. churn asked Sonarr to import it; this page updates automatically.",
    ];
  }
}
