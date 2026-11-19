import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { aggregateStats, rankStorage, rankTorrents } from "../stats.js";
import type { StatsResponse, StatsSource, StatsSourceError } from "../types.js";
import { createQbittorrentClient } from "../upstream/qbittorrent.js";
import {
  createArrClient,
  type ServarrDiskSpace,
  type ServarrRootFolder,
} from "../upstream/servarr.js";

interface DiskSourceData {
  diskSpace: ServarrDiskSpace[];
  rootFolders: ServarrRootFolder[];
}

export function registerStatsRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/stats", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const checkedAt = new Date().toISOString();

    // qBittorrent supplies the all-time totals, per-torrent transfer and free
    // space; Sonarr/Radarr supply total capacity and per-title storage. Let any
    // source fail without blanking the whole stats page.
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
    const [qbittorrentResult, torrentsResult, diskResult, seriesResult, moviesResult] =
      await Promise.allSettled([
        qbittorrent.getMainData(),
        qbittorrent.getTorrents(),
        loadDiskSource(config),
        sonarr.listSeries(),
        radarr.listMovies(),
      ]);

    const errors: StatsSourceError[] = [];
    const mainData =
      qbittorrentResult.status === "fulfilled" ? qbittorrentResult.value : undefined;
    if (qbittorrentResult.status === "rejected") {
      errors.push({
        source: "qbittorrent",
        message: sourceErrorMessage("qbittorrent", qbittorrentResult.reason),
      });
    }

    const torrents =
      torrentsResult.status === "fulfilled" ? torrentsResult.value : undefined;
    if (torrentsResult.status === "rejected") {
      errors.push({
        source: "qbittorrent",
        message: sourceErrorMessage("qbittorrent", torrentsResult.reason),
      });
    }

    const diskData = diskResult.status === "fulfilled" ? diskResult.value : undefined;
    if (diskResult.status === "rejected") {
      errors.push({
        source: "disk",
        message: sourceErrorMessage("disk", diskResult.reason),
      });
    }

    const series = seriesResult.status === "fulfilled" ? seriesResult.value : undefined;
    if (seriesResult.status === "rejected") {
      errors.push({
        source: "library",
        message: sourceErrorMessage("library", seriesResult.reason),
      });
    }

    const movies = moviesResult.status === "fulfilled" ? moviesResult.value : undefined;
    if (moviesResult.status === "rejected") {
      errors.push({
        source: "library",
        message: sourceErrorMessage("library", moviesResult.reason),
      });
    }

    const aggregate = aggregateStats({
      mainData,
      diskSpace: diskData?.diskSpace,
      rootFolders: diskData?.rootFolders,
    });
    if (mainData !== undefined && aggregate.qbittorrent === undefined) {
      errors.push({
        source: "qbittorrent",
        message: "qBittorrent did not report all-time transfer totals",
      });
    }
    if (diskData !== undefined && aggregate.disk === undefined) {
      errors.push({ source: "disk", message: "No disk capacity was reported" });
    }

    const library = { series, movies };
    const uniqueErrors = [
      ...new Map(errors.map((error) => [`${error.source}:${error.message}`, error])).values(),
    ];
    const response: StatsResponse = {
      checkedAt,
      ...aggregate,
      ...(torrents !== undefined
        ? {
            topDownloads: rankTorrents(torrents, "downloaded", library),
            topUploads: rankTorrents(torrents, "uploaded", library),
          }
        : {}),
      ...(series !== undefined || movies !== undefined
        ? { topStorage: rankStorage(library) }
        : {}),
      errors: uniqueErrors,
    };
    return response;
  });
}

async function loadDiskSource(config: AppConfig): Promise<DiskSourceData> {
  let lastError: unknown;
  for (const service of ["sonarr", "radarr"] as const) {
    try {
      const client = createArrClient(
        service,
        config.services[service],
        config.requestTimeoutMs,
      );
      const [diskSpace, rootFolders] = await Promise.all([
        client.getDiskSpace(),
        client.getRootFolders(),
      ]);
      if (diskSpace.some((entry) => (entry.totalSpace ?? 0) > 0)) {
        return { diskSpace, rootFolders };
      }
      lastError = new UpstreamError(
        service,
        "invalid_response",
        `${service} did not report any disk capacity`,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no arr disk space available");
}

function sourceErrorMessage(source: StatsSource, error: unknown): string {
  if (error instanceof UpstreamError) {
    return error.message;
  }
  if (source === "qbittorrent") {
    return "Could not read qBittorrent stats";
  }
  if (source === "library") {
    return "Could not read media sizes from Sonarr or Radarr";
  }
  return "Could not read disk space from Sonarr or Radarr";
}
