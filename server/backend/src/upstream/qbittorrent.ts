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
  /** False until a magnet's info dictionary has been fetched. */
  has_metadata?: boolean;
  /** Unix timestamp qBittorrent added the torrent. */
  added_on?: number;
  /** Unix timestamp the torrent finished downloading, 0 if incomplete. */
  completion_on?: number;
  /** Folder qBittorrent was told to download into. */
  save_path?: string;
  /** Absolute path to the torrent's files on qBittorrent's filesystem. */
  content_path?: string;
  /** Comma-separated qBittorrent tags. */
  tags?: string;
}

export type QbittorrentContentLayout = "Original" | "Subfolder" | "NoSubfolder";

export interface QbittorrentAddTorrentInput {
  /** Magnet link or HTTP(S) URL qBittorrent can fetch. */
  url: string;
  savePath: string;
  category?: string;
  tags?: string[];
  contentLayout?: QbittorrentContentLayout;
  autoTMM?: boolean;
  paused?: boolean;
}

export interface QbittorrentAddTorrentResult {
  added: number;
  pending: number;
  failed: number;
  torrentIds: string[];
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

    /** Add one magnet or torrent URL. qBittorrent must be able to fetch the URL. */
    async addTorrent(input: QbittorrentAddTorrentInput): Promise<QbittorrentAddTorrentResult> {
      const body = new URLSearchParams({
        urls: input.url,
        savepath: input.savePath,
        autoTMM: String(input.autoTMM ?? false),
        paused: String(input.paused ?? false),
      });
      if (input.category) {
        body.set("category", input.category);
      }
      if (input.tags && input.tags.length > 0) {
        body.set("tags", input.tags.join(","));
      }
      if (input.contentLayout) {
        body.set("contentLayout", input.contentLayout);
      }

      const response = await fetchWithTimeout(
        "qbittorrent",
        `${config.url}/api/v2/torrents/add`,
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

      const text = (await response.text()).trim();
      if (!text || /^ok\.?$/i.test(text)) {
        return { added: 1, pending: 0, failed: 0, torrentIds: [] };
      }
      if (/^fails\.?$/i.test(text)) {
        throw new UpstreamError(
          "qbittorrent",
          "http",
          "qBittorrent rejected that torrent",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new UpstreamError(
          "qbittorrent",
          "invalid_response",
          "qBittorrent returned an invalid add-torrent response",
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new UpstreamError(
          "qbittorrent",
          "invalid_response",
          "qBittorrent returned an invalid add-torrent response",
        );
      }
      const value = parsed as Record<string, unknown>;
      const added = integerCount(value.success_count);
      const pending = value.pending_count === undefined ? 0 : nonNegativeInteger(value.pending_count);
      const failed = nonNegative(Number(value.failure_count)) ?? 0;
      const torrentIds = Array.isArray(value.added_torrent_ids)
        ? value.added_torrent_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (added === undefined || pending === undefined || failed < 0) {
        throw new UpstreamError(
          "qbittorrent",
          "invalid_response",
          "qBittorrent returned an invalid add-torrent response",
        );
      }
      if (added + pending === 0) {
        throw new UpstreamError(
          "qbittorrent",
          "http",
          failed > 0
            ? "qBittorrent rejected that torrent"
            : "qBittorrent did not add that torrent",
        );
      }
      return { added, pending, failed, torrentIds };
    },

    /** Add tags to existing torrents without changing their download state. */
    async addTags(hashes: string[], tags: string[]): Promise<void> {
      const normalizedHashes = hashes
        .map(normalizeInfoHash)
        .filter((hash) => hash !== "");
      const normalizedTags = tags.map((tag) => tag.trim()).filter((tag) => tag !== "");
      if (normalizedHashes.length === 0 || normalizedTags.length === 0) {
        return;
      }
      const body = new URLSearchParams({
        hashes: normalizedHashes.join("|"),
        tags: normalizedTags.join(","),
      });
      const response = await fetchWithTimeout(
        "qbittorrent",
        `${config.url}/api/v2/torrents/addTags`,
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

function integerCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return integerCount(value);
}

function nonNegative(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
