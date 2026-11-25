import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuthUser, ProfileRecord } from "./auth.js";
import type { AppConfig } from "./config.js";
import {
  ownerTagMatches,
  parseMediaDownloadTag,
  type GrabQuota,
} from "./direct-grab.js";
import { ApiError } from "./errors.js";
import type { MediaAttributionStore } from "./media-attribution.js";
import { isActiveTorrent } from "./qbittorrent-activity.js";
import { aggregateDiskUsage, loadDiskSource } from "./stats.js";
import type { DiskShareAdminResponse, DiskShareSummary } from "./types.js";
import { createQbittorrentClient } from "./upstream/qbittorrent.js";
import { createArrClient } from "./upstream/servarr.js";

export const DISK_SHARES_VERSION = 1;
export const DISK_SHARES_FILENAME = "disk-shares.json";
/** A person is "near" their limit when at least 90% is used. */
export const NEAR_LIMIT_USED_PERCENT = 90;
/** How long to wait before asking the arr to scan the same download again. */
const SCAN_RETRY_MS = 5 * 60_000;

export interface DiskShareSettings {
  enabled: boolean;
  /** Jellyfin user id -> limit in bytes. Absent = equal share. */
  overrides: Record<string, number>;
}

/**
 * Override wins; otherwise totalBytes is split evenly across every profile.
 * `undefined` means "no limit" (feature disabled, admin, no capacity, no profiles).
 */
export function diskShareLimit(
  settings: DiskShareSettings,
  jellyfinUserId: string,
  totalBytes: number | undefined,
  userCount: number,
): number | undefined {
  if (!settings.enabled) {
    return undefined;
  }
  const override = settings.overrides[jellyfinUserId];
  if (override !== undefined) {
    return override;
  }
  if (totalBytes === undefined || totalBytes <= 0 || userCount <= 0) {
    return undefined;
  }
  return Math.floor(totalBytes / userCount);
}

export interface DiskShareService extends GrabQuota {
  setEnabled(enabled: boolean): Promise<void>;
  setUserLimit(jellyfinUserId: string, limitBytes: number | null): Promise<void>;
  removeOverride(jellyfinUserId: string): Promise<void>;
  summary(actor: AuthUser): Promise<DiskShareSummary>;
  adminSummary(): Promise<DiskShareAdminResponse>;
}

export interface DiskShareServiceOptions {
  config: AppConfig;
  attribution: MediaAttributionStore;
  profiles: () => ProfileRecord[];
  onWarning: (message: string) => void;
}

interface UserUsage {
  libraryBytes: number;
  downloadBytes: number;
}

interface UsageSnapshot {
  usable: boolean;
  detail?: string;
  totalBytes?: number;
  byUser: Map<string, UserUsage>;
}

