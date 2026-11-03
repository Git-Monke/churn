import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { movieMetadata, seriesMetadata } from "./activity.js";
import type { ServarrMovieResource, ServarrSeriesResource } from "./upstream/servarr.js";

export const MEDIA_CACHE_VERSION = 1;

/** The small subset of Sonarr/Radarr metadata that release search needs. */
export interface MovieMetadataCacheEntry {
  version: typeof MEDIA_CACHE_VERSION;
  kind: "movie";
  id: number;
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  overview?: string;
  network?: string;
  rating?: number;
  runtimeMinutes?: number;
  imageUrl?: string;
  cachedAt: string;
}

export interface SeriesMetadataCacheEntry {
  kind: "series";
  version: typeof MEDIA_CACHE_VERSION;
  id: number;
  title: string;
  year?: number;
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  overview?: string;
  network?: string;
  rating?: number;
  imageUrl?: string;
  seasons: number[];
  /** Seasons where Sonarr already has every episode file. */
  completeSeasons?: number[];
  cachedAt: string;
}

export interface MediaCache {
  getMovie(id: number): Promise<MovieMetadataCacheEntry | undefined>;
  putMovie(entry: MovieMetadataCacheEntry): Promise<void>;
  getSeries(id: number): Promise<SeriesMetadataCacheEntry | undefined>;
  putSeries(entry: SeriesMetadataCacheEntry): Promise<void>;
  invalidateMovie(id: number): Promise<void>;
  invalidateSeries(id: number): Promise<void>;
}

export interface MediaCacheOptions {
  cacheDir: string;
  now?: () => Date;
}

/**
 * Metadata is cached when a title is added or first used by release search.
 * Release search then needs no Radarr/Sonarr lookup to build an indexer query.
 */
export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const { cacheDir } = options;
  const now = options.now ?? (() => new Date());
  const movies = new Map<number, MovieMetadataCacheEntry>();
  const series = new Map<number, SeriesMetadataCacheEntry>();
  const loadingMovies = new Map<number, Promise<void>>();
  const loadingSeries = new Map<number, Promise<void>>();

  async function getMovie(id: number): Promise<MovieMetadataCacheEntry | undefined> {
    if (!movies.has(id)) {
      await loadMovie(id);
    }
    return movies.get(id);
  }

  async function getSeries(id: number): Promise<SeriesMetadataCacheEntry | undefined> {
    if (!series.has(id)) {
      await loadSeries(id);
    }
    return series.get(id);
  }

  async function loadMovie(id: number): Promise<void> {
    const pending = loadingMovies.get(id);
    if (pending) {
      return pending;
    }
    const run = (async () => {
      try {
        const raw = await readFile(moviePath(id), "utf8");
        const parsed = parseMovie(JSON.parse(raw) as unknown);
        if (parsed?.id === id) {
          movies.set(id, parsed);
        }
      } catch {
        // Missing or corrupt cache entries are rebuilt from the arr on demand.
      }
    })().finally(() => loadingMovies.delete(id));
    loadingMovies.set(id, run);
    return run;
  }

  async function loadSeries(id: number): Promise<void> {
    const pending = loadingSeries.get(id);
    if (pending) {
      return pending;
    }
    const run = (async () => {
      try {
        const raw = await readFile(seriesPath(id), "utf8");
        const parsed = parseSeries(JSON.parse(raw) as unknown);
        if (parsed?.id === id) {
          series.set(id, parsed);
        }
      } catch {
        // Missing or corrupt cache entries are rebuilt from the arr on demand.
      }
    })().finally(() => loadingSeries.delete(id));
    loadingSeries.set(id, run);
    return run;
  }

  function moviePath(id: number): string {
    return path.join(cacheDir, `movie-${id}.json`);
  }

  function seriesPath(id: number): string {
    return path.join(cacheDir, `series-${id}.json`);
  }

  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(value), "utf8");
    await rename(temporary, filePath);
  }

  return {
    getMovie,
    async putMovie(entry) {
      const next: MovieMetadataCacheEntry = {
        ...entry,
        version: MEDIA_CACHE_VERSION,
        cachedAt: now().toISOString(),
      };
      await writeJson(moviePath(entry.id), next);
      movies.set(entry.id, next);
    },
    getSeries,
    async putSeries(entry) {
      const next: SeriesMetadataCacheEntry = {
        ...entry,
        version: MEDIA_CACHE_VERSION,
        cachedAt: now().toISOString(),
      };
      await writeJson(seriesPath(entry.id), next);
      series.set(entry.id, next);
    },
    async invalidateMovie(id) {
      movies.delete(id);
      await rm(moviePath(id), { force: true });
    },
    async invalidateSeries(id) {
      series.delete(id);
      await rm(seriesPath(id), { force: true });
    },
  };
}

