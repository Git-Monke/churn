import { describe, expect, it } from "vitest";

import { mapShowTorrentDownloads } from "../src/qbittorrent-show.js";
import { buildShowDetail } from "../src/shows.js";
import type { ShowSeriesSummary } from "../src/types.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";
import type { ServarrEpisode } from "../src/upstream/servarr.js";

const series: ShowSeriesSummary = {
  title: "Parks and Recreation",
  year: 2009,
};

function episode(id: number, season: number, episodeNumber: number): ServarrEpisode {
  return {
    id,
    seasonNumber: season,
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    hasFile: false,
  };
}

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
    name: "Parks.and.Recreation.S01.1080p.BluRay.x265-KONTRAST",
    progress: 0.42,
    state: "downloading",
    size: 10_000,
    amount_left: 5_800,
    dlspeed: 1_200_000,
    num_seeds: 12,
    num_complete: 48,
    ...overrides,
  };
}

describe("qBittorrent fallback for show downloads", () => {
  it("maps a season pack to every episode in that season", () => {
    const result = new Map(
      [
        ["s01e01", 1, 1],
        ["s01e02", 1, 2],
        ["s02e01", 2, 1],
      ].map(([key, season, episode]) => [
        String(key),
        { seasonNumber: Number(season), episodeNumber: Number(episode) },
      ]),
    );
    const episodes = [...result].map(([key, value]) => ({ key, ...value }));

    const downloads = mapShowTorrentDownloads([torrent()], "Parks and Recreation", episodes);

    expect([...downloads.keys()]).toEqual(["s01e01", "s01e02"]);
    expect(downloads.get("s01e01")).toMatchObject({
      status: "downloading",
      progress: 42,
      quality: "1080p",
      protocol: "torrent",
      downloadClient: "qBittorrent",
      untracked: true,
      sizeBytes: 10_000,
      sizeLeftBytes: 5_800,
      downloadSpeedBytes: 1_200_000,
      connectedSeeders: 12,
      swarmSeeders: 48,
    });
  });

  it("derives remaining bytes from progress when amount_left is absent", () => {
    const episodes = [{ key: "s01e01", seasonNumber: 1, episodeNumber: 1 }];
    const downloads = mapShowTorrentDownloads(
      [torrent({ amount_left: undefined, progress: 0.25 })],
      "Parks and Recreation",
      episodes,
    );

    expect(downloads.get("s01e01")).toMatchObject({
      sizeBytes: 10_000,
      sizeLeftBytes: 7_500,
    });
  });

  it("maps a single episode torrent to only that episode", () => {
    const episodes = [
      { key: "s01e01", seasonNumber: 1, episodeNumber: 1 },
      { key: "s01e02", seasonNumber: 1, episodeNumber: 2 },
    ];

    const downloads = mapShowTorrentDownloads(
      [torrent({ name: "Parks.and.Recreation.S01E02.1080p.WEB-DL" })],
      "Parks and Recreation",
      episodes,
    );

    expect([...downloads.keys()]).toEqual(["s01e02"]);
  });

  it("does not attach another show's torrent", () => {
    const episodes = [{ key: "s01e01", seasonNumber: 1, episodeNumber: 1 }];
    const downloads = mapShowTorrentDownloads(
      [torrent({ name: "The.Office.US.S01.1080p.BluRay" })],
      "Parks and Recreation",
      episodes,
    );

    expect(downloads.size).toBe(0);
  });

  it("marks a finished torrent as importing until Sonarr imports it", () => {
    const episodes = [{ key: "s01e01", seasonNumber: 1, episodeNumber: 1 }];
    const downloads = mapShowTorrentDownloads(
      [torrent({ progress: 1, state: "uploading" })],
      "Parks and Recreation",
      episodes,
    );

    expect(downloads.get("s01e01")).toMatchObject({
      status: "importing",
      progress: 100,
      untracked: true,
      statusMessages: [expect.stringContaining("Sonarr has not imported it yet")],
    });
  });

  it("marks a finished direct download as waiting for Jellyfin", () => {
    const episodes = [{ key: "s01e01", seasonNumber: 1, episodeNumber: 1 }];
    const downloads = mapShowTorrentDownloads(
      [torrent({ progress: 1, state: "uploading", tags: "churn-direct" })],
      "Parks and Recreation",
      episodes,
    );

    expect(downloads.get("s01e01")).toMatchObject({
      status: "importing",
      progress: 100,
      untracked: true,
      statusMessages: [expect.stringContaining("Jellyfin has not indexed")],
    });
  });

  it("adds an untracked qBittorrent download through buildShowDetail", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [episode(1, 1, 1), episode(2, 1, 2)],
      qbittorrentTorrents: [torrent()],
    });

    expect(detail.episodes.map((item) => item.download)).toEqual([
      expect.objectContaining({ untracked: true, progress: 42, status: "downloading" }),
      expect.objectContaining({ untracked: true, progress: 42, status: "downloading" }),
    ]);
    expect(detail.seasons[0]?.downloadingCount).toBe(2);
  });
  it("warns when a claimed download has no torrent metadata after five seconds", () => {
    const episodes = [{ key: "s01e01", seasonNumber: 1, episodeNumber: 1 }];
    const downloads = mapShowTorrentDownloads(
      [
        torrent({
          name: "Parks.and.Recreation.S01E01.1080p.WEB-DL",
          state: "metaDL",
          has_metadata: false,
          progress: 0,
          size: 0,
          added_on: 90,
        }),
      ],
      "Parks and Recreation",
      episodes,
      { now: () => 100_000 },
    );

    expect(downloads.get("s01e01")).toMatchObject({
      status: "warning",
      statusMessages: [expect.stringContaining("has not received torrent metadata")],
    });
  });

});
