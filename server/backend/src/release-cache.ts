import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { releaseId, releaseMatchesSeason } from "./releases.js";
import type { ServarrRelease } from "./upstream/servarr.js";

export const RELEASE_CACHE_VERSION = 1;

/**
 * Opening a show re-checks seasons that have no usable cached results, but not
 * on every poll. Manual refreshes bypass this cooldown.
 */
const AUTO_WARM_COOLDOWN_MS = 30 * 60_000;

/** One release returned by an indexer search, kept server-side only. */
export interface CachedRelease {
  release: ServarrRelease;
  /** Sonarr season search that produced this release. */
  searchSeasonNumber?: number;
}

/** The result of one Radarr movie search or one Sonarr season search. */
export interface CachedSearchFile {
  version: typeof RELEASE_CACHE_VERSION;
  kind: "movie" | "series";
  movieId?: number;
  seriesId?: number;
  searchSeasonNumber?: number;
  fetchedAt: string;
  releases: CachedRelease[];
}

export interface CachedReleaseView {
  /** Releases merged from every cached search relevant to this target. */
  releases: CachedRelease[];
  /** Most recent search that contributed to this view. */
  fetchedAt?: string;
  /** Season searches that have cached results for this series. */
  cachedSeasons: number[];
  /** True when a search for this target/season is currently running. */
  refreshing: boolean;
  /** True when the target/season has no cached search yet. */
  searching: boolean;
  lastError?: string;
}

export type ReleaseCacheTarget =
  | { kind: "movie"; movieId: number }
  | { kind: "series"; seriesId: number; seasonNumber?: number };

export interface ReleaseCacheOptions {
  /** Directory for persisted release snapshots, usually `server/cache/releases`. */
  cacheDir: string;
  now?: () => Date;
}

export interface ReleaseCache {
  getMovie(movieId: number): Promise<CachedReleaseView>;
  getSeriesSeason(seriesId: number, seasonNumber: number): Promise<CachedReleaseView>;
  warmMovie(movieId: number, fetchReleases: () => Promise<ServarrRelease[]>): Promise<void>;
  /** Search a movie that has no cached release results yet, with a cooldown. */
  warmMissingMovie(
    movieId: number,
    fetchReleases: () => Promise<ServarrRelease[]>,
  ): Promise<void>;
  warmSeriesSeason(
    seriesId: number,
    seasonNumber: number,
    fetchReleases: () => Promise<ServarrRelease[]>,
  ): Promise<void>;
  /** Warm seasons in ascending order; the first season is searched first. */
  warmSeries(
    seriesId: number,
    seasonNumbers: number[],
    fetchReleases: (seasonNumber: number) => Promise<ServarrRelease[]>,
  ): Promise<void>;
  /** Search seasons that do not have a cached search yet, once per series run. */
  warmMissingSeries(
    seriesId: number,
    seasonNumbers: number[],
    fetchReleases: (seasonNumber: number) => Promise<ServarrRelease[]>,
  ): Promise<void>;
  isRefreshing(target: ReleaseCacheTarget): boolean;
  findRelease(target: ReleaseCacheTarget, id: string): Promise<CachedRelease | undefined>;
  invalidateMovie(movieId: number): Promise<void>;
  invalidateSeries(seriesId: number): Promise<void>;
}

/**
 * Disk-backed cache of raw arr release searches.
 *
 * Each file is one search result: `movie-<id>.json` or
 * `series-<id>/s<season>.json`. A season view merges every cached Sonarr search
 * for that series, so a multi-season pack returned by the season-1 search is
 * visible under every season it covers even when Sonarr files it under one
 * season only.
 */
