import type { QbittorrentConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson } from "../http.js";

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
}

/**
 * Read-only qBittorrent client. It intentionally exposes only the torrent list
 * so the backend can never mutate downloads through this path.
 */
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
  };
}

export type QbittorrentClient = ReturnType<typeof createQbittorrentClient>;
