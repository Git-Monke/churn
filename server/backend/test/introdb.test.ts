import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { UpstreamError } from "../src/errors.js";
import { createIntroDbCache } from "../src/introdb-cache.js";
import { fetchIntroDbSegments, mapIntroDbSegments } from "../src/introdb.js";
import { createIntroDbService } from "../src/introdb-warm.js";
import type { MediaCache } from "../src/media-cache.js";

const introDb = { url: "https://introdb.test", timeoutMs: 500 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tempCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), "churn-introdb-"));
}

function appConfig(overrides: Partial<AppConfig["services"]["sonarr"]> = {}): AppConfig {
  return {
    introdb: introDb,
    requestTimeoutMs: 500,
    services: {
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "https://sonarr.test",
        apiKey: "sonarr-key",
        ...overrides,
      },
    },
  } as unknown as AppConfig;
}

function mediaCacheWith(imdbId?: string): MediaCache {
  return {
    getSeries: async () => (imdbId ? { imdbId } : undefined),
    putSeries: async () => undefined,
  } as unknown as MediaCache;
}

describe("IntroDB segment mapping", () => {
  it("keeps intro, recap, outro and post-credits ranges in seconds", () => {
    expect(
      mapIntroDbSegments({
        intro: { start_ms: 2_500, end_ms: 58_000 },
        recap: { start_ms: 1_000, end_ms: 20_000 },
        outro: { start_ms: 3_300_000, end_ms: 3_500_000 },
        post_credits: { start_ms: 3_500_000, end_ms: 3_560_000 },
      }),
    ).toEqual({
      intro: { startSec: 2.5, endSec: 58 },
      recap: { startSec: 1, endSec: 20 },
      outro: { startSec: 3_300, endSec: 3_500 },
      postCredits: { startSec: 3_500, endSec: 3_560 },
    });
  });

  it("drops null, inverted and malformed ranges", () => {
    expect(
      mapIntroDbSegments({
        intro: { start_ms: 58_000, end_ms: 2_500 },
        recap: { start_ms: -1, end_ms: 20_000 },
        outro: null,
        post_credits: { start_ms: 1.5, end_ms: 2_000 },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a non-object response", () => {
    expect(mapIntroDbSegments("nope")).toBeUndefined();
    expect(mapIntroDbSegments(undefined)).toBeUndefined();
  });
});

describe("IntroDB client", () => {
  it("requests the series IMDb id and returns mapped segments", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      jsonResponse({
        imdb_id: "tt0903747",
        season: 1,
        episode: 2,
        intro: { start_ms: 2_500, end_ms: 58_000, start_sec: 2.5, end_sec: 58 },
        recap: null,
        outro: { start_ms: 3_300_000, end_ms: 3_500_000 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchIntroDbSegments(introDb, "tt0903747", 1, 2),
    ).resolves.toEqual({
      intro: { startSec: 2.5, endSec: 58 },
      outro: { startSec: 3_300, endSec: 3_500 },
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://introdb.test/segments");
    expect(url.searchParams.get("imdb_id")).toBe("tt0903747");
    expect(url.searchParams.get("season")).toBe("1");
    expect(url.searchParams.get("episode")).toBe("2");
  });

  it("treats a 404 as no data for that episode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Intro not found" }, 404)));
    await expect(
      fetchIntroDbSegments(introDb, "tt0903747", 1, 1),
    ).resolves.toBeUndefined();
  });

  it("reports other failures so the warm-up can log and continue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "nope" }, 500)));
    await expect(
      fetchIntroDbSegments(introDb, "tt0903747", 1, 1),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("IntroDB cache", () => {
  it("persists one JSON file per series and reads it after a restart", async () => {
    const cacheDir = tempCacheDir();
    const cache = createIntroDbCache({ cacheDir });
    await cache.put("tt0903747", 1, 2, {
      intro: { startSec: 2.5, endSec: 58 },
    });

    const file = JSON.parse(
      readFileSync(path.join(cacheDir, "tt0903747.json"), "utf8"),
    );
    expect(file).toMatchObject({
      version: 1,
      imdbId: "tt0903747",
      episodes: {
        s1e2: { segments: { intro: { startSec: 2.5, endSec: 58 } } },
      },
    });

    const reloaded = createIntroDbCache({ cacheDir });
    await expect(reloaded.get("tt0903747", 1, 2)).resolves.toEqual({
      intro: { startSec: 2.5, endSec: 58 },
    });
    await expect(reloaded.get("tt0903747", 1, 3)).resolves.toBeUndefined();
  });

  it("ignores a corrupt cache file instead of failing playback", async () => {
    const cacheDir = tempCacheDir();
    const pathForFile = path.join(cacheDir, "tt0903747.json");
    const cache = createIntroDbCache({ cacheDir });
    await cache.put("tt0903747", 1, 1, { intro: { startSec: 1, endSec: 2 } });
    const corrupt = createIntroDbCache({ cacheDir });
    // Overwrite after the first cache has loaded, then read through a new one.
    await writeFile(pathForFile, "not json", "utf8");
    await expect(corrupt.get("tt0903747", 1, 1)).resolves.toBeUndefined();
  });
});

describe("IntroDB warm-up", () => {
  it("fetches and caches one episode when an episode was grabbed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://introdb.test/segments?")) {
        return jsonResponse({
          intro: { start_ms: 2_500, end_ms: 58_000 },
          outro: { start_ms: 3_300_000, end_ms: 3_500_000 },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cache = createIntroDbCache({ cacheDir: tempCacheDir() });
    const service = createIntroDbService({
      config: appConfig(),
      cache,
      mediaCache: mediaCacheWith("tt0903747"),
    });

    await service.warmFromGrab(42, 1, 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(service.segmentsFor("tt0903747", 1, 2)).resolves.toEqual({
      intro: { startSec: 2.5, endSec: 58 },
      outro: { startSec: 3_300, endSec: 3_500 },
    });
  });

  it("fetches every episode of the grabbed season from Sonarr's list", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        paths.push(url);
        if (url.startsWith("https://sonarr.test/api/v3/episode?")) {
          return jsonResponse([
            { seasonNumber: 1, episodeNumber: 2 },
            { seasonNumber: 1, episodeNumber: 1 },
            { seasonNumber: 1, episodeNumber: 1 },
            { seasonNumber: 2, episodeNumber: 1 },
          ]);
        }
        if (url.startsWith("https://introdb.test/segments?")) {
          const parsed = new URL(url);
          return jsonResponse({
            intro: {
              start_ms: Number(parsed.searchParams.get("episode")) * 1000,
              end_ms: Number(parsed.searchParams.get("episode")) * 2000,
            },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const cache = createIntroDbCache({ cacheDir: tempCacheDir() });
    const service = createIntroDbService({
      config: appConfig(),
      cache,
      mediaCache: mediaCacheWith("tt0903747"),
    });

    await service.warmFromGrab(42, 1);

    const introRequests = paths.filter((url) =>
      url.startsWith("https://introdb.test/segments?"),
    );
    expect(introRequests).toHaveLength(2);
    expect(introRequests[0]).toContain("episode=1");
    expect(introRequests[1]).toContain("episode=2");
    await expect(service.segmentsFor("tt0903747", 1, 1)).resolves.toEqual({
      intro: { startSec: 1, endSec: 2 },
    });
  });

  it("does not call IntroDB when the series has no IMDb id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = createIntroDbService({
      config: appConfig({ apiKey: undefined }),
      cache: createIntroDbCache({ cacheDir: tempCacheDir() }),
      mediaCache: mediaCacheWith(),
    });

    await service.warmFromGrab(42, 1, 1);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
