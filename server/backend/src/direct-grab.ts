import { createHash } from "node:crypto";
import path from "node:path";

import type { AuthUser } from "./auth.js";
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

const OWNER_TAG_PREFIX = "churn-user-";
const OWNER_TAG_PATTERN = /^churn-user-([0-9a-f]{16})$/;

const MEDIA_TAG_PATTERN = /^churn-(movie|series)-(\d+)$/;

const DEFAULT_MEDIA_ROOT = "/data/media";

/** Stable per-user tag; short enough for qBittorrent's tag field. */
export function mediaOwnerTag(userId: string): string {
  return `${OWNER_TAG_PREFIX}${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
}

/** True when `tags` already names an owner (any owner, not just `userId`). */
export function hasOwnerTag(tags: string | undefined): boolean {
  return splitTags(tags).some((tag) => OWNER_TAG_PATTERN.test(tag));
}

/** True when the torrent is owned by `userId`. */
export function ownerTagMatches(tags: string | undefined, userId: string): boolean {
  const wanted = mediaOwnerTag(userId);
  return splitTags(tags).includes(wanted);
}

/** Implemented by the disk-share service; throws ApiError when over the limit. */
export interface GrabQuota {
  reserve(actor: AuthUser, bytes: number): Promise<void>;
  release(actorId: string, bytes: number): void;
}

export interface DirectGrabOptions {
  actor?: AuthUser;
  quota?: GrabQuota;
}

export interface DirectReleaseSource {
  guid?: string;
  title?: string;
  infoHash?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  /** Release size in bytes; 0 when unknown. */
  size?: number;
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
  return splitTags(torrent.tags).includes(DIRECT_DOWNLOAD_TAG);
}

/** Stable media link stored on the torrent so hash-named magnets stay attached. */
export function mediaDownloadTag(kind: "movie" | "series", arrId: number): string {
  return `churn-${kind}-${arrId}`;
}

export function parseMediaDownloadTag(
  tags: string | undefined,
): { kind: "movie" | "series"; arrId: number } | undefined {
  for (const tag of splitTags(tags)) {
    const match = MEDIA_TAG_PATTERN.exec(tag);
    if (!match) {
      continue;
    }
    const arrId = Number.parseInt(match[2] ?? "", 10);
    if (Number.isSafeInteger(arrId) && arrId > 0) {
      return { kind: match[1] === "movie" ? "movie" : "series", arrId };
    }
  }
  return undefined;
}

function splitTags(tags: string | undefined): string[] {
  return (tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
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
  options: DirectGrabOptions = {},
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
  const mediaTag = mediaDownloadTag(target.kind, target.arrId);
  const ownerTag = options.actor ? mediaOwnerTag(options.actor.id) : undefined;
  const existing = await findExistingTorrent(client, release, false);
  if (existing) {
    await tagExistingTorrent(client, existing, missingTags(existing, mediaTag, ownerTag));
    return {
      title: release.title?.trim() || target.title,
      savePath,
      alreadyDownloading: true,
    };
  }

  const bytes = release.size ?? 0;
  if (options.quota && options.actor) {
    await options.quota.reserve(options.actor, bytes);
  }
  try {
    await client.addTorrent({
      url,
      savePath,
      category: target.kind === "movie" ? "movies" : "tv",
      tags: [
        DIRECT_DOWNLOAD_TAG,
        mediaTag,
        ...(ownerTag ? [ownerTag] : []),
      ],
      // The save path is the finished library folder, so the payload has to
      // land flat for Jellyfin to see it. The arr only learns about the file
      // through a library scan, which the disk-share service triggers once the
      // torrent finishes.
      contentLayout: "NoSubfolder",
      autoTMM: false,
    });
  } catch (error) {
    // qBittorrent reports a duplicate add as a failure. Re-check after the
    // failed add so a double click still behaves like the first click.
    const current = await findExistingTorrent(client, release, true);
    if (current) {
      await tagExistingTorrent(client, current, missingTags(current, mediaTag, ownerTag));
      return {
        title: release.title?.trim() || target.title,
        savePath,
        alreadyDownloading: true,
      };
    }
    throw directGrabError(error);
  } finally {
    if (options.quota && options.actor) {
      options.quota.release(options.actor.id, bytes);
    }
  }

  return {
    title: release.title?.trim() || target.title,
    savePath,
    alreadyDownloading: false,
  };
}

/** Tags this torrent lacks; an owner tag is only added when none is present. */
function missingTags(
  torrent: QbittorrentTorrent,
  mediaTag: string,
  ownerTag: string | undefined,
): string[] {
  const present = splitTags(torrent.tags);
  return [
    mediaTag,
    ...(ownerTag && !hasOwnerTag(torrent.tags) ? [ownerTag] : []),
  ].filter((tag) => !present.includes(tag));
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

async function tagExistingTorrent(
  client: ReturnType<typeof createQbittorrentClient>,
  torrent: QbittorrentTorrent,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) {
    return;
  }
  const hash = [torrent.hash, torrent.infohash_v1, torrent.infohash_v2]
    .map(normalizeInfoHash)
    .find((value) => value !== "");
  if (!hash) {
    return;
  }
  try {
    await client.addTags([hash], tags);
  } catch {
    // The torrent already exists; a failed tag must not turn a duplicate grab
    // into an error. The normal title matcher still works for named torrents.
  }
}
