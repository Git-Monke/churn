import { describe, expect, it } from "vitest";

import { buildShowDetail } from "../src/shows.js";
import type { JellyfinItem } from "../src/upstream/jellyfin.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";
import type { ServarrEpisode } from "../src/upstream/servarr.js";
import type { ShowSeriesSummary } from "../src/types.js";

const series: ShowSeriesSummary = {
  title: "Example Show",
  year: 2024,
  tvdbId: 1234,
  imageUrl: "/api/search/images/sonarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc-poster.jpg",
};

function jellyfinEpisode(
  id: string,
  season: number,
  episode: number,
  overrides: Partial<JellyfinItem> = {},
): JellyfinItem {
  return {
    Id: id,
    Name: `Jellyfin ${season}x${episode}`,
    ParentIndexNumber: season,
    IndexNumber: episode,
    ...overrides,
  };
}

function sonarrEpisode(
  id: number,
  season: number,
  episode: number,
  overrides: Partial<ServarrEpisode> = {},
): ServarrEpisode {
  return {
    id,
    seriesId: 42,
    seasonNumber: season,
    episodeNumber: episode,
    title: `Sonarr ${season}x${episode}`,
    airDateUtc: "2020-01-01T00:00:00Z",
    hasFile: false,
    monitored: true,
    ...overrides,
  };
}

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "abc123",
    name: "Example.Show.S01E02.1080p",
    progress: 0.5,
    size: 1_000,
    amount_left: 500,
    state: "downloading",
    ...overrides,
  };
}

