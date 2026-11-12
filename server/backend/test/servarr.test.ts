import { afterEach, describe, expect, it, vi } from "vitest";

import { createArrClient } from "../src/upstream/servarr.js";
import {
  arrMonitorName,
  isAllowedArtworkUrl,
  mapMovieResource,
  mapSeriesResource,
  mediaCoverUrl,
  monitorSeasons,
  pickDefaultQualityProfile,
  pickDefaultRootFolder,
  rankSearchResults,
  titleMatchScore,
} from "../src/search.js";
import type { SearchResult } from "../src/types.js";

describe("search result mapping", () => {
  it("maps Sonarr series metadata and a backend poster URL", () => {
    const result = mapSeriesResource(
      {
        title: "Severance",
        year: 2022,
        overview: "A show.",
        certification: "TV-MA",
        runtime: 49,
        genres: ["Drama"],
        network: "Apple TV",
        tvdbId: 371980,
        tmdbId: 95396,
        imdbId: "tt11280740",
        ratings: { value: 8.6 },
        seasons: [
          { seasonNumber: 0, monitored: false },
          { seasonNumber: 1, monitored: true },
        ],
        images: [
          { coverType: "banner", url: "/MediaCoverProxy/hash/banner.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/hash-banner.jpg" },
          { coverType: "poster", url: "/MediaCoverProxy/hash/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/hash-poster.jpg" },
        ],
      },
      false,
    );

    expect(result).toMatchObject({
      key: "series:371980",
      kind: "series",
      service: "sonarr",
      title: "Severance",
      year: 2022,
      rating: 8.6,
      runtimeMinutes: 49,
      network: "Apple TV",
      tvdbId: 371980,
      tmdbId: 95396,
      inLibrary: false,
      imageUrl:
        "/api/search/images/sonarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fhash-poster.jpg",
    });
    expect(result?.seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
    ]);
  });

  it("maps Radarr movies and prefers the IMDb rating", () => {
    const result = mapMovieResource(
      {
        title: "Dune",
        year: 2021,
        tmdbId: 438631,
        imdbId: "tt1160419",
        studio: "Legendary Pictures",
        ratings: { imdb: { value: 8 }, tmdb: { value: 7.8 } },
        hasFile: true,
        images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.jpg" }],
      },
      true,
    );

    expect(result).toMatchObject({
      key: "movie:438631",
      kind: "movie",
      service: "radarr",
      rating: 8,
      network: "Legendary Pictures",
      inLibrary: true,
    });
    expect(result?.available).toBeUndefined();
  });

  it("drops results without the id needed to request them", () => {
    expect(mapSeriesResource({ title: "No id" }, false)).toBeNull();
    expect(mapMovieResource({ title: "No id" }, false)).toBeNull();
    expect(mapSeriesResource({ tvdbId: 1 }, false)).toBeNull();
  });

  it("only maps allowlisted artwork URLs", () => {
    expect(
      mediaCoverUrl("radarr", [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.webp" }]),
    ).toBe("/api/search/images/radarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc-poster.webp");
    expect(
      mediaCoverUrl("radarr", [{ coverType: "poster", remoteUrl: "https://evil.test/poster.jpg" }]),
    ).toBeUndefined();
    // The UI-only MediaCoverProxy path is no longer used for posters.
    expect(
      mediaCoverUrl("radarr", [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg" }]),
    ).toBeUndefined();
    expect(isAllowedArtworkUrl("http://image.tmdb.org/t/p/original/poster.jpg")).toBe(false);
    expect(isAllowedArtworkUrl("https://image.tmdb.org/t/p/original/poster.svg")).toBe(false);
    expect(isAllowedArtworkUrl("https://127.0.0.1/poster.jpg")).toBe(false);
  });
});

describe("request defaults", () => {
  const profiles = [
    { id: 1, name: "Any" },
    { id: 4, name: "HD-1080p" },
    { id: 5, name: "Ultra-HD" },
    { id: 6, name: "HD - 720p/1080p" },
  ];

  it("prefers the shared 720p/1080p profile", () => {
    expect(pickDefaultQualityProfile(profiles)?.id).toBe(6);
    expect(
      pickDefaultQualityProfile([
        { id: 1, name: "Any" },
        { id: 5, name: "Ultra-HD" },
        { id: 7, name: "HD-720p/1080p" },
      ])?.id,
    ).toBe(7);
  });

  it("falls back to 1080p, 720p, and avoids 4K by default", () => {
    expect(pickDefaultQualityProfile(profiles.filter((p) => p.id !== 6))?.id).toBe(4);
    expect(
      pickDefaultQualityProfile([
        { id: 1, name: "Any" },
        { id: 3, name: "HD-720p" },
        { id: 5, name: "Ultra-HD" },
      ])?.id,
    ).toBe(3);
    expect(
      pickDefaultQualityProfile([
        { id: 1, name: "Any" },
        { id: 5, name: "Ultra-HD" },
      ])?.id,
    ).toBe(1);
    expect(pickDefaultQualityProfile([{ id: 1, name: "Any" }])?.id).toBe(1);
    expect(pickDefaultQualityProfile([])).toBeUndefined();
  });

  it("picks the first accessible root folder", () => {
    expect(
      pickDefaultRootFolder([
        { path: "/inaccessible", accessible: false },
        { path: "/media/tv", accessible: true },
      ])?.path,
    ).toBe("/media/tv");
    expect(pickDefaultRootFolder([{ path: "/only", accessible: false }])?.path).toBe("/only");
  });

  it("maps monitoring scopes to Sonarr season flags", () => {
    const seasons = [
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: false },
      { seasonNumber: 2, monitored: false },
    ];
    expect(monitorSeasons(seasons, "all")).toEqual([
      { seasonNumber: 0, monitored: true },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
    ]);
    expect(monitorSeasons(seasons, "firstSeason")).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
    ]);
    expect(monitorSeasons(seasons, "future")?.every((season) => !season.monitored)).toBe(true);
    expect(monitorSeasons(undefined, "all")).toBeUndefined();
    expect(arrMonitorName("future")).toBe("future");
  });
});

