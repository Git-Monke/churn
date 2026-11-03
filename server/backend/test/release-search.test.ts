import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createMediaCache } from "../src/media-cache.js";
import { createReleaseSearchService } from "../src/release-search.js";

let root: string;

function config(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: root,
    frontendDist: path.join(root, "frontend"),
    requestTimeoutMs: 500,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init),
    ),
  );
}

function parseResponse(title: string): Response {
  if (title.startsWith("Dune.")) {
    const resolution = title.includes("2160p") ? 2160 : 1080;
    return json({
      parsedMovieInfo: {
        movieTitles: ["Dune"],
        primaryMovieTitle: "Dune",
        year: 2021,
        quality: { quality: { resolution } },
      },
    });
  }

  const seasonMatch = title.match(/S(\d{1,3})/i);
  const seasonNumber = seasonMatch ? Number.parseInt(seasonMatch[1] ?? "", 10) : undefined;
  const episodes = [...title.matchAll(/E(\d{1,3})/gi)].map((match) =>
    Number.parseInt(match[1] ?? "", 10),
  );
  return json({
    parsedEpisodeInfo: {
      seriesTitleInfo: {
        titleWithoutYear: title.startsWith("Other.Show") ? "Other Show" : "Example Show",
      },
      seasonNumber,
      episodeNumbers: episodes,
      fullSeason: episodes.length === 0,
      isMultiSeason: /S\d{1,3}\s*-\s*(?:S)?\d{1,3}/i.test(title),
      quality: { quality: { resolution: title.includes("720p") ? 720 : 1080 } },
    },
  });
}