describe("buildShowDetail", () => {
  it("unions Jellyfin and Sonarr episodes and takes downloads from qBittorrent", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinSeasons: [{ Id: "season-1", Name: "Season One", IndexNumber: 1 }],
      jellyfinEpisodes: [jellyfinEpisode("j1", 1, 1, { ImageTags: { Primary: "tag" } })],
      sonarrEpisodes: [
        sonarrEpisode(1, 1, 1, { hasFile: true }),
        sonarrEpisode(2, 1, 2),
        sonarrEpisode(3, 3, 1, { airDateUtc: "2999-01-01T00:00:00Z" }),
      ],
      qbittorrentTorrents: [torrent()],
    });

    expect(detail.episodes.map((episode) => episode.key)).toEqual([
      "s01e01",
      "s01e02",
      "s03e01",
    ]);
    expect(detail.episodes[0]).toMatchObject({
      title: "Jellyfin 1x1",
      availability: "jellyfin",
      jellyfinId: "j1",
      imageUrl: "/api/library/images/j1?tag=tag",
    });
    expect(detail.episodes[0]?.download).toBeUndefined();
    expect(detail.episodes[1]).toMatchObject({
      availability: "missing",
      download: { status: "downloading", progress: 50 },
    });
    expect(detail.episodes[1]?.jellyfinId).toBeUndefined();
    expect(detail.episodes[2]).toMatchObject({
      availability: "upcoming",
    });
    expect(detail.episodes[2]?.download).toBeUndefined();
    expect(detail.seasons).toEqual([
      {
        seasonNumber: 1,
        name: "Season One",
        episodeCount: 2,
        availableCount: 1,
        downloadingCount: 1,
      },
      {
        seasonNumber: 3,
        name: "Season 3",
        episodeCount: 1,
        availableCount: 0,
        downloadingCount: 0,
      },
    ]);
    expect(detail.defaultSeason).toBe(1);
  });

  it("marks every episode in a season pack", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 2, 1), sonarrEpisode(2, 2, 2)],
      qbittorrentTorrents: [torrent({ name: "Example.Show.S02.1080p" })],
    });

    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodes.every((episode) => episode.download !== undefined)).toBe(true);
    expect(detail.seasons[0]).toMatchObject({ seasonNumber: 2, downloadingCount: 2 });
  });

  it("marks Sonarr files without Jellyfin as non-playable imports", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 1, 1, { hasFile: true })],
      qbittorrentTorrents: [
        torrent({ name: "Example.Show.S01E01.1080p", progress: 1, state: "uploading" }),
      ],
    });
    expect(detail.episodes[0]).toMatchObject({
      availability: "missing",
      imported: true,
    });
    expect(detail.episodes[0]?.jellyfinId).toBeUndefined();
    // Sonarr already imported it, so the finished qBittorrent row is stale.
    expect(detail.episodes[0]?.download).toBeUndefined();
  });

  it("applies a multi-season pack to every covered season", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [
        sonarrEpisode(1, 1, 1),
        sonarrEpisode(2, 1, 2),
        sonarrEpisode(3, 2, 1),
        sonarrEpisode(4, 3, 1),
        sonarrEpisode(5, 4, 1),
      ],
      qbittorrentTorrents: [torrent({ name: "Example.Show.S01-03.1080p" })],
    });

    expect(detail.episodes.filter((episode) => episode.download)).toHaveLength(4);
    expect(detail.episodes[4]?.download).toBeUndefined();
    expect(detail.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, downloadingCount: 2 }),
      expect.objectContaining({ seasonNumber: 2, downloadingCount: 1 }),
      expect.objectContaining({ seasonNumber: 3, downloadingCount: 1 }),
      expect.objectContaining({ seasonNumber: 4, downloadingCount: 0 }),
    ]);
  });

  it("prefers the first Jellyfin season, then the first downloading season", () => {
    const withJellyfin = buildShowDetail({
      source: "sonarr",
      series,
      jellyfinEpisodes: [jellyfinEpisode("j2", 2, 1)],
      sonarrEpisodes: [sonarrEpisode(1, 1, 1)],
      qbittorrentTorrents: [torrent({ name: "Example.Show.S01E01.1080p" })],
    });
    expect(withJellyfin.defaultSeason).toBe(2);

    const downloadOnly = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 1, 1), sonarrEpisode(2, 2, 1)],
      qbittorrentTorrents: [torrent({ name: "Example.Show.S02E01.1080p" })],
    });
    expect(downloadOnly.defaultSeason).toBe(2);
  });

  it("hides a finished download once Jellyfin has indexed the episode", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [jellyfinEpisode("j1", 1, 1), jellyfinEpisode("j2", 1, 2)],
      sonarrEpisodes: [sonarrEpisode(1, 1, 1), sonarrEpisode(2, 1, 2)],
      qbittorrentTorrents: [
        torrent({
          name: "Example.Show.S01.1080p",
          progress: 1,
          state: "uploading",
          tags: "churn-direct",
        }),
      ],
    });

    expect(detail.episodes.map((episode) => episode.availability)).toEqual([
      "jellyfin",
      "jellyfin",
    ]);
    expect(detail.episodes.every((episode) => episode.download === undefined)).toBe(true);
    expect(detail.seasons[0]?.downloadingCount).toBe(0);
  });

  it("shows a qBittorrent upgrade beside a playable episode", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [jellyfinEpisode("j1", 1, 1)],
      sonarrEpisodes: [sonarrEpisode(1, 1, 1, { hasFile: true })],
      qbittorrentTorrents: [torrent({ name: "Example.Show.S01E01.2160p" })],
    });

    expect(detail.episodes[0]).toMatchObject({
      availability: "jellyfin",
      download: { status: "downloading", progress: 50, quality: "2160p" },
    });
  });

  it("takes the watched flag straight from Jellyfin's user data", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [
        jellyfinEpisode("j1", 1, 1, {
          RunTimeTicks: 12_955_442_500,
          UserData: {
            Played: true,
            PlayCount: 7,
            PlaybackPositionTicks: 0,
            LastPlayedDate: "2026-11-05T19:34:30.4345474Z",
          },
        }),
      ],
    });

    expect(detail.episodes[0]).toMatchObject({
      played: true,
      lastPlayedDate: "2026-11-05T19:34:30.4345474Z",
    });
    // A finished episode never also carries a progress bar.
    expect(detail.episodes[0]?.progressPercent).toBeUndefined();
  });

  it("uses Jellyfin's played percentage for a started episode", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [
        jellyfinEpisode("j1", 1, 6, {
          RunTimeTicks: 16_096_080_000,
          UserData: {
            Played: false,
            PlaybackPositionTicks: 2_031_460_790,
            PlayedPercentage: 12.62,
          },
        }),
      ],
    });

    expect(detail.episodes[0]).toMatchObject({ progressPercent: 12.6 });
    expect(detail.episodes[0]?.played).toBeUndefined();
  });

  it("derives the percentage from the position when Jellyfin omits it", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [
        jellyfinEpisode("j1", 1, 1, {
          RunTimeTicks: 10_000_000_000,
          UserData: { Played: false, PlaybackPositionTicks: 5_000_000_000 },
        }),
        // Clamped: a nearly finished episode still shows as in progress.
        jellyfinEpisode("j2", 1, 2, {
          RunTimeTicks: 10_000_000_000,
          UserData: { Played: false, PlaybackPositionTicks: 9_999_000_000 },
        }),
      ],
    });

    expect(detail.episodes.map((episode) => episode.progressPercent)).toEqual([50, 99]);
  });

  it("leaves an unstarted episode and a Sonarr-only episode unmarked", () => {
    const detail = buildShowDetail({
      source: "jellyfin",
      series,
      jellyfinEpisodes: [
        jellyfinEpisode("j1", 1, 1, {
          RunTimeTicks: 12_955_442_500,
          // Rewatch in progress but not started: no bar, no badge.
          UserData: {
            Played: false,
            PlayCount: 3,
            PlaybackPositionTicks: 0,
            LastPlayedDate: "2026-11-05T19:34:47.2137406Z",
          },
        }),
      ],
      sonarrEpisodes: [sonarrEpisode(1, 1, 2, { hasFile: true })],
    });

    expect(detail.episodes[0]).toMatchObject({
      lastPlayedDate: "2026-11-05T19:34:47.2137406Z",
    });
    expect(detail.episodes[0]?.played).toBeUndefined();
    expect(detail.episodes[0]?.progressPercent).toBeUndefined();
    expect(detail.episodes[1]?.played).toBeUndefined();
    expect(detail.episodes[1]?.progressPercent).toBeUndefined();
    expect(detail.episodes[1]?.lastPlayedDate).toBeUndefined();
  });
});
