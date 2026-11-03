import { describe, expect, it } from "vitest";

import {
  findRelease,
  releaseId,
  releaseMatchesEpisode,
  releaseMatchesSeason,
  releaseSeasonNumbers,
  groupShowReleases,
  toReleaseGroups,
  toShowReleases,
} from "../src/releases.js";
import type { ServarrRelease } from "../src/upstream/servarr.js";

function release(overrides: Partial<ServarrRelease> = {}): ServarrRelease {
  return {
    guid: "magnet:?xt=urn:btih:abc",
    indexerId: 1,
    indexer: "Indexer",
    title: "Example.Show.S01.720p",
    size: 1_000_000_000,
    quality: { quality: { id: 4, name: "HDTV-720p" } },
    seasonNumber: 1,
    approved: false,
    rejected: true,
    downloadAllowed: false,
    rejections: ["Quality Unknown is not wanted in profile"],
    mappedEpisodeInfo: [{ id: 10, seasonNumber: 1, episodeNumber: 1 }],
    languages: [{ id: 1, name: "English" }],
    protocol: "torrent",
    ...overrides,
  };
}

describe("show releases", () => {
  it("prefers automatic releases, then grab-able overrides by size", () => {
    const automatic = release({
      guid: "automatic",
      indexerId: 2,
      title: "Example.Show.S01E01.1080p",
      size: 2_000_000_000,
      approved: true,
      rejected: false,
      downloadAllowed: true,
      rejections: [],
      mappedEpisodeInfo: [],
    });
    const largePack = release({
      guid: "large",
      title: "Example.Show.S01-03",
      size: 20_000_000_000,
      rejections: ["Multi-season releases are not supported"],
    });
    const smallPack = release({
      guid: "small",
      title: "Example.Show.S01-02",
      size: 8_000_000_000,
      rejections: ["Multi-season releases are not supported"],
    });
    const unmappable = release({
      guid: "unmappable",
      indexerId: 3,
      title: "Example.Show.S01-S05",
      size: 40_000_000_000,
      mappedEpisodeInfo: [],
    });

    const result = toShowReleases([unmappable, largePack, smallPack, automatic]);

    expect(result.map((item) => item.title)).toEqual([
      "Example.Show.S01E01.1080p",
      "Example.Show.S01-02",
      "Example.Show.S01-03",
      "Example.Show.S01-S05",
    ]);
    expect(result[0]).toMatchObject({ approved: true, canGrab: true, recommended: true });
    expect(result[1]).toMatchObject({
      multiSeason: true,
      seasonLabel: "Seasons 1\u20132",
      canGrab: true,
      recommended: false,
    });
    expect(result[3]).toMatchObject({ canGrab: false, recommended: false });
  });

  it("recommends the smallest mapped pack when no release is automatic", () => {
    const result = toShowReleases([
      release({ guid: "large", title: "Example.Show.S01-05", size: 20_000_000_000 }),
      release({ guid: "small", title: "Example.Show.S01-02", size: 8_000_000_000 }),
    ]);

    expect(result.map((item) => item.title)).toEqual([
      "Example.Show.S01-02",
      "Example.Show.S01-05",
    ]);
    expect(result[0]?.recommended).toBe(true);
  });

  it("recovers a multi-season range when Sonarr reports one season", () => {
    expect(
      releaseSeasonNumbers(
        release({ title: "Show.S01-03", seasonNumber: 1, seasonNumbers: [1] }),
      ),
    ).toEqual([1, 2, 3]);
    expect(
      releaseSeasonNumbers(release({ title: "Show.S04-S06", seasonNumber: 4 })),
    ).toEqual([4, 5, 6]);
  });

  it("keeps only releases that can satisfy the requested season", () => {
    expect(releaseMatchesSeason(release({ title: "Show.S01E01" }), 1)).toBe(true);
    expect(releaseMatchesSeason(release({ title: "Show.S01E01" }), 2)).toBe(false);
    expect(releaseMatchesSeason(release({ title: "Show.S01-03" }), 2)).toBe(true);
    expect(releaseMatchesSeason(release({ title: "Show.S01-S05", mappedEpisodeInfo: [] }), 5)).toBe(true);
    expect(
      releaseMatchesSeason(
        release({ title: "Show.S10E06", seasonNumber: 10, mappedEpisodeInfo: [] }),
        1,
      ),
    ).toBe(false);
  });

  it("labels and matches single-episode releases", () => {
    const episode = release({
      guid: "episode",
      title: "Example.Show.S07E01.1080p",
      seasonNumber: 7,
      episodeNumbers: [1],
      mappedEpisodeInfo: [{ id: 70, seasonNumber: 7, episodeNumber: 1 }],
    });
    const otherEpisode = release({
      guid: "other",
      title: "Example.Show.S07E02.1080p",
      seasonNumber: 7,
      episodeNumbers: [2],
      mappedEpisodeInfo: [{ id: 71, seasonNumber: 7, episodeNumber: 2 }],
    });

    expect(releaseMatchesEpisode(episode, 7, 1)).toBe(true);
    expect(releaseMatchesEpisode(otherEpisode, 7, 1)).toBe(false);
    expect(
      releaseMatchesEpisode(
        release({ title: "Show.S07", seasonNumber: 7, episodeNumbers: [], mappedEpisodeInfo: [] }),
        7,
        1,
      ),
    ).toBe(false);

    const mapped = toShowReleases([episode, otherEpisode]);
    expect(mapped[0]).toMatchObject({ episodeLabel: "S07E01", seasonLabel: "Season 7" });
    expect(mapped[1]).toMatchObject({ episodeLabel: "S07E02", seasonLabel: "Season 7" });
  });

  it("builds opaque ids and finds the original release", () => {
    const item = release();
    const id = releaseId(item);

    expect(id).toMatch(/^[a-f0-9]{24}$/);
    expect(id).not.toContain("magnet");
    expect(findRelease([item], id ?? "")).toBe(item);
    expect(findRelease([item], "0".repeat(24))).toBeUndefined();
    expect(releaseId({ guid: "", indexerId: 1 })).toBeNull();
  });
});


