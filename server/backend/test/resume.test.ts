import { describe, expect, it } from "vitest";

import {
  continueWatchingResponse,
  mapResumeItem,
  mapResumeItems,
  RESUME_ITEM_LIMIT,
} from "../src/resume.js";
import type { JellyfinItem } from "../src/upstream/jellyfin.js";

function episode(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: "episode-1",
    Name: "Rock Show",
    Type: "Episode",
    SeriesId: "series-1",
    SeriesName: "Parks and Recreation",
    ParentIndexNumber: 1,
    IndexNumber: 6,
    RunTimeTicks: 16_096_080_000,
    ImageTags: { Primary: "still-tag" },
    SeriesPrimaryImageTag: "series-poster-tag",
    UserData: {
      PlaybackPositionTicks: 2_007_299_910,
      PlayedPercentage: 12.47,
      Played: false,
      LastPlayedDate: "2026-11-05T02:38:38.8752016Z",
    },
    ...overrides,
  };
}

function movie(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: "movie-1",
    Name: "Deep Impact",
    Type: "Movie",
    RunTimeTicks: 72_000_000_000,
    ImageTags: { Primary: "poster-tag" },
    BackdropImageTags: ["backdrop-tag"],
    UserData: {
      PlaybackPositionTicks: 36_000_000_000,
      Played: false,
      LastPlayedDate: "2026-11-04T20:00:00.0000000Z",
    },
    ...overrides,
  };
}

describe("mapResumeItem", () => {
  it("turns an in-progress episode into a series card", () => {
    expect(mapResumeItem(episode())).toEqual({
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
      imageUrl:
        "/api/library/images/episode-1?tag=still-tag&maxWidth=680",
      lastPlayedDate: "2026-11-05T02:38:38.8752016Z",
    });
  });

  it("turns an in-progress movie into a movie card with its backdrop", () => {
    expect(mapResumeItem(movie())).toEqual({
      id: "movie-1",
      kind: "movie",
      title: "Deep Impact",
      runtimeTicks: 72_000_000_000,
      positionTicks: 36_000_000_000,
      playedPercentage: 50,
      imageUrl:
        "/api/library/images/movie-1?type=Backdrop&tag=backdrop-tag&maxWidth=680",
      lastPlayedDate: "2026-11-04T20:00:00.0000000Z",
    });
  });

  it("falls back to the poster when a movie has no backdrop", () => {
    const item = movie({ BackdropImageTags: [] });
    expect(mapResumeItem(item)?.imageUrl).toBe(
      "/api/library/images/movie-1?tag=poster-tag&maxWidth=680",
    );
  });

  it("falls back to the series poster when an episode has no still", () => {
    const item = episode({ ImageTags: {} });
    expect(mapResumeItem(item)?.imageUrl).toBe(
      "/api/library/images/series-1?tag=series-poster-tag&maxWidth=680",
    );
  });

  it("leaves imageUrl undefined when nothing is available", () => {
    const item = movie({ ImageTags: {}, BackdropImageTags: [] });
    expect(mapResumeItem(item)?.imageUrl).toBeUndefined();
  });

  it("computes the percentage when Jellyfin omits it", () => {
    const item = movie({ UserData: { PlaybackPositionTicks: 18_000_000_000 } });
    expect(mapResumeItem(item)?.playedPercentage).toBe(25);
  });

  it("drops finished, unstarted, and non-video items", () => {
    expect(mapResumeItem(episode({ UserData: { Played: true, PlaybackPositionTicks: 9 } }))).toBeNull();
    expect(mapResumeItem(episode({ UserData: {} }))).toBeNull();
    expect(mapResumeItem(episode({ Type: "Series" }))).toBeNull();
    expect(mapResumeItem(episode({ SeriesId: undefined }))).toBeNull();
    expect(mapResumeItem(episode({ Name: undefined }))).toBeNull();
  });
});

describe("mapResumeItems", () => {
  it("keeps one card per series, newest first", () => {
    const cards = mapResumeItems([
      episode({ Id: "recent", IndexNumber: 6 }),
      episode({ Id: "older", IndexNumber: 5 }),
      movie(),
    ]);

    expect(cards.map((card) => card.id)).toEqual(["recent", "movie-1"]);
  });

  it("keeps every movie, even with the same name", () => {
    const cards = mapResumeItems([
      movie({ Id: "movie-1" }),
      movie({ Id: "movie-2", Name: "The Seventh Seal" }),
    ]);

    expect(cards.map((card) => card.id)).toEqual(["movie-1", "movie-2"]);
  });

  it("caps the row", () => {
    const items = Array.from({ length: RESUME_ITEM_LIMIT + 5 }, (_, index) =>
      movie({ Id: `movie-${index}`, Name: `Movie ${index}` }),
    );

    expect(mapResumeItems(items)).toHaveLength(RESUME_ITEM_LIMIT);
    expect(mapResumeItems(items, 3).map((card) => card.id)).toEqual([
      "movie-0",
      "movie-1",
      "movie-2",
    ]);
  });
});

describe("continueWatchingResponse", () => {
  it("carries the state, items and optional detail", () => {
    expect(continueWatchingResponse("unreachable", [], "Jellyfin is unreachable")).toEqual({
      source: "jellyfin",
      state: "unreachable",
      items: [],
      detail: "Jellyfin is unreachable",
    });
    expect(continueWatchingResponse("ok")).toEqual({
      source: "jellyfin",
      state: "ok",
      items: [],
    });
  });
});