export function movieMetadataEntry(movie: ServarrMovieResource): MovieMetadataCacheEntry | undefined {
  if (movie.id === undefined) {
    return undefined;
  }
  const metadata = movieMetadata(movie);
  const title = metadata.title?.trim();
  if (!title) {
    return undefined;
  }
  return {
    version: MEDIA_CACHE_VERSION,
    kind: "movie",
    id: movie.id,
    title,
    ...(metadata.year !== undefined ? { year: metadata.year } : {}),
    ...(metadata.tmdbId !== undefined ? { tmdbId: metadata.tmdbId } : {}),
    ...(metadata.imdbId !== undefined ? { imdbId: metadata.imdbId } : {}),
    ...(metadata.overview !== undefined ? { overview: metadata.overview } : {}),
    ...(metadata.network !== undefined ? { network: metadata.network } : {}),
    ...(metadata.rating !== undefined ? { rating: metadata.rating } : {}),
    ...(metadata.runtimeMinutes !== undefined
      ? { runtimeMinutes: metadata.runtimeMinutes }
      : {}),
    ...(metadata.imageUrl !== undefined ? { imageUrl: metadata.imageUrl } : {}),
    cachedAt: new Date().toISOString(),
  };
}

export function seriesMetadataEntry(
  series: ServarrSeriesResource,
): SeriesMetadataCacheEntry | undefined {
  if (series.id === undefined) {
    return undefined;
  }
  const metadata = seriesMetadata(series);
  const title = metadata.title?.trim();
  if (!title) {
    return undefined;
  }
  const completeSeasons = completeSeasonNumbers(series.seasons);
  return {
    version: MEDIA_CACHE_VERSION,
    kind: "series",
    id: series.id,
    title,
    ...(metadata.year !== undefined ? { year: metadata.year } : {}),
    ...(metadata.tvdbId !== undefined ? { tvdbId: metadata.tvdbId } : {}),
    ...(metadata.tmdbId !== undefined ? { tmdbId: metadata.tmdbId } : {}),
    ...(metadata.imdbId !== undefined ? { imdbId: metadata.imdbId } : {}),
    ...(metadata.overview !== undefined ? { overview: metadata.overview } : {}),
    ...(metadata.network !== undefined ? { network: metadata.network } : {}),
    ...(metadata.rating !== undefined ? { rating: metadata.rating } : {}),
    ...(metadata.imageUrl !== undefined ? { imageUrl: metadata.imageUrl } : {}),
    seasons: regularSeasons(series.seasons),
    ...(completeSeasons.length > 0 ? { completeSeasons } : {}),
    cachedAt: new Date().toISOString(),
  };
}

function regularSeasons(seasons: ServarrSeriesResource["seasons"]): number[] {
  return [...new Set((seasons ?? []).map((season) => season.seasonNumber))]
    .filter((season) => Number.isInteger(season) && season > 0)
    .sort((left, right) => left - right);
}

function completeSeasonNumbers(seasons: ServarrSeriesResource["seasons"]): number[] {
  return [...new Set(
    (seasons ?? [])
      .filter((season) => {
        const total = season.statistics?.totalEpisodeCount ?? season.statistics?.episodeCount;
        const files = season.statistics?.episodeFileCount;
        return (
          Number.isInteger(season.seasonNumber) &&
          season.seasonNumber > 0 &&
          total !== undefined &&
          total > 0 &&
          (files ?? 0) >= total
        );
      })
      .map((season) => season.seasonNumber),
  )].sort((left, right) => left - right);
}

function parseMovie(value: unknown): MovieMetadataCacheEntry | undefined {
  if (!isRecord(value) || value.version !== MEDIA_CACHE_VERSION || value.kind !== "movie") {
    return undefined;
  }
  if (typeof value.id !== "number" || typeof value.title !== "string") {
    return undefined;
  }
  return value as unknown as MovieMetadataCacheEntry;
}

function parseSeries(value: unknown): SeriesMetadataCacheEntry | undefined {
  if (!isRecord(value) || value.version !== MEDIA_CACHE_VERSION || value.kind !== "series") {
    return undefined;
  }
  if (
    typeof value.id !== "number" ||
    typeof value.title !== "string" ||
    !Array.isArray(value.seasons)
  ) {
    return undefined;
  }
  return value as unknown as SeriesMetadataCacheEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