describe("cached release groups", () => {
  it("groups populated quality tiers and sorts by seeders", () => {
    const groups = toReleaseGroups([
      release({
        guid: "sd",
        title: "Example.Show.S01.480p",
        quality: { quality: { name: "SDTV" } },
        seeders: 10,
        size: 1_000,
      }),
      release({
        guid: "720-a",
        title: "Example.Show.S01.720p",
        quality: { quality: { name: "HDTV-720p" } },
        seeders: 2,
        size: 2_000,
      }),
      release({
        guid: "720-b",
        title: "Example.Show.S01.720p.PROPER",
        quality: { quality: { name: "WEBDL-720p" } },
        seeders: 80,
        size: 3_000,
      }),
      release({
        guid: "2160",
        title: "Example.Show.S01.2160p",
        quality: { quality: { name: "WEBDL-2160p" } },
        seeders: 4,
        size: 4_000,
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["480p", "720p", "2160p"]);
    expect(groups[1]?.releases.map((item) => item.title)).toEqual([
      "Example.Show.S01.720p.PROPER",
      "Example.Show.S01.720p",
    ]);
    expect(groups[1]?.maxSeeders).toBe(80);
    expect(groups[1]?.lowSeeders).toBe(false);
    expect(groups[2]?.lowSeeders).toBe(true);
  });

  it("shows a multi-season pack in every season group", () => {
    const pack = release({
      guid: "pack",
      title: "Example.Show.S01-05.1080p",
      seasonNumber: 1,
      seasonNumbers: [1],
      quality: { quality: { name: "WEBDL-1080p" } },
      seeders: 60,
    });
    const first = groupShowReleases(toShowReleases([pack]));
    expect(first).toHaveLength(1);
    expect(releaseSeasonNumbers(pack)).toEqual([1, 2, 3, 4, 5]);
  });
});


describe("movie release groups", () => {
  it("keeps overrideable quality rejections but hides unmatchable movies", () => {
    const qualityReject = release({
      guid: "quality",
      title: "Kung.Fu.Panda.3.2016.1080p.BluRay",
      quality: { quality: { name: "Bluray-1080p" } },
      approved: false,
      rejected: true,
      downloadAllowed: false,
      rejections: ["Quality Bluray-1080p is not wanted in profile"],
      mappedEpisodeInfo: undefined,
      seeders: 90,
    });
    const unknownMovie = release({
      guid: "unknown",
      title: "Kung.Fu.Panda.Secrets.of.the.Scroll.2016.1080p",
      quality: { quality: { name: "WEBDL-1080p" } },
      approved: false,
      rejected: true,
      downloadAllowed: false,
      rejections: ["Unknown Movie. Unable to match to correct movie using release title."],
      mappedEpisodeInfo: undefined,
      seeders: 200,
    });

    const groups = toReleaseGroups([qualityReject, unknownMovie], "movie");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("1080p");
    expect(groups[0]?.releases.map((item) => item.title)).toEqual([
      "Kung.Fu.Panda.3.2016.1080p.BluRay",
    ]);
  });
});
