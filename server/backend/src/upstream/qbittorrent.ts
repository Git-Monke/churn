import type { QbittorrentConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson, fetchWithTimeout, upstreamResponseError } from "../http.js";

/** The subset of qBittorrent's torrent list churn uses for progress overlays. */
export interface QbittorrentTorrent {
  hash?: string;
  infohash_v1?: string;
  infohash_v2?: string;
  name?: string;
  category?: string;
  /** Fraction complete, 0–1. */
  progress?: number;
  size?: number;
  amount_left?: number;
  /** Current download speed in bytes/second. */
  dlspeed?: number;
  /** Current upload speed in bytes/second. */
  upspeed?: number;
  /** Seconds remaining, or 8640000 when qBittorrent considers it infinite. */
  eta?: number;
  state?: string;
  /** Seeds currently connected to this torrent (not the tracker's swarm count). */
  num_seeds?: number;
  /** Seeds the tracker reports for the swarm. */
  num_complete?: number;
  num_leechs?: number;
  num_incomplete?: number;
  /** Unix timestamp qBittorrent added the torrent. */
  added_on?: number;
  /** Unix timestamp the torrent finished downloading, 0 if incomplete. */
  completion_on?: number;
}

/** qBittorrent accepts an optional `urn:btih:` prefix; compare bare hashes. */
export function normalizeInfoHash(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^urn:btih:/, "");
}

export function createQbittorrentClient(config: QbittorrentConfig, timeoutMs: number) {
  const authHeaders = (): Record<string, string> => {
    if (!config.apiKey) {
      throw new UpstreamError(
        "qbittorrent",
        "unauthorized",
        "qBittorrent API key is not configured",
      );
    }
    return { authorization: `Bearer ${config.apiKey}` };
  };

  return {
    async getTorrents(): Promise<QbittorrentTorrent[]> {
      return fetchJson<QbittorrentTorrent[]>("qbittorrent", `${config.url}/api/v2/torrents/info`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    /** Remove a torrent from qBittorrent while leaving its downloaded files on disk. */
    async removeTorrent(hash: string, deleteFiles = false): Promise<void> {
      const body = new URLSearchParams({
        hashes: normalizeInfoHash(hash),
        deleteFiles: String(deleteFiles),
      });
      const response = await fetchWithTimeout(
        "qbittorrent",
        `${config.url}/api/v2/torrents/delete`,
        {
          method: "POST",
          headers: {
            ...authHeaders(),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        },
        timeoutMs,
      );
      if (!response.ok) {
        throw await upstreamResponseError("qbittorrent", response);
      }
      await response.arrayBuffer().catch(() => undefined);
    },
  };
}

export type QbittorrentClient = ReturnType<typeof createQbittorrentClient>;
