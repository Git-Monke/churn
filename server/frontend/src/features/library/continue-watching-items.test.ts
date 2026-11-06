import { describe, expect, it } from "vitest";

import type { ContinueWatchingItem } from "@/api/types";
import {
  cardHref,
  remainingMinutes,
  resumeLabel,
  toContinueWatchingCards,
} from "@/features/library/continue-watching-items";

function episode(overrides: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem {
  return {
    id: "episode-1",
    kind: "episode",
    title: "Parks and Recreation",
    episodeTitle: "Rock Show",
    seriesId: "series-1",
    seasonNumber: 1,
    episodeNumber: 6,
    runtimeTicks: 16_096_080_000,
    positionTicks: 2_007_299_910,
    playedPercentage: 12.5,
    imageUrl: "/api/library/images/episode-1?tag=still",
    ...overrides,
  };
}

function movie(overrides: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem {
  return {
    id: "movie-1",
    kind: "movie",
    title: "Example Movie",
    runtimeTicks: 72_000_000_000,
    positionTicks: 36_000_000_000,
    playedPercentage: 50,
    ...overrides,
  };
}

describe("continue watching labels", () => {
  it("reads season, episode and the remaining minutes", () => {
    // 26.8 min runtime, 200 s watched: 24 minutes are left.
    expect(resumeLabel(episode())).toBe("S1 · E6 · 24 min left");
    expect(resumeLabel(movie())).toBe("60 min left");
  });

  it("drops the season/episode part when Jellyfin has no numbers", () => {
    expect(
      resumeLabel(episode({ seasonNumber: undefined, episodeNumber: undefined })),
    ).toBe("24 min left");
  });

  it("has a label even without a runtime", () => {
    expect(resumeLabel(episode({ runtimeTicks: undefined }))).toBe("S1 · E6");
    expect(resumeLabel(movie({ runtimeTicks: undefined }))).toBe("In progress");
  });

  it("rounds up and never reports zero minutes", () => {
    expect(remainingMinutes(episode())).toBe(24);
    expect(remainingMinutes(movie({ positionTicks: 71_999_000_000 }))).toBe(1);
    expect(remainingMinutes(movie({ runtimeTicks: undefined }))).toBeUndefined();
    expect(remainingMinutes(movie({ positionTicks: 72_000_000_000 }))).toBeUndefined();
  });
});

describe("continue watching links", () => {
  it("keeps the show and season on episode links", () => {
    expect(cardHref(episode())).toBe(
      "#/play/episode-1?source=jellyfin&show=series-1&season=1",
    );
  });

  it("plays an episode without a series id on its own", () => {
    expect(cardHref(episode({ seriesId: undefined }))).toBe("#/play/episode-1");
  });

  it("plays a movie on its own", () => {
    expect(cardHref(movie())).toBe("#/play/movie-1");
  });
});

describe("continue watching cards", () => {
  it("maps resume items to cards", () => {
    expect(toContinueWatchingCards([episode(), movie()])).toEqual([
      {
        id: "episode-1",
        title: "Parks and Recreation",
        resumeLabel: "S1 · E6 · 24 min left",
        progress: 12.5,
        imageUrl: "/api/library/images/episode-1?tag=still",
        href: "#/play/episode-1?source=jellyfin&show=series-1&season=1",
      },
      {
        id: "movie-1",
        title: "Example Movie",
        resumeLabel: "60 min left",
        progress: 50,
        imageUrl: undefined,
        href: "#/play/movie-1",
      },
    ]);
  });

  it("falls back to the episode title when the series name is gone", () => {
    expect(toContinueWatchingCards([episode({ title: "" })])[0]?.title).toBe(
      "Rock Show",
    );
  });
});
