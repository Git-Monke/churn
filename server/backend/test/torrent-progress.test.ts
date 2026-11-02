import { describe, expect, it } from "vitest";

import {
  applyTorrentProgress,
  formatDuration,
  indexTorrents,
} from "../src/torrent-progress.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";
import type { ServarrQueueRecord } from "../src/upstream/servarr.js";

function record(overrides: Partial<ServarrQueueRecord> = {}): ServarrQueueRecord {
  return {
    id: 1,
    downloadId: "ABCDEF0123456789",
    title: "Example.Release",
    status: "downloading",
    trackedDownloadStatus: "ok",
    trackedDownloadState: "downloading",
    protocol: "torrent",
    size: 1000,
    sizeleft: 600,
    timeleft: "00:10:00",
    ...overrides,
  };
}

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "abcdef0123456789",
    size: 2000,
    amount_left: 500,
    progress: 0.75,
    dlspeed: 1_500_000,
    eta: 65,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats durations as HH:MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(5)).toBe("00:00:05");
    expect(formatDuration(65)).toBe("00:01:05");
    expect(formatDuration(3661)).toBe("01:01:01");
  });
});

describe("indexTorrents", () => {
  it("indexes v1/v2 hashes case-insensitively", () => {
    const indexed = indexTorrents([
      { infohash_v1: "AAAA", infohash_v2: "BBBB" },
      { hash: "CCCC" },
    ]);

    expect(indexed.get("aaaa")).toMatchObject({ infohash_v2: "BBBB" });
    expect(indexed.get("bbbb")).toMatchObject({ infohash_v1: "AAAA" });
    expect(indexed.get("cccc")).toMatchObject({ hash: "CCCC" });
  });
});

describe("qBittorrent overlay", () => {
  it("matches the arr hash regardless of case", () => {
    const recordWithHash = record({ downloadId: "AbCdEf0123456789" });
    const [updated] = applyTorrentProgress([recordWithHash], indexTorrents([torrent()]));
    expect(updated?.sizeleft).toBe(500);
  });

  it("overlays progress, size, ETA and speed for a matching hash", () => {
    const [updated] = applyTorrentProgress([record()], indexTorrents([torrent()]));

    expect(updated).toMatchObject({
      size: 2000,
      sizeleft: 500,
      timeleft: "00:01:05",
      downloadSpeed: 1_500_000,
      status: "downloading",
      trackedDownloadState: "downloading",
    });
  });

  it("falls back to computed bytes when amount_left is not usable", () => {
    const [updated] = applyTorrentProgress(
      [record()],
      indexTorrents([torrent({ amount_left: -1, progress: 0.25 })]),
    );

    expect(updated).toMatchObject({ sizeleft: 1500 });
  });

  it("leaves usenet, unmatched and missing-hash records alone", () => {
    const usenet = record({ protocol: "usenet", downloadId: "abcdef0123456789" });
    const unmatched = record({ protocol: "torrent", downloadId: "ffffffff" });
    const missing = record({ protocol: "torrent", downloadId: undefined });
    const records = [usenet, unmatched, missing];

    expect(applyTorrentProgress(records, indexTorrents([torrent()]))).toEqual(records);
  });

  it("keeps arr import and warning state", () => {
    const importing = record({
      status: "completed",
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "warning",
      statusMessages: [{ title: "Needs attention", messages: ["check import"] }],
    });
    const [updated] = applyTorrentProgress(
      [importing],
      indexTorrents([torrent({ progress: 1, amount_left: 0, eta: 0 })]),
    );

    expect(updated).toMatchObject({
      status: "completed",
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "warning",
      statusMessages: [{ title: "Needs attention", messages: ["check import"] }],
      sizeleft: 0,
      timeleft: "00:10:00",
    });
  });

  it("leaves arr values when qBittorrent has no usable size or ETA", () => {
    const [updated] = applyTorrentProgress(
      [record()],
      indexTorrents([torrent({ size: 0, progress: -1, eta: 8_640_000, dlspeed: 0 })]),
    );

    expect(updated).toMatchObject({
      size: 1000,
      sizeleft: 600,
      timeleft: "00:10:00",
      downloadSpeed: 0,
    });
  });

  it("does not mix qBittorrent size with arr progress when progress is missing", () => {
    const [updated] = applyTorrentProgress(
      [record()],
      indexTorrents([torrent({ size: 2000, progress: undefined })]),
    );

    expect(updated).toMatchObject({ size: 1000, sizeleft: 600 });
  });

  it("returns the original array when there are no torrents", () => {
    const records = [record()];
    expect(applyTorrentProgress(records, new Map())).toBe(records);
  });
});
