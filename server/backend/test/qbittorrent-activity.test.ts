import { describe, expect, it } from "vitest";

import {
  buildQbittorrentActivity,
  isActiveTorrent,
  movieTitleMatches,
} from "../src/qbittorrent-activity.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "abc123",
    name: "Example.Show.S01.1080p",
    category: "tv",
    progress: 0.4,
    size: 1_000,
    amount_left: 600,
    dlspeed: 100,
    eta: 65,
    state: "downloading",
    num_seeds: 5,
    num_complete: 100,
    ...overrides,
  };
}

const catalog = {
  series: [
    { id: 42, title: "Example Show", tvdbId: 1234 },
    { id: 43, title: "Example Show Extra", tvdbId: 1235 },
  ],
  movies: [
    { id: 7, title: "Example Movie", year: 2022, tmdbId: 5678 },
    { id: 8, title: "Dune", year: 2021, tmdbId: 999 },
    { id: 9, title: "Dune Part Two", year: 2024, tmdbId: 1000 },
  ],
};

describe("qBittorrent activity", () => {
  it("groups active torrents by the matching local series", () => {
    const items = buildQbittorrentActivity(
      [
        torrent(),
        torrent({
          hash: "def456",
          name: "Example.Show.S01E02.1080p",
          size: 2_000,
          amount_left: 1_000,
          dlspeed: 200,
          eta: 30,
          num_seeds: 3,
          num_complete: 40,
        }),
      ],
      catalog,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "series:1234",
      service: "sonarr",
      seriesId: 42,
      title: "Example Show",
      kind: "series",
      queueCount: 2,
      status: "downloading",
      progress: 47,
      sizeBytes: 3_000,
      sizeLeftBytes: 1_600,
      downloadSpeedBytes: 300,
      connectedSeeders: 8,
      swarmSeeders: 140,
      timeLeft: "00:00:30",
      quality: "1080p",
      seasons: [1],
      downloadClients: ["qBittorrent"],
      protocols: ["torrent"],
    });
  });

  it("matches movies by title and year without prefix collisions", () => {
    expect(movieTitleMatches("Dune.2021.1080p", "Dune", 2021)).toBe(true);
    expect(movieTitleMatches("Dune.Part.Two.2024.1080p", "Dune", 2021)).toBe(false);
    expect(movieTitleMatches("Dune.Part.Two.2024.1080p", "Dune Part Two", 2024)).toBe(true);

    const items = buildQbittorrentActivity(
      [torrent({ name: "Example.Movie.2022.1080p.WEB-DL", category: "movies" })],
      catalog,
    );
    expect(items[0]).toMatchObject({
      key: "movie:5678",
      service: "radarr",
      movieId: 7,
      title: "Example Movie",
      kind: "movie",
    });
  });

  it("excludes completed and seeding torrents", () => {
    expect(isActiveTorrent(torrent({ progress: 1, state: "uploading" }))).toBe(false);
    expect(isActiveTorrent(torrent({ progress: 1, state: "stalledUP" }))).toBe(false);
    expect(isActiveTorrent(torrent({ progress: 0.5, state: "stalledDL" }))).toBe(true);

    const items = buildQbittorrentActivity(
      [torrent({ progress: 1, state: "stalledUP" })],
      catalog,
    );
    expect(items).toHaveLength(0);
  });

  it("omits unreported or negative seeder counts", () => {
    const items = buildQbittorrentActivity(
      [torrent({ num_seeds: -1, num_complete: -1 })],
      catalog,
    );

    expect(items[0]?.connectedSeeders).toBeUndefined();
    expect(items[0]?.swarmSeeders).toBeUndefined();
  });

  it("keeps a reported zero seeder count", () => {
    const items = buildQbittorrentActivity(
      [torrent({ num_seeds: 0, num_complete: 0 })],
      catalog,
    );

    expect(items[0]?.connectedSeeders).toBe(0);
    expect(items[0]?.swarmSeeders).toBe(0);
  });

  it("keeps unmatched downloads visible with a torrent key", () => {
    const items = buildQbittorrentActivity(
      [torrent({ hash: "ABC", name: "Unknown.Movie.2020.1080p", category: "movies" })],
      catalog,
    );

    expect(items[0]).toMatchObject({
      key: "torrent:abc",
      kind: "movie",
      title: "Unknown Movie 2020 1080p",
      year: 2020,
      queueCount: 1,
      status: "downloading",
    });
    expect(items[0]?.service).toBeUndefined();
  });

  it("reports queued and warning states from qBittorrent", () => {
    const queued = buildQbittorrentActivity(
      [torrent({ state: "queuedDL" })],
      catalog,
    );
    expect(queued[0]?.status).toBe("queued");

    const failed = buildQbittorrentActivity(
      [torrent({ state: "missingFiles" })],
      catalog,
    );
    expect(failed[0]?.status).toBe("warning");
    expect(failed[0]?.statusMessages).toEqual(["qBittorrent reports missingFiles."]);
  });
});