export function createReleaseCache(options: ReleaseCacheOptions): ReleaseCache {
  const { cacheDir } = options;
  const now = options.now ?? (() => new Date());

  const movies = new Map<number, CachedSearchFile>();
  const loadedMovies = new Set<number>();
  const movieLoads = new Map<number, Promise<void>>();

  const series = new Map<number, Map<number, CachedSearchFile>>();
  const loadedSeries = new Set<number>();
  const seriesLoads = new Map<number, Promise<void>>();

  const inFlight = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const autoWarmedAt = new Map<string, number>();

  const movieKey = (id: number) => `movie:${id}`;
  const seriesKey = (id: number, season: number) => `series:${id}:${season}`;
  const seriesFileKey = (id: number) => `series:${id}`;

  async function ensureMovieLoaded(movieId: number): Promise<void> {
    if (loadedMovies.has(movieId)) {
      return;
    }
    const pending = movieLoads.get(movieId);
    if (pending) {
      return pending;
    }
    const load = (async () => {
      const file = await readSearchFile(movieFile(movieId));
      if (file?.kind === "movie" && file.movieId === movieId) {
        movies.set(movieId, file);
      }
      loadedMovies.add(movieId);
    })().finally(() => movieLoads.delete(movieId));
    movieLoads.set(movieId, load);
    return load;
  }

  async function ensureSeriesLoaded(seriesId: number): Promise<void> {
    if (loadedSeries.has(seriesId)) {
      return;
    }
    const pending = seriesLoads.get(seriesId);
    if (pending) {
      return pending;
    }
    const load = (async () => {
      const seasonFiles = await readSeriesSearchFiles(seriesDirectory(seriesId));
      const bySeason = new Map<number, CachedSearchFile>();
      for (const file of seasonFiles) {
        if (
          file.kind === "series" &&
          file.seriesId === seriesId &&
          file.searchSeasonNumber !== undefined
        ) {
          bySeason.set(file.searchSeasonNumber, file);
        }
      }
      series.set(seriesId, bySeason);
      loadedSeries.add(seriesId);
    })().finally(() => seriesLoads.delete(seriesId));
    seriesLoads.set(seriesId, load);
    return load;
  }

  function movieFile(movieId: number): string {
    return path.join(cacheDir, `movie-${movieId}.json`);
  }

  function seriesDirectory(seriesId: number): string {
    return path.join(cacheDir, `series-${seriesId}`);
  }

  function seriesFile(seriesId: number, seasonNumber: number): string {
    return path.join(seriesDirectory(seriesId), `s${seasonNumber}.json`);
  }

  async function writeSearchFile(filePath: string, file: CachedSearchFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(file), "utf8");
    await rename(temporary, filePath);
  }

  async function searchMovie(
    movieId: number,
    fetchReleases: () => Promise<ServarrRelease[]>,
  ): Promise<void> {
    const key = movieKey(movieId);
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const run = (async () => {
      errors.delete(key);
      try {
        const releases = await fetchReleases();
        const file: CachedSearchFile = {
          version: RELEASE_CACHE_VERSION,
          kind: "movie",
          movieId,
          fetchedAt: now().toISOString(),
          releases: releases.map((release) => ({ release })),
        };
        await writeSearchFile(movieFile(movieId), file);
        movies.set(movieId, file);
        loadedMovies.add(movieId);
      } catch (error) {
        errors.set(key, errorMessage(error));
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  }

  async function searchSeriesSeason(
    seriesId: number,
    seasonNumber: number,
    fetchReleases: () => Promise<ServarrRelease[]>,
  ): Promise<void> {
    const key = seriesKey(seriesId, seasonNumber);
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const run = (async () => {
      errors.delete(key);
      try {
        const releases = await fetchReleases();
        const file: CachedSearchFile = {
          version: RELEASE_CACHE_VERSION,
          kind: "series",
          seriesId,
          searchSeasonNumber: seasonNumber,
          fetchedAt: now().toISOString(),
          releases: releases.map((release) => ({ release, searchSeasonNumber: seasonNumber })),
        };
        await writeSearchFile(seriesFile(seriesId, seasonNumber), file);
        let bySeason = series.get(seriesId);
        if (!bySeason) {
          bySeason = new Map();
          series.set(seriesId, bySeason);
        }
        bySeason.set(seasonNumber, file);
        loadedSeries.add(seriesId);
      } catch (error) {
        errors.set(key, errorMessage(error));
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  }

  async function getMovie(movieId: number): Promise<CachedReleaseView> {
    await ensureMovieLoaded(movieId);
    const file = movies.get(movieId);
    return {
      releases: file?.releases ?? [],
      fetchedAt: file?.fetchedAt,
      cachedSeasons: [],
      refreshing: inFlight.has(movieKey(movieId)),
      searching: file === undefined,
      lastError: errors.get(movieKey(movieId)),
    };
  }

  async function getSeriesSeason(
    seriesId: number,
    seasonNumber: number,
  ): Promise<CachedReleaseView> {
    await ensureSeriesLoaded(seriesId);
    const bySeason = series.get(seriesId) ?? new Map<number, CachedSearchFile>();
    const cachedSeasons = [...bySeason.keys()].sort((left, right) => left - right);

    const merged = new Map<string, CachedRelease>();
    let fetchedAt: string | undefined;
    for (const file of bySeason.values()) {
      for (const entry of file.releases) {
        if (!releaseMatchesSeason(entry.release, seasonNumber)) {
          continue;
        }
        const id = releaseId(entry.release);
        if (!id || merged.has(id)) {
          continue;
        }
        merged.set(id, {
          release: entry.release,
          searchSeasonNumber: entry.searchSeasonNumber ?? file.searchSeasonNumber,
        });
        if (fetchedAt === undefined || file.fetchedAt > fetchedAt) {
          fetchedAt = file.fetchedAt;
        }
      }
    }

    return {
      releases: [...merged.values()],
      fetchedAt,
      cachedSeasons,
      refreshing:
        inFlight.has(seriesKey(seriesId, seasonNumber)) ||
        inFlight.has(seriesFileKey(seriesId)),
      searching: !bySeason.has(seasonNumber),
      lastError:
        errors.get(seriesKey(seriesId, seasonNumber)) ??
        errors.get(seriesFileKey(seriesId)),
    };
  }

  async function findRelease(
    target: ReleaseCacheTarget,
    id: string,
  ): Promise<CachedRelease | undefined> {
    if (target.kind === "movie") {
      await ensureMovieLoaded(target.movieId);
      return movies.get(target.movieId)?.releases.find((entry) => releaseId(entry.release) === id);
    }

    await ensureSeriesLoaded(target.seriesId);
    const bySeason = series.get(target.seriesId);
    if (!bySeason) {
      return undefined;
    }
    for (const file of bySeason.values()) {
      const match = file.releases.find((entry) => releaseId(entry.release) === id);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  return {
    getMovie,
    getSeriesSeason,
    warmMovie: searchMovie,
    async warmMissingMovie(movieId, fetchReleases) {
      const key = movieKey(movieId);
      const autoKey = `auto:${key}`;
      const pending = inFlight.get(autoKey);
      if (pending) {
        return pending;
      }

      const run = (async () => {
        try {
          await ensureMovieLoaded(movieId);
          const file = movies.get(movieId);
          if (file && file.releases.length > 0) {
            return;
          }
          const lastWarm = autoWarmedAt.get(key);
          const nowMs = now().getTime();
          if (lastWarm !== undefined && nowMs - lastWarm < AUTO_WARM_COOLDOWN_MS) {
            return;
          }
          autoWarmedAt.set(key, nowMs);
          await searchMovie(movieId, fetchReleases);
        } finally {
          inFlight.delete(autoKey);
        }
      })();
      inFlight.set(autoKey, run);
      return run;
    },
    warmSeriesSeason: searchSeriesSeason,
    async warmSeries(seriesId, seasonNumbers, fetchReleases) {
      const seasons = sortedSeasons(seasonNumbers);
      for (const season of seasons) {
        await searchSeriesSeason(seriesId, season, () => fetchReleases(season));
      }
    },
    async warmMissingSeries(seriesId, seasonNumbers, fetchReleases) {
      const key = seriesFileKey(seriesId);
      const pending = inFlight.get(key);
      if (pending) {
        return pending;
      }

      const run = (async () => {
        try {
          await ensureSeriesLoaded(seriesId);
          const bySeason = series.get(seriesId);
          const seasons = sortedSeasons(seasonNumbers).filter((season) => {
            const cached = bySeason?.get(season);
            return !cached || cached.releases.length === 0;
          });
          if (seasons.length === 0) {
            return;
          }
          const lastWarm = autoWarmedAt.get(key);
          const nowMs = now().getTime();
          if (lastWarm !== undefined && nowMs - lastWarm < AUTO_WARM_COOLDOWN_MS) {
            return;
          }
          autoWarmedAt.set(key, nowMs);
          for (const season of seasons) {
            await searchSeriesSeason(seriesId, season, () => fetchReleases(season));
          }
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, run);
      return run;
    },
    isRefreshing(target) {
      if (target.kind === "movie") {
        return inFlight.has(movieKey(target.movieId));
      }
      if (target.seasonNumber !== undefined) {
        return inFlight.has(seriesKey(target.seriesId, target.seasonNumber));
      }
      return inFlight.has(seriesFileKey(target.seriesId));
    },
    findRelease,
    async invalidateMovie(movieId) {
      movies.delete(movieId);
      loadedMovies.add(movieId);
      errors.delete(movieKey(movieId));
      autoWarmedAt.delete(movieKey(movieId));
      await rm(movieFile(movieId), { force: true });
    },
    async invalidateSeries(seriesId) {
      series.delete(seriesId);
      loadedSeries.add(seriesId);
      autoWarmedAt.delete(seriesFileKey(seriesId));
      for (const key of [...errors.keys()]) {
        if (key.startsWith(seriesFileKey(seriesId))) {
          errors.delete(key);
        }
      }
      await rm(seriesDirectory(seriesId), { recursive: true, force: true });
    },
  };
}

async function readSearchFile(filePath: string): Promise<CachedSearchFile | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseSearchFile(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

async function readSeriesSearchFiles(directory: string): Promise<CachedSearchFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const files: CachedSearchFile[] = [];
  for (const name of names) {
    if (!/^s\d+\.json$/.test(name)) {
      continue;
    }
    const file = await readSearchFile(path.join(directory, name));
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function parseSearchFile(value: unknown): CachedSearchFile | undefined {
  if (!isRecord(value) || value.version !== RELEASE_CACHE_VERSION) {
    return undefined;
  }
  if (value.kind !== "movie" && value.kind !== "series") {
    return undefined;
  }
  if (typeof value.fetchedAt !== "string" || !Array.isArray(value.releases)) {
    return undefined;
  }

  const releases: CachedRelease[] = [];
  for (const entry of value.releases) {
    if (!isRecord(entry) || !isRecord(entry.release)) {
      continue;
    }
    releases.push({
      release: entry.release as unknown as ServarrRelease,
      ...(typeof entry.searchSeasonNumber === "number"
        ? { searchSeasonNumber: entry.searchSeasonNumber }
        : {}),
    });
  }

  return {
    version: RELEASE_CACHE_VERSION,
    kind: value.kind,
    ...(typeof value.movieId === "number" ? { movieId: value.movieId } : {}),
    ...(typeof value.seriesId === "number" ? { seriesId: value.seriesId } : {}),
    ...(typeof value.searchSeasonNumber === "number"
      ? { searchSeasonNumber: value.searchSeasonNumber }
      : {}),
    fetchedAt: value.fetchedAt,
    releases,
  };
}

function sortedSeasons(seasonNumbers: number[]): number[] {
  return [...new Set(seasonNumbers)]
    .filter((season) => Number.isInteger(season) && season > 0)
    .sort((left, right) => left - right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
