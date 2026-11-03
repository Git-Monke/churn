import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReleaseCache } from "../src/release-cache.js";
import { releaseId } from "../src/releases.js";
import type { ServarrRelease } from "../src/upstream/servarr.js";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "churn-release-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function release(overrides: Partial<ServarrRelease> = {}): ServarrRelease {
  return {
    guid: "magnet:?xt=urn:btih:abc",
    indexerId: 1,
    indexer: "Indexer",
    title: "Example.Show.S01.1080p",
    size: 1_000_000_000,
    quality: { quality: { id: 7, name: "WEBDL-1080p" } },
    seasonNumber: 1,
    seasonNumbers: [1],
    approved: true,
    rejected: false,
    downloadAllowed: true,
    rejections: [],
    protocol: "torrent",
    seeders: 100,
    ...overrides,
  };
}

describe("release cache", () => {
  it("persists a movie search and reloads it from disk", async () => {
    const first = createReleaseCache({ cacheDir });
    await first.warmMovie(7, async () => [release({ title: "Movie.1080p" })]);

    const view = await first.getMovie(7);
    expect(view.searching).toBe(false);
    expect(view.releases).toHaveLength(1);
    expect(view.fetchedAt).toBeDefined();

    const raw = await readFile(path.join(cacheDir, "movie-7.json"), "utf8");
    expect(raw).not.toContain("undefined");

    const second = createReleaseCache({ cacheDir });
    const reloaded = await second.getMovie(7);
    expect(reloaded.releases).toHaveLength(1);
    expect(reloaded.releases[0]?.release.title).toBe("Movie.1080p");
  });

  it("merges a multi-season pack from a sibling season search", async () => {
    const cache = createReleaseCache({ cacheDir });
    const pack = release({
      guid: "pack",
      title: "Example.Show.S01-03.1080p",
      seasonNumber: 1,
      seasonNumbers: [1],
    });
    const seasonTwo = release({
      guid: "season-two",
      title: "Example.Show.S02.1080p",
      seasonNumber: 2,
      seasonNumbers: [2],
    });

    await cache.warmSeriesSeason(42, 1, async () => [pack]);
    await cache.warmSeriesSeason(42, 2, async () => [seasonTwo]);

    const season2 = await cache.getSeriesSeason(42, 2);
    expect(season2.releases.map((entry) => entry.release.title).sort()).toEqual([
      "Example.Show.S01-03.1080p",
      "Example.Show.S02.1080p",
    ]);
    expect(season2.cachedSeasons).toEqual([1, 2]);

    const season3 = await cache.getSeriesSeason(42, 3);
    expect(season3.releases.map((entry) => entry.release.title)).toEqual([
      "Example.Show.S01-03.1080p",
    ]);
  });

  it("refreshes one season without deleting sibling search files", async () => {
    const cache = createReleaseCache({ cacheDir });
    const pack = release({ guid: "pack", title: "Example.Show.S01-03.1080p" });
    await cache.warmSeriesSeason(42, 1, async () => [pack]);
    await cache.warmSeriesSeason(42, 2, async () => []);

    await cache.warmSeriesSeason(42, 2, async () => [
      release({ guid: "new-two", title: "Example.Show.S02.720p", seasonNumber: 2 }),
    ]);

    const season2 = await cache.getSeriesSeason(42, 2);
    expect(season2.releases.map((entry) => entry.release.title).sort()).toEqual([
      "Example.Show.S01-03.1080p",
      "Example.Show.S02.720p",
    ]);
  });

  it("searches seasons in ascending order", async () => {
    const cache = createReleaseCache({ cacheDir });
    const order: number[] = [];
    await cache.warmSeries(42, [3, 1, 2, 0], async (season) => {
      order.push(season);
      return [];
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("auto-searches seasons with no usable cached results, with a cooldown", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const cache = createReleaseCache({ cacheDir, now: () => current });
    await cache.warmSeriesSeason(42, 1, async () => []);
    await cache.warmSeriesSeason(42, 2, async () => [
      release({ guid: "season-two", title: "Example.Show.S02.1080p", seasonNumber: 2 }),
    ]);

    const calls: number[] = [];
    const fetchSeason = async (season: number) => {
      calls.push(season);
      return season === 1
        ? [release({ guid: "season-one", title: "Example.Show.S01.1080p", seasonNumber: 1 })]
        : [];
    };

    await cache.warmMissingSeries(42, [1, 2, 3], fetchSeason);
    expect(calls).toEqual([1, 3]);

    // Another page load shortly afterwards does not repeat the searches.
    await cache.warmMissingSeries(42, [1, 2, 3], fetchSeason);
    expect(calls).toEqual([1, 3]);

    // After the cooldown, retry only the season that still has no releases.
    current = new Date("2026-01-01T00:31:00Z");
    await cache.warmMissingSeries(42, [1, 2, 3], fetchSeason);
    expect(calls).toEqual([1, 3, 3]);
  });

  it("auto-searches a movie with no cached results, with a cooldown", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const cache = createReleaseCache({ cacheDir, now: () => current });
    await cache.warmMovie(7, async () => []);

    let calls = 0;
    const fetchReleases = async () => {
      calls += 1;
      return [release({ title: "Movie.1080p" })];
    };

    await cache.warmMissingMovie(7, fetchReleases);
    expect(calls).toBe(1);

    await cache.warmMissingMovie(7, fetchReleases);
    expect(calls).toBe(1);

    current = new Date("2026-01-01T00:31:00Z");
    await cache.warmMissingMovie(7, fetchReleases);
    expect(calls).toBe(1);
  });

  it("deduplicates concurrent warm requests", async () => {
    const cache = createReleaseCache({ cacheDir });
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [release()];
    };
    await Promise.all([cache.warmSeriesSeason(42, 1, fetch), cache.warmSeriesSeason(42, 1, fetch)]);
    expect(calls).toBe(1);
  });

  it("finds cached releases by opaque id and invalidates titles", async () => {
    const cache = createReleaseCache({ cacheDir });
    const item = release();
    await cache.warmSeriesSeason(42, 1, async () => [item]);
    const id = releaseId(item);
    expect(id).toBeTruthy();

    const found = await cache.findRelease({ kind: "series", seriesId: 42 }, id as string);
    expect(found?.release.title).toBe(item.title);

    await cache.invalidateSeries(42);
    expect((await cache.getSeriesSeason(42, 1)).searching).toBe(true);
    expect(await cache.findRelease({ kind: "series", seriesId: 42 }, id as string)).toBeUndefined();
  });

  it("reports searching on a cold target and stores search errors", async () => {
    const cache = createReleaseCache({ cacheDir });
    expect((await cache.getMovie(9)).searching).toBe(true);

    await cache.warmMovie(9, async () => {
      throw new Error("indexer down");
    });
    const view = await cache.getMovie(9);
    expect(view.searching).toBe(true);
    expect(view.lastError).toBe("indexer down");
  });
});
