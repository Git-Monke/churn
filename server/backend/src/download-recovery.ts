import type { AppConfig } from "./config.js";
import { UpstreamError } from "./errors.js";
import type { ServarrRelease } from "./upstream/servarr.js";
import {
  createQbittorrentClient,
  normalizeInfoHash,
  type QbittorrentTorrent,
} from "./upstream/qbittorrent.js";

/**
 * Sonarr/Radarr report a qBittorrent duplicate as a connection failure. If the
 * exact torrent is still in qBittorrent but absent from the arr's queue, the
 * arr retries `torrents/add`, gets HTTP 409, and gives up.
 *
 * Refresh that torrent through the arr instead: qBittorrent's delete endpoint
 * keeps the payload files, and the retry makes the arr own the download again.
 * This only runs when the failed grab and a matching torrent can both be
 * proven, so an unrelated connection error is never destructive.
 *
 * This is called by the POST grab routes, so the repair finishes before the
 * request returns. If qBittorrent still reports the torrent after the delete,
 * wait for it to disappear before retrying; otherwise the arr can race the
 * delete and hit the same duplicate again.
 */
export async function grabWithDuplicateRecovery(
  config: AppConfig,
  release: ServarrRelease,
  grab: () => Promise<unknown>,
): Promise<void> {
  try {
    await grab();
    return;
  } catch (error) {
    if (!looksLikeQbittorrentFailure(error)) {
      throw error;
    }
    if (!config.qbittorrent.apiKey) {
      throw withDuplicateHint(
        error,
        "churn can repair this automatically, but QBITTORRENT_API_KEY is not configured",
      );
    }

    const client = createQbittorrentClient(config.qbittorrent, config.requestTimeoutMs);
    let lastError: unknown = error;

    // A second pass handles a stale client cache or a delete that lands just
    // after the arr's own duplicate check. Two attempts is enough to resolve
    // the race without risking an endless delete/grab loop.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let torrents: QbittorrentTorrent[];
      try {
        torrents = await client.getTorrents();
      } catch {
        throw withDuplicateHint(lastError);
      }

      const hash = matchingTorrentHash(torrents, release);
      if (!hash) {
        throw withDuplicateHint(lastError);
      }

      try {
        await client.removeTorrent(hash, false);
        await waitForTorrentRemoval(client, hash, config.requestTimeoutMs);
      } catch (removeError) {
        throw withDuplicateHint(removeError);
      }

      try {
        await grab();
        return;
      } catch (retryError) {
        lastError = retryError;
        if (!looksLikeQbittorrentFailure(retryError)) {
          throw retryFailure(retryError);
        }
      }
    }

    throw retryFailure(lastError);
  }
}

async function waitForTorrentRemoval(
  client: ReturnType<typeof createQbittorrentClient>,
  hash: string,
  requestTimeoutMs: number,
): Promise<void> {
  const timeoutMs = Math.min(5_000, Math.max(1_000, requestTimeoutMs));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const torrents = await client.getTorrents();
    if (!torrents.some((torrent) => torrentHashes(torrent).includes(hash))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new UpstreamError(
    "qbittorrent",
    "http",
    "qBittorrent did not remove the duplicate torrent in time, so churn did not retry the grab",
  );
}

/** Sonarr's qBittorrent client wraps the duplicate 409 as a generic 500. */
export function looksLikeQbittorrentFailure(error: unknown): boolean {
  if (!(error instanceof UpstreamError) || error.service === "qbittorrent") {
    return false;
  }
  const message = error.message.toLowerCase();
  const looksLikeDuplicate =
    message.includes("qbittorrent") ||
    message.includes("torrents/add") ||
    message.includes("torrent already exists") ||
    message.includes("torrent is already") ||
    message.includes("duplicate torrent");
  return (
    (error.status === 409 || error.status === 500 || error.status === 502) &&
    looksLikeDuplicate
  );
}

/** Match the release hash first, then a punctuation-insensitive release title. */
export function matchingTorrentHash(
  torrents: QbittorrentTorrent[],
  release: ServarrRelease,
): string | undefined {
  for (const wanted of [release.infoHash, release.releaseHash]) {
    const wantedHash = normalizeInfoHash(wanted);
    if (!wantedHash) {
      continue;
    }
    const match = torrents.find((torrent) =>
      torrentHashes(torrent).includes(wantedHash),
    );
    const hash = match ? torrentHashes(match)[0] : undefined;
    if (hash) {
      return hash;
    }
  }

  const wantedTitle = normalizeTitle(release.title);
  if (wantedTitle.length < 16) {
    return undefined;
  }
  const byTitle = torrents.find((torrent) => normalizeTitle(torrent.name) === wantedTitle);
  return byTitle ? torrentHashes(byTitle)[0] : undefined;
}

function torrentHashes(torrent: QbittorrentTorrent): string[] {
  return [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]
    .map(normalizeInfoHash)
    .filter((hash): hash is string => hash !== "");
}

function normalizeTitle(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function withDuplicateHint(error: unknown, reason?: string): unknown {
  if (!(error instanceof UpstreamError)) {
    return error;
  }
  const hint =
    reason ?? "qBittorrent already has the matching torrent";
  return new UpstreamError(
    error.service,
    error.kind,
    `${error.message}. ${hint}; remove it there without deleting its files, then retry.`,
    error.status,
  );
}

function retryFailure(error: unknown): unknown {
  if (error instanceof UpstreamError) {
    return new UpstreamError(
      error.service,
      error.kind,
      `qBittorrent had this torrent, so churn removed it without deleting its files and retried the grab, but the retry failed: ${error.message}`,
      error.status,
    );
  }
  return error;
}
