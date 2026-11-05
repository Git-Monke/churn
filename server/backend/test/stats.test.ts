import { describe, expect, it } from "vitest";

import {
  aggregateDiskUsage,
  aggregateStats,
  isPathWithin,
  parseTransferTotals,
  selectDiskSpace,
} from "../src/stats.js";

const TB = 1024 ** 4;

describe("stats aggregation", () => {
  it("combines qBittorrent all-time totals and free space with arr capacity", () => {
    const result = aggregateStats({
      mainData: {
        server_state: {
          alltime_dl: 3 * TB,
          alltime_ul: TB,
          free_space_on_disk: 0.5 * TB,
        },
      },
      diskSpace: [{ path: "/data", freeSpace: 0.75 * TB, totalSpace: 2 * TB }],
      rootFolders: [{ path: "/data/media/tv", accessible: true }],
    });

    expect(result.qbittorrent).toEqual({
      totalDownloadedBytes: 3 * TB,
      totalUploadedBytes: TB,
    });
    expect(result.disk).toEqual({
      totalBytes: 2 * TB,
      freeBytes: 0.5 * TB,
      usedBytes: 1.5 * TB,
      usedPercent: 75,
    });
  });

  it("uses the arr free space when qBittorrent reports more free than capacity", () => {
    expect(
      aggregateDiskUsage(
        [{ path: "/data", freeSpace: 40, totalSpace: 100 }],
        120,
        [{ path: "/data/media/movies", accessible: true }],
      ),
    ).toEqual({ totalBytes: 100, freeBytes: 40, usedBytes: 60, usedPercent: 60 });
  });

  it("omits disk usage when no total capacity is available", () => {
    expect(aggregateDiskUsage([{ path: "/data", freeSpace: 40 }], 40)).toBeUndefined();
    expect(aggregateDiskUsage(undefined, 40)).toBeUndefined();
  });

  it("rounds percentages to one decimal and clamps the range", () => {
    expect(
      aggregateDiskUsage([{ path: "/data", totalSpace: 3 }], 2),
    ).toEqual({
      totalBytes: 3,
      freeBytes: 2,
      usedBytes: 1,
      usedPercent: 33.3,
    });
    expect(aggregateDiskUsage([{ path: "/data", totalSpace: 100 }], 0)?.usedPercent).toBe(100);
    expect(aggregateDiskUsage([{ path: "/data", totalSpace: 100 }], 200)).toBeUndefined();
    expect(
      aggregateDiskUsage([{ path: "/data", totalSpace: 100, freeSpace: 200 }], 200),
    ).toEqual({ totalBytes: 100, freeBytes: 100, usedBytes: 0, usedPercent: 0 });
  });

  it("treats a missing all-time value as zero", () => {
    expect(parseTransferTotals({ alltime_dl: 10 })).toEqual({
      totalDownloadedBytes: 10,
      totalUploadedBytes: 0,
    });
    expect(parseTransferTotals({})).toBeUndefined();
  });
});

describe("disk selection", () => {
  it("matches the mount that backs a root folder", () => {
    const selected = selectDiskSpace(
      [
        { path: "/", totalSpace: 10_000 },
        { path: "/data", totalSpace: 2_000 },
      ],
      [{ path: "/data/media/tv", accessible: true }],
    );
    expect(selected?.path).toBe("/data");
  });

  it("prefers the most specific matching mount", () => {
    const selected = selectDiskSpace(
      [
        { path: "/", totalSpace: 10_000 },
        { path: "/data", totalSpace: 8_000 },
        { path: "/data/media", totalSpace: 4_000 },
      ],
      [{ path: "/data/media/movies", accessible: true }],
    );
    expect(selected?.path).toBe("/data/media");
  });

  it("falls back to the largest total when no root folder matches", () => {
    const selected = selectDiskSpace(
      [
        { path: "/config", totalSpace: 100 },
        { path: "/data", totalSpace: 2_000 },
      ],
      [],
    );
    expect(selected?.path).toBe("/data");
  });

  it("does not match a sibling path with a shared prefix", () => {
    expect(isPathWithin("/database", "/data")).toBe(false);
    expect(isPathWithin("/data", "/data")).toBe(true);
    expect(isPathWithin("/data/media/tv", "/data/")).toBe(true);
  });
});