export function createDiskShareService(
  options: DiskShareServiceOptions,
): DiskShareService {
  const { config, attribution, profiles, onWarning } = options;
  const filePath = path.join(config.stateDir, DISK_SHARES_FILENAME);
  const settings = loadSettings(filePath, onWarning);
  const reserved = new Map<string, number>();
  const scanRequests = new Map<string, number>();
  const warned = new Set<string>();
  let writeChain: Promise<void> = Promise.resolve();

  function warnOnce(message: string): void {
    if (warned.has(message)) {
      return;
    }
    warned.add(message);
    onWarning(message);
  }

  function persist(): Promise<void> {
    const state = {
      version: DISK_SHARES_VERSION,
      enabled: settings.enabled,
      overrides: { ...settings.overrides },
    };
    const write = writeChain
      .catch(() => {
        // A failed write must not block every later write.
      })
      .then(() => writeJson(filePath, state));
    writeChain = write;
    return write.catch((error: unknown) => {
      onWarning(
        `Could not save disk share settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function loadSnapshot(): Promise<UsageSnapshot> {
    const qbittorrent = createQbittorrentClient(
      config.qbittorrent,
      config.requestTimeoutMs,
    );
    const sonarr = createArrClient(
      "sonarr",
      config.services.sonarr,
      config.requestTimeoutMs,
    );
    const radarr = createArrClient(
      "radarr",
      config.services.radarr,
      config.requestTimeoutMs,
    );
    const [disk, series, movies, torrents] = await Promise.allSettled([
      loadDiskSource(config),
      sonarr.listSeries(),
      radarr.listMovies(),
      qbittorrent.getTorrents(),
    ]);

    const userProfiles = profiles();
    const byUser = new Map<string, UserUsage>();
    for (const profile of userProfiles) {
      byUser.set(profile.jellyfinUserId, { libraryBytes: 0, downloadBytes: 0 });
    }

    /** Asks the arr to rescan the folder a finished grab landed in. */
    const requestScan = (
      media: { kind: "movie" | "series"; arrId: number },
      scanKey: string,
    ): void => {
      const last = scanRequests.get(scanKey);
      const now = Date.now();
      if (last !== undefined && now - last < SCAN_RETRY_MS) {
        return;
      }
      scanRequests.set(scanKey, now);
      const command =
        media.kind === "movie"
          ? { name: "RescanMovie", movieId: media.arrId }
          : { name: "RescanSeries", seriesId: media.arrId };
      const client = media.kind === "movie" ? radarr : sonarr;
      void client.runCommand(command).catch(() => {
        warnOnce("Could not ask Radarr or Sonarr to scan a finished download");
      });
    };

    let detail: string | undefined;
    if (series.status === "rejected" || movies.status === "rejected") {
      detail = "Could not read media sizes from Sonarr or Radarr";
    }
    if (disk.status === "rejected") {
      detail ??= "Could not read disk space from Sonarr or Radarr";
    }
    if (torrents.status === "rejected") {
      detail ??= "Could not read qBittorrent downloads";
    }

    const totalBytes =
      disk.status === "fulfilled"
        ? aggregateDiskUsage(disk.value.diskSpace, disk.value.rootFolders)?.totalBytes
        : undefined;

    if (series.status === "fulfilled") {
      for (const entry of series.value) {
        const addedBy = attribution.get({
          kind: "series",
          tvdbId: entry.tvdbId,
          tmdbId: entry.tmdbId,
        });
        const usage = addedBy ? byUser.get(addedBy.id) : undefined;
        if (usage) {
          usage.libraryBytes += bytesOf(entry.statistics?.sizeOnDisk);
        }
      }
    }
    if (movies.status === "fulfilled") {
      for (const entry of movies.value) {
        const addedBy = attribution.get({ kind: "movie", tmdbId: entry.tmdbId });
        const usage = addedBy ? byUser.get(addedBy.id) : undefined;
        if (usage) {
          usage.libraryBytes += bytesOf(entry.statistics?.sizeOnDisk);
        }
      }
    }
    const bytesOnDisk = new Map<string, number>();
    if (movies.status === "fulfilled") {
      for (const entry of movies.value) {
        bytesOnDisk.set(`movie:${entry.id}`, bytesOf(entry.statistics?.sizeOnDisk));
      }
    }
    if (series.status === "fulfilled") {
      for (const entry of series.value) {
        bytesOnDisk.set(`series:${entry.id}`, bytesOf(entry.statistics?.sizeOnDisk));
      }
    }

    if (torrents.status === "fulfilled") {
      for (const torrent of torrents.value) {
        if (isActiveTorrent(torrent)) {
          for (const profile of userProfiles) {
            if (ownerTagMatches(torrent.tags, profile.jellyfinUserId)) {
              const usage = byUser.get(profile.jellyfinUserId);
              if (usage) {
                usage.downloadBytes += bytesOf(torrent.size);
              }
            }
          }
          continue;
        }
        // Direct grabs download into the finished library folder, so the arr
        // only learns about the file from a library scan. Until that scan
        // runs, its statistics report nothing and the share looks empty.
        const media = parseMediaDownloadTag(torrent.tags);
        if (!media) {
          continue;
        }
        const key = `${media.kind}:${media.arrId}`;
        const onDisk = bytesOnDisk.get(key);
        if (onDisk === undefined) {
          continue;
        }
        const scanKey = torrent.hash ?? torrent.infohash_v1 ?? torrent.name ?? key;
        if (onDisk > 0) {
          scanRequests.delete(scanKey);
          continue;
        }
        requestScan(media, scanKey);
      }
    }

    return {
      usable: detail === undefined,
      ...(detail !== undefined ? { detail } : {}),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      byUser,
    };
  }

  async function reserve(actor: AuthUser, bytes: number): Promise<void> {
    if (actor.isAdmin || !settings.enabled || bytes <= 0) {
      return;
    }
    const snapshot = await loadSnapshot();
    if (!snapshot.usable) {
      warnOnce(
        `Disk share check skipped (${snapshot.detail ?? "usage is unavailable"}); allowing the download`,
      );
      return;
    }
    const limit = diskShareLimit(
      settings,
      actor.id,
      snapshot.totalBytes,
      profiles().length,
    );
    if (limit === undefined) {
      return;
    }
    const usage = snapshot.byUser.get(actor.id);
    const used =
      (usage?.libraryBytes ?? 0) +
      (usage?.downloadBytes ?? 0) +
      (reserved.get(actor.id) ?? 0);
    if (used + bytes > limit) {
      throw new ApiError(
        409,
        "disk_share_exceeded",
        `This download is ${formatGigabytes(bytes)}, but your ${formatGigabytes(limit)} share only has ${formatGigabytes(Math.max(0, limit - used))} free. Remove something you have finished with, then try again.`,
      );
    }
    reserved.set(actor.id, (reserved.get(actor.id) ?? 0) + bytes);
  }

  function release(actorId: string, bytes: number): void {
    const current = reserved.get(actorId);
    if (current === undefined) {
      return;
    }
    const next = Math.max(0, current - bytes);
    if (next === 0) {
      reserved.delete(actorId);
    } else {
      reserved.set(actorId, next);
    }
  }

  async function summary(actor: AuthUser): Promise<DiskShareSummary> {
    const userCount = profiles().length;
    if (!settings.enabled) {
      return {
        enabled: false,
        state: "ok",
        userCount,
        limitBytes: null,
        usedBytes: 0,
        libraryBytes: 0,
        downloadBytes: 0,
        remainingBytes: null,
        usedPercent: null,
        nearLimit: false,
        customLimit: false,
      };
    }

    // Admins are never limited, so skip the upstream snapshot entirely.
    if (actor.isAdmin) {
      return {
        enabled: true,
        state: "ok",
        userCount,
        limitBytes: null,
        usedBytes: 0,
        libraryBytes: 0,
        downloadBytes: 0,
        remainingBytes: null,
        usedPercent: null,
        nearLimit: false,
        customLimit: false,
      };
    }

    const snapshot = await loadSnapshot();
    const limit = diskShareLimit(settings, actor.id, snapshot.totalBytes, userCount);
    const usage = snapshot.byUser.get(actor.id);
    const libraryBytes = usage?.libraryBytes ?? 0;
    const downloadBytes = usage?.downloadBytes ?? 0;
    const usedBytes = libraryBytes + downloadBytes;
    return {
      enabled: true,
      state: snapshot.usable ? "ok" : "unavailable",
      ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
      userCount,
      limitBytes: limit ?? null,
      usedBytes,
      libraryBytes,
      downloadBytes,
      remainingBytes: limit === undefined ? null : Math.max(0, limit - usedBytes),
      usedPercent:
        limit === undefined
          ? null
          : Math.round((usedBytes / limit) * 1000) / 10,
      nearLimit:
        limit !== undefined &&
        limit > 0 &&
        usedBytes >= (limit * NEAR_LIMIT_USED_PERCENT) / 100,
      customLimit: settings.overrides[actor.id] !== undefined,
    };
  }

  async function adminSummary(): Promise<DiskShareAdminResponse> {
    const userProfiles = profiles();
    const userCount = userProfiles.length;
    if (!settings.enabled) {
      return {
        enabled: false,
        state: "ok",
        userCount,
        users: userProfiles.map((profile) => ({
          profileId: profile.id,
          jellyfinUserId: profile.jellyfinUserId,
          name: profile.name,
          limitBytes: null,
          customLimit: false,
          usedBytes: 0,
          nearLimit: false,
        })),
      };
    }

    const snapshot = await loadSnapshot();
    const equalShareBytes =
      snapshot.totalBytes !== undefined && userCount > 0
        ? Math.floor(snapshot.totalBytes / userCount)
        : undefined;
    return {
      enabled: true,
      state: snapshot.usable ? "ok" : "unavailable",
      ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
      ...(snapshot.totalBytes !== undefined
        ? { totalBytes: snapshot.totalBytes }
        : {}),
      ...(equalShareBytes !== undefined ? { equalShareBytes } : {}),
      userCount,
      users: userProfiles.map((profile) => {
        const limit = diskShareLimit(
          settings,
          profile.jellyfinUserId,
          snapshot.totalBytes,
          userCount,
        );
        const usage = snapshot.byUser.get(profile.jellyfinUserId);
        const usedBytes = (usage?.libraryBytes ?? 0) + (usage?.downloadBytes ?? 0);
        return {
          profileId: profile.id,
          jellyfinUserId: profile.jellyfinUserId,
          name: profile.name,
          limitBytes: limit ?? null,
          customLimit: settings.overrides[profile.jellyfinUserId] !== undefined,
          usedBytes,
          nearLimit:
            limit !== undefined &&
            limit > 0 &&
            usedBytes >= (limit * NEAR_LIMIT_USED_PERCENT) / 100,
        };
      }),
    };
  }

  return {
    setEnabled: async (enabled) => {
      settings.enabled = enabled;
      await persist();
    },
    setUserLimit: async (jellyfinUserId, limitBytes) => {
      if (limitBytes === null) {
        delete settings.overrides[jellyfinUserId];
      } else {
        settings.overrides[jellyfinUserId] = limitBytes;
      }
      await persist();
    },
    removeOverride: async (jellyfinUserId) => {
      if (settings.overrides[jellyfinUserId] === undefined) {
        return;
      }
      delete settings.overrides[jellyfinUserId];
      await persist();
    },
    summary,
    adminSummary,
    reserve,
    release,
  };
}

/** One decimal everywhere; no magnitude branch. */
function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function bytesOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function defaultSettings(): DiskShareSettings {
  return { enabled: false, overrides: {} };
}

function loadSettings(
  filePath: string,
  onWarning: (message: string) => void,
): DiskShareSettings {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      onWarning(`Ignoring unreadable disk share file at ${filePath}`);
    }
    return defaultSettings();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    onWarning(`Ignoring corrupt disk share file at ${filePath}`);
    return defaultSettings();
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== DISK_SHARES_VERSION ||
    typeof parsed.enabled !== "boolean"
  ) {
    onWarning(`Ignoring unsupported disk share file at ${filePath}`);
    return defaultSettings();
  }

  const overrides: Record<string, number> = {};
  if (isRecord(parsed.overrides)) {
    for (const [id, value] of Object.entries(parsed.overrides)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        overrides[id] = value;
      }
    }
  }
  return { enabled: parsed.enabled, overrides };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}