function cachedRelease(title: string, seeders: number, indexerId = 1) {
  return {
    guid: `guid-${indexerId}-${title}`,
    title,
    size: 1_000_000_000,
    seeders,
    leechers: 3,
    indexerId,
    indexer: indexerId === 1 ? "EZTV" : "The Pirate Bay",
    protocol: "torrent",
    publishDate: "2026-01-01T00:00:00Z",
    ageHours: 12,
    infoHash: `hash-${indexerId}-${title}`,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "churn-release-search-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("progressive Prowlarr release search", () => {
  it("streams per-indexer progress and filters unrelated names", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    installFetch(async (url) => {
      if (url.endsWith("/api/v1/indexer")) {
        return json([
          { id: 1, name: "EZTV", enable: true },
          { id: 2, name: "The Pirate Bay", enable: true },
        ]);
      }
      if (url.includes("/api/v3/indexer")) {
        return json([
          { id: 11, name: "EZTV (Prowlarr)" },
          { id: 12, name: "The Pirate Bay (Prowlarr)" },
        ]);
      }
      if (url.includes("/api/v3/parse")) {
        return parseResponse(new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("/api/v1/search") && url.includes("indexerIds=1")) {
        await firstMayFinish;
        return json([
          cachedRelease("Example.Show.S01E01.1080p", 30, 1),
          cachedRelease("Other.Show.S01E01.1080p", 100, 1),
          cachedRelease("Example.Show.S02E01.1080p", 90, 1),
        ]);
      }
      if (url.includes("/api/v1/search") && url.includes("indexerIds=2")) {
        return json([cachedRelease("Example.Show.S01.720p", 10, 2)]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const media = createMediaCache({ cacheDir: path.join(root, "media") });
    await media.putSeries({
      version: 1,
      kind: "series",
      id: 42,
      title: "Example Show",
      year: 2024,
      seasons: [1, 2],
      cachedAt: "2026-01-01T00:00:00Z",
    });
    const service = createReleaseSearchService(config(), media, {
      cacheDir: path.join(root, "prowlarr"),
    });

    const first = await service.getSeriesSeason(42, 1);
    expect(first.state).toBe("searching");
    expect(first.progress).toMatchObject({ finished: 0, total: 2 });
    expect(
      first.progress?.indexers.every((indexer) => indexer.canGrab),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const partial = await service.getSeriesSeason(42, 1);
    expect(partial.progress?.finished).toBe(1);
    expect(partial.releaseCount).toBe(1);
    expect(partial.groups[0]?.releases[0]?.title).toBe("Example.Show.S01.720p");

    releaseFirst?.();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = await service.getSeriesSeason(42, 1);
      if (snapshot.state === "ready") {
        expect(snapshot.progress).toMatchObject({ finished: 2, total: 2 });
        expect(snapshot.releaseCount).toBe(2);
        expect(snapshot.groups.flatMap((group) => group.releases).map((release) => release.title).sort()).toEqual([
          "Example.Show.S01.720p",
          "Example.Show.S01E01.1080p",
        ]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("search did not finish");
  });

  it("expands multi-season packs through Sonarr parse", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v1/indexer")) {
        return json([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v3/indexer")) {
        return json([{ id: 11, name: "EZTV (Prowlarr)" }]);
      }
      if (url.includes("/api/v3/parse")) {
        return parseResponse(new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("/api/v1/search")) {
        return json([cachedRelease("Example.Show.S01-07.1080p", 25, 1)]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const media = createMediaCache({ cacheDir: path.join(root, "media") });
    await media.putSeries({
      version: 1,
      kind: "series",
      id: 42,
      title: "Example Show",
      seasons: [1, 2, 3, 4, 5, 6, 7],
      cachedAt: "2026-01-01T00:00:00Z",
    });
    const service = createReleaseSearchService(config(), media, {
      cacheDir: path.join(root, "prowlarr"),
    });
    const body = await service.getSeriesSeason(42, 5);
    for (let attempt = 0; attempt < 50 && body.state !== "ready"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = await service.getSeriesSeason(42, 5);
    const release = finished.groups.flatMap((group) => group.releases)[0];
    expect(release?.seasonLabel).toBe("Seasons 1\u20137");
    expect(release?.multiSeason).toBe(true);
  });

  it("keeps unsynced indexers visible but disables grabbing", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v1/indexer")) {
        return json([
          { id: 1, name: "YTS", enable: true },
          { id: 2, name: "Uindex", enable: true },
        ]);
      }
      if (url.includes("/api/v3/indexer")) {
        return json([{ id: 7, name: "Uindex (Prowlarr)" }]);
      }
      if (url.includes("/api/v3/parse")) {
        return parseResponse(new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("/api/v1/search") && url.includes("indexerIds=1")) {
        return json([cachedRelease("Dune.2021.1080p", 80, 1)]);
      }
      if (url.includes("/api/v1/search") && url.includes("indexerIds=2")) {
        return json([cachedRelease("Dune.2021.2160p", 20, 2)]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const media = createMediaCache({ cacheDir: path.join(root, "media") });
    await media.putMovie({
      version: 1,
      kind: "movie",
      id: 7,
      title: "Dune",
      year: 2021,
      cachedAt: "2026-01-01T00:00:00Z",
    });
    const service = createReleaseSearchService(config(), media, {
      cacheDir: path.join(root, "prowlarr"),
    });
    const body = await service.getMovie(7);
    for (let attempt = 0; attempt < 50 && body.state !== "ready"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = await service.getMovie(7);
    const releases = finished.groups.flatMap((group) => group.releases);
    expect(releases).toHaveLength(2);
    expect(releases.find((release) => release.indexer === "YTS")?.canGrab).toBe(false);
    expect(releases.find((release) => release.indexer === "Uindex")?.canGrab).toBe(true);
    expect(releases.find((release) => release.indexer === "YTS")?.downloadDetail).toContain(
      "not synced to Radarr",
    );
  });

  it("persists a finished snapshot and reloads it without another search", async () => {
    let searches = 0;
    installFetch((url) => {
      if (url.endsWith("/api/v1/indexer")) {
        return json([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v3/indexer")) {
        return json([{ id: 11, name: "EZTV (Prowlarr)" }]);
      }
      if (url.includes("/api/v3/parse")) {
        return parseResponse(new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("/api/v1/search")) {
        searches += 1;
        return json([cachedRelease("Dune.2021.1080p", 80, 1)]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const media = createMediaCache({ cacheDir: path.join(root, "media") });
    await media.putMovie({
      version: 1,
      kind: "movie",
      id: 7,
      title: "Dune",
      year: 2021,
      cachedAt: "2026-01-01T00:00:00Z",
    });
    const options = { cacheDir: path.join(root, "prowlarr") };
    const first = createReleaseSearchService(config(), media, options);
    await first.getMovie(7);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await first.getMovie(7)).state === "ready") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(searches).toBe(1);

    const second = createReleaseSearchService(config(), media, options);
    const reloaded = await second.getMovie(7);
    expect(reloaded.state).toBe("ready");
    expect(reloaded.releaseCount).toBe(1);
    expect(searches).toBe(1);
  });
});
