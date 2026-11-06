import { describe, expect, it } from "vitest";

import type { ShowEpisode } from "@/api/types";
import { playLabel, resumeTarget } from "@/features/show/episode-watch-state";

function episode(overrides: Partial<ShowEpisode> = {}): ShowEpisode {
  return {
    key: "s01e01",
    seasonNumber: 1,
    episodeNumber: 1,
    title: "Pilot",
    availability: "jellyfin",
    jellyfinId: "episode-1",
    ...overrides,
  };
}

function watched(season: number, number: number, lastPlayedDate?: string): ShowEpisode {
  return episode({
    key: `s0${season}e0${number}`,
    seasonNumber: season,
    episodeNumber: number,
    jellyfinId: `episode-${season}-${number}`,
    played: true,
    lastPlayedDate,
  });
}

function inProgress(
  season: number,
  number: number,
  progressPercent: number,
  lastPlayedDate?: string,
): ShowEpisode {
  return episode({
    key: `s0${season}e0${number}`,
    seasonNumber: season,
    episodeNumber: number,
    jellyfinId: `episode-${season}-${number}`,
    progressPercent,
    lastPlayedDate,
  });
}

describe("resumeTarget", () => {
  it("resumes the most recently played episode that is still in progress", () => {
    const target = resumeTarget([
      inProgress(1, 6, 12.6, "2026-11-01T20:00:00Z"),
      inProgress(2, 3, 45, "2026-11-05T02:38:38Z"),
      watched(1, 1),
    ]);

    expect(target?.key).toBe("s02e03");
  });

  it("falls back to the first unwatched episode", () => {
    const target = resumeTarget([
      watched(1, 1),
      watched(1, 2),
      episode({ key: "s01e03", episodeNumber: 3 }),
      episode({ key: "s01e04", episodeNumber: 4 }),
    ]);

    expect(target?.key).toBe("s01e03");
  });

  it("starts the show over when everything is watched", () => {
    const target = resumeTarget([watched(1, 2), watched(1, 1)]);

    expect(target?.key).toBe("s01e01");
  });

  it("ignores specials and episodes Jellyfin does not have", () => {
    const target = resumeTarget([
      episode({ key: "s00e01", seasonNumber: 0, episodeNumber: 1 }),
      episode({ key: "s01e01", availability: "missing", jellyfinId: undefined }),
      episode({ key: "s01e02", episodeNumber: 2 }),
    ]);

    expect(target?.key).toBe("s01e02");
  });

  it("has nothing to resume without a playable episode", () => {
    expect(resumeTarget([])).toBeUndefined();
    expect(
      resumeTarget([episode({ availability: "missing", jellyfinId: undefined })]),
    ).toBeUndefined();
  });
});

describe("playLabel", () => {
  it("adds the watch state to the accessible name", () => {
    expect(playLabel(episode({ title: "Rock Show", episodeNumber: 6 }))).toBe(
      "Play episode 6: Rock Show",
    );
    expect(
      playLabel(episode({ title: "Rock Show", episodeNumber: 6, played: true })),
    ).toBe("Play episode 6: Rock Show, watched");
    expect(
      playLabel(episode({ title: "Rock Show", episodeNumber: 6, progressPercent: 12.6 })),
    ).toBe("Play episode 6: Rock Show, 13% watched");
  });
});
