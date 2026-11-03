import path from "node:path";

import type { AppConfig } from "./config.js";
import { ApiError, UpstreamError } from "./errors.js";
import {
  createQbittorrentClient,
  normalizeInfoHash,
  type QbittorrentTorrent,
} from "./upstream/qbittorrent.js";
import { createArrClient } from "./upstream/servarr.js";
import { errorMessage } from "./upstream/states.js";

/** Applied to every download churn sends straight to qBittorrent. */
export const DIRECT_DOWNLOAD_TAG = "churn-direct";

const DEFAULT_MEDIA_ROOT = "/data/media";

export interface DirectReleaseSource {
  guid?: string;
  title?: string;
  infoHash?: string;
  downloadUrl?: string;
  magnetUrl?: string;
}

export interface DirectGrabTarget {
  kind: "movie" | "series";
  arrId: number;
  title: string;
  year?: number;
  /** Season for single-season and episode downloads. */
  seasonNumber?: number;
  /** A pack covering more than one season goes in the show folder itself. */
  multiSeason?: boolean;
  /** Existing arr folder, when the caller already loaded it. */
  libraryPath?: string;
}

export interface DirectGrabResult {
  title: string;
  savePath: string;
  /** True when the same torrent was already present in qBittorrent. */
  alreadyDownloading: boolean;
}

/**
 * qBittorrent can fetch the Prowlarr download URL directly because both
 * containers share gluetun's network namespace. Magnet URLs are used first so
 * no HTTP fetch is needed. A bare HTTP GUID is only a landing page, not a file.
 */
export function isDirectDownloadTorrent(torrent: QbittorrentTorrent): boolean {
  return (torrent.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .includes(DIRECT_DOWNLOAD_TAG);
}

export function directDownloadSource(release: DirectReleaseSource): string | undefined {
  const magnet = release.magnetUrl?.trim();
  if (magnet) {
    return magnet;
  }
  const downloadUrl = release.downloadUrl?.trim();
  if (downloadUrl) {
    return downloadUrl;
  }
  const guid = release.guid?.trim();
  return guid?.toLowerCase().startsWith("magnet:") ? guid : undefined;
}

export async function grabTorrentDirect(
  config: AppConfig,
  release: DirectReleaseSource,
  target: DirectGrabTarget,
): Promise<DirectGrabResult> {
  if (!config.qbittorrent.apiKey) {
    throw new ApiError(
      503,
      "qbittorrent_unconfigured",
      "Set QBITTORRENT_API_KEY or keep the seeded qBittorrent config file",
    );
  }

  const url = directDownloadSource(release);
  if (!url) {
    throw new ApiError(
      409,
      "release_download_unavailable",
      "That result does not include a torrent or magnet URL",
    );
  }

  const client = createQbittorrentClient(config.qbittorrent, config.requestTimeoutMs);
  const savePath = await resolveSavePath(config, target);
  const existing = await findExistingTorrent(client, release, false);
  if (existing) {
    return {
      title: release.title?.trim() || target.title,
      savePath,
      alreadyDownloading: true,
    };
  }

  try {
    await client.addTorrent({
      url,
      savePath,
      category: target.kind === "movie" ? "movies" : "tv",
      tags: [DIRECT_DOWNLOAD_TAG],
      contentLayout: "NoSubfolder",
      autoTMM: false,
    });
  } catch (error) {
    // qBittorrent reports a duplicate add as a failure. Re-check after the
    // failed add so a double click still behaves like the first click.
    const current = await findExistingTorrent(client, release, true);
    if (current) {
      return {
        title: release.title?.trim() || target.title,
        savePath,
        alreadyDownloading: true,
      };
    }
    throw directGrabError(error);
  }

  return {
    title: release.title?.trim() || target.title,
    savePath,
    alreadyDownloading: false,
  };
}

export function directGrabError(error: unknown): unknown {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof UpstreamError) {
    return new ApiError(
      502,
      "qbittorrent_grab_failed",
      `Could not send that release to qBittorrent: ${error.message}`,
    );
  }
  return new ApiError(
    502,
    "qbittorrent_grab_failed",
    `Could not send that release to qBittorrent: ${errorMessage(error)}`,
  );
}

async function resolveSavePath(config: AppConfig, target: DirectGrabTarget): Promise<string> {
  const folder = await resolveArrFolder(config, target);
  if (target.kind === "movie") {
    return folder;
  }
  if (target.multiSeason || target.seasonNumber === undefined) {
    return folder;
  }
  return path.posix.join(folder, `Season ${target.seasonNumber}`);
}

async function resolveArrFolder(config: AppConfig, target: DirectGrabTarget): Promise<string> {
  if (target.libraryPath && path.posix.isAbsolute(target.libraryPath)) {
    return target.libraryPath;
  }
  const serviceId = target.kind === "movie" ? "radarr" : "sonarr";
  const service = config.services[serviceId];
  if (service.apiKey) {
    try {
      const client = createArrClient(serviceId, service, config.requestTimeoutMs);
      const folder = target.kind === "movie"
        ? (await client.getMovie(target.arrId)).path?.trim()
        : (await client.getSeries(target.arrId)).path?.trim();
      if (folder && path.posix.isAbsolute(folder)) {
        return folder;
      }
    } catch {
      // The release search itself already depends on the arr. If this lookup is
      // temporarily unavailable, fall back to a deterministic library path.
    }
  }

  const segment = safePathSegment(
    target.year === undefined ? target.title : `${target.title} (${target.year})`,
  );
  return path.posix.join(
    DEFAULT_MEDIA_ROOT,
    target.kind === "movie" ? "movies" : "tv",
    segment,
  );
}

function safePathSegment(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned || "Unknown";
}

async function findExistingTorrent(
  client: ReturnType<typeof createQbittorrentClient>,
  release: DirectReleaseSource,
  allowTitleMatch: boolean,
): Promise<QbittorrentTorrent | undefined> {
  let torrents: QbittorrentTorrent[];
  try {
    torrents = await client.getTorrents();
  } catch {
    return undefined;
  }

  const wantedHash = normalizeInfoHash(release.infoHash);
  if (wantedHash) {
    const match = torrents.find((torrent) =>
      [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]
        .map(normalizeInfoHash)
        .includes(wantedHash),
    );
    if (match) {
      return match;
    }
  }

  if (!allowTitleMatch) {
    return undefined;
  }
  const wantedTitle = normalizeTitle(release.title);
  if (wantedTitle.length < 16) {
    return undefined;
  }
  return torrents.find((torrent) => normalizeTitle(torrent.name) === wantedTitle);
}

function normalizeTitle(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
