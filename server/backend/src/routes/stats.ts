import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { aggregateStats } from "../stats.js";
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

    // qBittorrent supplies the all-time totals and free space; Sonarr/Radarr
    // supply total capacity for the same /data volume. Let either side fail
    // without blanking the whole stats page.
    const [qbittorrentResult, diskResult] = await Promise.allSettled([
      createQbittorrentClient(config.qbittorrent, config.requestTimeoutMs).getMainData(),
      loadDiskSource(config),
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

    const diskData = diskResult.status === "fulfilled" ? diskResult.value : undefined;
    if (diskResult.status === "rejected") {
      errors.push({
        source: "disk",
        message: sourceErrorMessage("disk", diskResult.reason),
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

    const response: StatsResponse = { checkedAt, ...aggregate, errors };
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
  return source === "qbittorrent"
    ? "Could not read qBittorrent stats"
    : "Could not read disk space from Sonarr or Radarr";
}
