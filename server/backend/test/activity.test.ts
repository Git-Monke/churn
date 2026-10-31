import { describe, expect, it } from "vitest";

import {
  aggregateQueueRecords,
  buildMovieActivityItem,
  buildSeriesActivityItem,
  isActiveQueueRecord,
  isSeasonPack,
  queueRecordProgress,
  queueRecordStatus,
} from "../src/activity.js";
import type {
  ServarrMovieResource,
  ServarrQueueRecord,
  ServarrSeriesResource,
} from "../src/upstream/servarr.js";

function record(overrides: Partial<ServarrQueueRecord> = {}): ServarrQueueRecord {
  return {
    id: 1,
    title: "Example.Release.1080p",
    status: "downloading",
    trackedDownloadStatus: "ok",
    trackedDownloadState: "downloading",
    size: 1000,
    sizeleft: 400,
    downloadClient: "qBittorrent",
    protocol: "torrent",
    quality: { quality: { name: "HD-1080p" } },
    ...overrides,
  };
}

describe("isActiveQueueRecord", () => {
  it("keeps queued, downloading and importing records", () => {
    expect(isActiveQueueRecord(record({ status: "queued" }))).toBe(true);
    expect(isActiveQueueRecord(record())).toBe(true);
    expect(
      isActiveQueueRecord(record({ status: "completed", trackedDownloadState: "importPending" })),
    ).toBe(true);
    expect(
      isActiveQueueRecord(record({ status: "completed", trackedDownloadState: "importBlocked" })),
    ).toBe(true);
  });

  it("drops failed and already imported records", () => {
    expect(isActiveQueueRecord(record({ status: "failed" }))).toBe(false);
    expect(
      isActiveQueueRecord(record({ status: "completed", trackedDownloadState: "imported" })),
    ).toBe(false);
    expect(
      isActiveQueueRecord(record({ status: "downloading", trackedDownloadState: "downloadFailed" })),
    ).toBe(false);
    expect(isActiveQueueRecord(record({ status: "queued", trackedDownloadState: "failed" }))).toBe(
      false,
    );
  });
});

describe("queue progress and status", () => {
  it("calculates progress from bytes and clamps it", () => {
    expect(queueRecordProgress(record({ size: 1000, sizeleft: 400 }))).toBe(60);
    expect(queueRecordProgress(record({ size: 0, sizeleft: 0 }))).toBe(0);
    expect(queueRecordProgress(record({ size: 100, sizeleft: -20 }))).toBe(100);
    expect(queueRecordProgress(record({ size: 100, sizeleft: 200 }))).toBe(0);
  });

  it("prioritizes warnings over importing and downloading", () => {
    expect(queueRecordStatus(record({ trackedDownloadStatus: "warning" }))).toBe("warning");
    expect(queueRecordStatus(record({ trackedDownloadState: "importPending" }))).toBe("importing");
    expect(queueRecordStatus(record())).toBe("downloading");
    expect(queueRecordStatus(record({ status: "queued" }))).toBe("queued");
  });
});

describe("isSeasonPack", () => {
  it("recognizes a season with no episode id", () => {
    expect(isSeasonPack(record({ seasonNumber: 2 }))).toBe(true);
    expect(isSeasonPack(record({ seasonNumber: 2, episodeId: 11 }))).toBe(false);
    expect(isSeasonPack(record({ episodeId: 11 }))).toBe(false);
  });
});

describe("aggregateQueueRecords", () => {
  it("combines bytes, clients, protocols, seasons and messages", () => {
    const aggregate = aggregateQueueRecords([
      record({ id: 1, size: 1000, sizeleft: 500, seasonNumber: 1 }),
      record({
        id: 2,
        size: 3000,
        sizeleft: 500,
        seasonNumber: 2,
        downloadClient: "SABnzbd",
        protocol: "usenet",
        trackedDownloadStatus: "warning",
        statusMessages: [{ title: "Stalled", messages: ["No peers"] }],
      }),
    ]);

    expect(aggregate.queueCount).toBe(2);
    expect(aggregate.status).toBe("warning");
    expect(aggregate.progress).toBe(75);
    expect(aggregate.sizeBytes).toBe(4000);
    expect(aggregate.sizeLeftBytes).toBe(1000);
    expect(aggregate.downloadClients).toEqual(["qBittorrent", "SABnzbd"]);
    expect(aggregate.protocols).toEqual(["torrent", "usenet"]);
    expect(aggregate.seasons).toEqual([1, 2]);
    expect(aggregate.statusMessages).toEqual(["Stalled", "No peers"]);
  });

  it("returns zero progress when no record reports a size", () => {
    const aggregate = aggregateQueueRecords([
      record({ size: 0, sizeleft: 0, status: "queued" }),
      record({ size: 0, sizeleft: 0, status: "queued" }),
    ]);
    expect(aggregate.progress).toBe(0);
  });
});

describe("activity item mapping", () => {
  it("maps a series and its poster", () => {
    const series: ServarrSeriesResource = {
      id: 42,
      title: "Example Show",
      year: 2024,
      overview: "A show",
      network: "Example TV",
      tvdbId: 1234,
      imdbId: "tt1234",
      runtime: 45,
      ratings: { value: 8.2 },
      images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg" }],
    };

    const item = buildSeriesActivityItem(
      42,
      [record({ seasonNumber: 1 }), record({ id: 2, seasonNumber: 2, sizeleft: 0 })],
      series,
    );

    expect(item).toMatchObject({
      key: "series:1234",
      service: "sonarr",
      kind: "series",
      title: "Example Show",
      year: 2024,
      tvdbId: 1234,
      seriesId: 42,
      queueCount: 2,
      seasons: [1, 2],
      progress: 80,
      imageUrl: "/api/search/images/sonarr?path=%2FMediaCoverProxy%2Fabc%2Fposter.jpg",
    });
  });

  it("maps a movie and keeps the provider-id key", () => {
    const movie: ServarrMovieResource = {
      id: 7,
      title: "Example Movie",
      year: 2022,
      tmdbId: 9876,
      imdbId: "tt9876",
      studio: "Example Studio",
      runtime: 110,
      images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg" }],
    };

    const item = buildMovieActivityItem(7, [record()], movie);

    expect(item).toMatchObject({
      key: "movie:9876",
      service: "radarr",
      kind: "movie",
      title: "Example Movie",
      movieId: 7,
      imageUrl: "/api/search/images/radarr?path=%2FMediaCoverProxy%2Fdef%2Fposter.jpg",
    });
  });
});
