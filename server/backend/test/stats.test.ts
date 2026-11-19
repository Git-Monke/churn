import { describe, expect, it } from "vitest";

import {
  aggregateDiskUsage,
  aggregateStats,
  isPathWithin,
  parseTransferTotals,
  rankStorage,
  rankTorrents,
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

describe("library rankings", () => {
  const library = {
    series: [{ id: 2, title: "Example Show", statistics: { sizeOnDisk: 700 } }],
    movies: [{ id: 1, title: "Big Movie", statistics: { sizeOnDisk: 900 } }],
  };

  it("ranks tagged torrents by the requested metric and maps them to titles", () => {
    const torrents = [
      { name: "Big.Movie.2160p", downloaded: 500, uploaded: 50, tags: "churn-movie-1" },
      { name: "Show.S01", downloaded: 200, uploaded: 400, tags: "churn-series-2" },
      { name: "Show.S02", downloaded: 50, uploaded: 0, tags: "churn-series-2" },
      { name: "Unknown.Release", downloaded: 100, uploaded: 0 },
      { name: "Empty", downloaded: 0, uploaded: 0 },
    ];

    expect(rankTorrents(torrents, "downloaded", library)).toEqual([
      { name: "Big Movie", bytes: 500, kind: "movie" },
      { name: "Example Show", bytes: 200, kind: "series", detail: "Show.S01" },
      { name: "Unknown.Release", bytes: 100 },
      { name: "Example Show", bytes: 50, kind: "series", detail: "Show.S02" },
    ]);
    expect(rankTorrents(torrents, "uploaded", library)).toEqual([
      { name: "Example Show", bytes: 400, kind: "series" },
      { name: "Big Movie", bytes: 50, kind: "movie" },
    ]);
  });

  it("limits lists and tolerates missing torrent data", () => {
    expect(rankTorrents(undefined, "downloaded", library)).toEqual([]);
    expect(rankTorrents([], "uploaded", library)).toEqual([]);
    expect(
      rankTorrents(
        [
          { name: "A", downloaded: 1 },
          { name: "B", downloaded: 2 },
          { name: "C", downloaded: 3 },
        ],
        "downloaded",
        undefined,
        2,
      ),
    ).toEqual([
      { name: "C", bytes: 3 },
      { name: "B", bytes: 2 },
    ]);
  });

  it("ranks series and movies together by size on disk", () => {
    expect(rankStorage(library)).toEqual([
      { name: "Big Movie", bytes: 900, kind: "movie" },
      { name: "Example Show", bytes: 700, kind: "series" },
    ]);
    expect(
      rankStorage({
        series: [{ id: 3, title: "No Files", statistics: { sizeOnDisk: 0 } }],
        movies: [],
      }),
    ).toEqual([]);
    expect(rankStorage(undefined)).toEqual([]);
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