describe("search ranking", () => {
  const found = (
    title: string,
    votes?: number,
    kind: SearchResult["kind"] = "movie",
  ): SearchResult => ({
    key: `${kind}:${title}`,
    kind,
    service: kind === "movie" ? "radarr" : "sonarr",
    title,
    votes,
    inLibrary: false,
  });
  const titles = (items: SearchResult[]): string[] => items.map((item) => item.title);

  it("puts the original ahead of regional renames and zero-vote filler", () => {
    // Live Sonarr order for `the office`: UK, AU, SA, ..., US at position 9,
    // with Radarr contributing 1996/2020 movies that have no votes at all.
    const ranked = rankSearchResults(
      [
        found("The Office", 129_000, "series"),
        found("The Office (AU)", 4_000, "series"),
        found("The Office (US)", 859_030, "series"),
        found("The Office", 0),
      ],
      "the office",
    );

    expect(titles(ranked)).toEqual([
      "The Office (US)",
      "The Office",
      "The Office (AU)",
      "The Office",
    ]);
    expect(ranked[0]?.key).toBe("series:The Office (US)");
    expect(ranked[3]?.key).toBe("movie:The Office");
  });

  it("keeps an exact title ahead of a more popular continuation", () => {
    const ranked = rankSearchResults(
      [found("Dune: Part Two", 805_128), found("Dune", 1_101_251)],
      "dune",
    );

    expect(titles(ranked)).toEqual(["Dune", "Dune: Part Two"]);
  });

  it("never lets a weak match outrank a strong one on votes alone", () => {
    const ranked = rankSearchResults(
      [found("Box Office", 900_000), found("The Office", 129_000, "series")],
      "the office",
    );

    expect(titles(ranked)[0]).toBe("The Office");
  });

  it("matches through punctuation, articles and typos", () => {
    expect(titleMatchScore("spiderman", "Spider-Man")).toBeGreaterThan(0.5);
    expect(titleMatchScore("kantoor", "Die Kantoor")).toBeGreaterThan(0.5);
    expect(titleMatchScore("dune", "Severance")).toBe(0);
  });

  it("keeps upstream order when nothing matches", () => {
    const ranked = rankSearchResults([found("Zed"), found("Yak")], "qqq");

    expect(titles(ranked)).toEqual(["Zed", "Yak"]);
  });
});

describe("arr client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads disk space with the arr API key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://sonarr.test:8989/api/v3/diskspace");
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        "X-Api-Key": "sonarr-key",
      });
      return new Response(
        JSON.stringify([{ path: "/data", label: "data", freeSpace: 1024, totalSpace: 4096 }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createArrClient(
      "sonarr",
      { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989", apiKey: "sonarr-key" },
      500,
    );

    await expect(client.getDiskSpace()).resolves.toEqual([
      { path: "/data", label: "data", freeSpace: 1024, totalSpace: 4096 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
