import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { ServarrParsedEpisodeInfo } from "../src/upstream/servarr.js";
import {
  createReleaseParser,
  mapArrParseResponse,
  releaseEpisodeLabel,
  releaseMatchesMovie,
  releaseMatchesSeries,
  releaseSeasonLabel,
} from "../src/release-name.js";

function config(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-release-name-test",
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 60_000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    services: {
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://jellyfin.test:8096" },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://sonarr.test:8989",
        apiKey: "sonarr-key",
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://radarr.test:7878",
        apiKey: "radarr-key",
      },
    },
    qbittorrent: { url: "http://qbittorrent.test:8080" },
    prowlarr: { url: "http://prowlarr.test:9696", apiKey: "prowlarr-key" },
    vpn: { statusUrl: "http://vpn-status.test:8098", timeoutMs: 500 },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("arr release-name parsing", () => {
  it("maps Radarr movie metadata and quality", () => {
    const parsed = mapArrParseResponse("movie", "The.Matrix.1999.1080p.BluRay", {
      parsedMovieInfo: {
        movieTitles: ["The Matrix"],
        primaryMovieTitle: "The Matrix",
        year: 1999,
        quality: { quality: { resolution: 1080 } },
      },
    });

    expect(parsed).toMatchObject({
      title: "The Matrix",
      years: [1999],
      titleAliases: ["The Matrix"],
      tier: 2,
      quality: "1080p",
    });
    expect(releaseMatchesMovie(parsed!, { title: "The Matrix", year: 1999 })).toBe(true);
  });

  it("uses Sonarr episode and multi-season data", () => {
    const episode = parseSeries("Lost.S01E01E02.720p", {
      seriesTitleInfo: { titleWithoutYear: "Lost" },
      seasonNumber: 1,
      episodeNumbers: [1, 2],
      quality: { quality: { resolution: 720 } },
    });
    expect(episode).toMatchObject({
      title: "Lost",
      seasonNumbers: [1],
      episodeNumbers: [1, 2],
      seasonPack: false,
      tier: 1,
      quality: "720p",
    });

    const pack = parseSeries("Parks.and.Recreation.S01-07.1080p", {
      seriesTitleInfo: { titleWithoutYear: "Parks and Recreation", year: 2009 },
      seasonNumber: 1,
      episodeNumbers: [],
      fullSeason: true,
      isMultiSeason: true,
      releaseType: "seasonPack",
      quality: { quality: { resolution: 1080 } },
    });
    expect(pack).toMatchObject({
      title: "Parks and Recreation",
      years: [2009],
      seasonNumbers: [1, 2, 3, 4, 5, 6, 7],
      seasonPack: true,
    });
  });

  it("matches series titles, season ranges and episodes", () => {
    const parsed = parseSeries("The.Office.US.S01-03.1080p", {
      seriesTitleInfo: { titleWithoutYear: "The Office US" },
      seasonNumber: 1,
      episodeNumbers: [],
      fullSeason: true,
      isMultiSeason: true,
      releaseType: "seasonPack",
    });

    expect(releaseMatchesSeries(parsed!, { title: "The Office" }, 3, 7)).toBe(true);
    expect(parsed && releaseMatchesSeries(parsed, { title: "The Office" }, 4)).toBe(false);
  });

  it("formats labels", () => {
    const parsed = parseSeries("Show.S01E02E03.720p", {
      seriesTitleInfo: { titleWithoutYear: "Show" },
      seasonNumber: 1,
      episodeNumbers: [2, 3],
    });
    expect(releaseEpisodeLabel(parsed!)).toBe("S01E02–E03");
    expect(releaseSeasonLabel(parsed!)).toBe("Season 1");
  });

  it("caches successful parses and shares duplicate in-flight requests", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return json({
          parsedEpisodeInfo: {
            seriesTitleInfo: { titleWithoutYear: "Example Show" },
            seasonNumber: 1,
            episodeNumbers: [1],
            quality: { quality: { resolution: 1080 } },
          },
        });
      }),
    );

    const parser = createReleaseParser(config());
    const title = "Example.Show.S01E01.1080p";
    const [first, second] = await Promise.all([
      parser.parse("series", title),
      parser.parse("series", title),
    ]);
    const third = await parser.parse("series", title);

    expect(first?.title).toBe("Example Show");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/v3/parse?title=Example.Show.S01E01.1080p");
  });
});

function parseSeries(rawTitle: string, parsedEpisodeInfo: ServarrParsedEpisodeInfo) {
  return mapArrParseResponse("series", rawTitle, { parsedEpisodeInfo });
}
