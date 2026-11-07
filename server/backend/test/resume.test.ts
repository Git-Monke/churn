import { describe, expect, it } from "vitest";

import {
  buildContinueWatching,
  continueWatchingResponse,
  mapNextUpItem,
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

function nextUp(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return episode({
    UserData: {
      PlaybackPositionTicks: 0,
      Played: false,
      LastPlayedDate: "2026-11-05T19:33:21.0518683Z",
    },
    ...overrides,
  });
}

function played(seriesId: string, lastPlayedDate: string | undefined, id = `${seriesId}-episode`): JellyfinItem {
  return episode({
    Id: id,
    SeriesId: seriesId,
    UserData: { Played: true, PlaybackPositionTicks: 0, LastPlayedDate: lastPlayedDate },
  });
}

describe("mapNextUpItem", () => {
  it("turns an unstarted next episode into an up-next card", () => {
    expect(mapNextUpItem(nextUp())).toEqual({
      id: "episode-1",
      kind: "episode",
      title: "Parks and Recreation",
      episodeTitle: "Rock Show",
      seriesId: "series-1",
      seasonNumber: 1,
      episodeNumber: 6,
      runtimeTicks: 16_096_080_000,
      positionTicks: 0,
      playedPercentage: 0,
      upNext: true,
      imageUrl: "/api/library/images/episode-1?tag=still-tag&maxWidth=680",
      lastPlayedDate: "2026-11-05T19:33:21.0518683Z",
    });
  });

  it("falls back to the series poster when the episode has no still", () => {
    expect(mapNextUpItem(nextUp({ ImageTags: {} }))?.imageUrl).toBe(
      "/api/library/images/series-1?tag=series-poster-tag&maxWidth=680",
    );
  });

  it("drops finished episodes, saved positions and non-episodes", () => {
    expect(mapNextUpItem(nextUp({ UserData: { Played: true, PlaybackPositionTicks: 0 } }))).toBeNull();
    // A saved position belongs to the resume list, which owns the series.
    expect(mapNextUpItem(nextUp({ UserData: { PlaybackPositionTicks: 1_000 } }))).toBeNull();
    expect(mapNextUpItem(nextUp({ Type: "Movie", SeriesId: undefined }))).toBeNull();
    expect(mapNextUpItem(nextUp({ SeriesName: undefined }))).toBeNull();
    expect(mapNextUpItem(nextUp({ Name: undefined }))).toBeNull();
  });
});

describe("buildContinueWatching", () => {
  it("adds the episode after the last completed one", () => {
    const cards = buildContinueWatching({
      resume: [movie()],
      nextUp: [nextUp()],
      played: [played("series-1", "2026-11-05T20:00:00.000Z")],
    });

    expect(cards.map((card) => ({ id: card.id, upNext: card.upNext }))).toEqual([
      { id: "episode-1", upNext: true },
      { id: "movie-1", upNext: undefined },
    ]);
  });

  it("offers the in-progress episode instead of the next one", () => {
    const cards = buildContinueWatching({
      resume: [episode({ UserData: { PlaybackPositionTicks: 500, Played: false } })],
      nextUp: [nextUp()],
      played: [played("series-1", "2026-11-05T20:00:00.000Z")],
    });

    const [card] = cards;
    expect(card?.id).toBe("episode-1");
    expect(card?.positionTicks).toBe(500);
    expect(card?.upNext).toBeUndefined();
  });

  it("drops next-up episodes for series without a completed episode", () => {
    const cards = buildContinueWatching({
      // Jellyfin returns the first episode of a series with no watch state; the
      // completed-episode gate keeps it out of the row.
      resume: [],
      nextUp: [nextUp({ Id: "untouched", SeriesId: "series-2" })],
      played: [played("series-1", "2026-11-05T20:00:00.000Z")],
    });

    expect(cards).toEqual([]);
  });

  it("keeps one next-up card per series", () => {
    const cards = buildContinueWatching({
      resume: [],
      nextUp: [nextUp({ Id: "first" }), nextUp({ Id: "second" })],
      played: [played("series-1", "2026-11-05T20:00:00.000Z")],
    });

    expect(cards.map((card) => card.id)).toEqual(["first"]);
  });

  it("falls back to the completion date when a next-up item has none", () => {
    const cards = buildContinueWatching({
      resume: [movie()],
      nextUp: [nextUp({ UserData: {} })],
      played: [played("series-1", "2026-11-05T20:00:00.000Z")],
    });

    expect(cards.map((card) => card.id)).toEqual(["episode-1", "movie-1"]);
  });

  it("caps the merged row", () => {
    const manyMovies = Array.from({ length: RESUME_ITEM_LIMIT }, (_, index) =>
      movie({ Id: `movie-${index}`, Name: `Movie ${index}` }),
    );
    const cards = buildContinueWatching(
      {
        resume: manyMovies,
        nextUp: [nextUp()],
        played: [played("series-1", "2026-11-05T20:00:00.000Z")],
      },
      3,
    );

    expect(cards.map((card) => card.id)).toEqual(["episode-1", "movie-0", "movie-1"]);
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
