import { describe, expect, it } from "vitest";

import { buildShowDetail } from "../src/shows.js";
import type { JellyfinItem } from "../src/upstream/jellyfin.js";
import type { ServarrEpisode, ServarrQueueRecord } from "../src/upstream/servarr.js";
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

function queueRecord(overrides: Partial<ServarrQueueRecord> = {}): ServarrQueueRecord {
  return {
    id: 1,
    status: "downloading",
    trackedDownloadState: "downloading",
    trackedDownloadStatus: "ok",
    size: 1000,
    sizeleft: 500,
    ...overrides,
  };
}

describe("buildShowDetail", () => {
  it("unions Jellyfin and Sonarr episodes and applies per-episode downloads", () => {
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
      queueRecords: [
        queueRecord({ episodeId: 2, seasonNumber: 1 }),
        queueRecord({ id: 2, status: "queued", episodeId: 2, size: 0, sizeleft: 0 }),
        queueRecord({ id: 3, status: "queued", seasonNumber: 3, size: 0, sizeleft: 0 }),
      ],
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
    expect(detail.episodes[1]).toMatchObject({
      availability: "missing",
      download: { status: "downloading", progress: 50 },
    });
    expect(detail.episodes[1]?.jellyfinId).toBeUndefined();
    expect(detail.episodes[2]).toMatchObject({
      availability: "upcoming",
      download: { status: "queued", progress: 0, seasonPack: true },
    });
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
        downloadingCount: 1,
      },
    ]);
    expect(detail.defaultSeason).toBe(1);
  });

  it("marks every episode in a season pack", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 2, 1), sonarrEpisode(2, 2, 2)],
      queueRecords: [queueRecord({ seasonNumber: 2 })],
    });

    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodes.every((episode) => episode.download?.seasonPack === true)).toBe(true);
    expect(detail.seasons[0]).toMatchObject({ seasonNumber: 2, downloadingCount: 2 });
  });

  it("treats Sonarr files as available outside Jellyfin", () => {
    const detail = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 1, 1, { hasFile: true })],
    });
    expect(detail.episodes[0]?.availability).toBe("sonarr");
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
      queueRecords: [
        queueRecord({
          title: "Example.Show.S01-03",
          episodeId: 1,
          seasonNumber: 1,
        }),
        queueRecord({
          id: 2,
          title: "Example.Show.S01-03",
          episodeId: 2,
          seasonNumber: 1,
        }),
      ],
    });

    expect(detail.episodes.filter((episode) => episode.download)).toHaveLength(4);
    expect(detail.episodes[4]?.download).toBeUndefined();
    expect(detail.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, downloadingCount: 2 }),
      expect.objectContaining({ seasonNumber: 2, downloadingCount: 1 }),
      expect.objectContaining({ seasonNumber: 3, downloadingCount: 1 }),
      expect.objectContaining({ seasonNumber: 4, downloadingCount: 0 }),
    ]);
    expect(
      detail.episodes
        .filter((episode) => episode.download)
        .every((episode) => episode.download?.seasonPack === true),
    ).toBe(true);
  });

  it("prefers the first Jellyfin season, then the first downloading season", () => {
    const withJellyfin = buildShowDetail({
      source: "sonarr",
      series,
      jellyfinEpisodes: [jellyfinEpisode("j2", 2, 1)],
      sonarrEpisodes: [sonarrEpisode(1, 1, 1)],
      queueRecords: [queueRecord({ episodeId: 1, seasonNumber: 1 })],
    });
    expect(withJellyfin.defaultSeason).toBe(2);

    const downloadOnly = buildShowDetail({
      source: "sonarr",
      series,
      sonarrEpisodes: [sonarrEpisode(1, 1, 1), sonarrEpisode(2, 2, 1)],
      queueRecords: [queueRecord({ episodeId: 2, seasonNumber: 2 })],
    });
    expect(downloadOnly.defaultSeason).toBe(2);
  });
});
