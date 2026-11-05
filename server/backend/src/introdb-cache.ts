import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { IntroDbSegments } from "./introdb.js";

export const INTRODB_CACHE_VERSION = 1;

interface CachedEpisode {
  fetchedAt: string;
  segments: IntroDbSegments;
}

interface IntroDbCacheFile {
  version: typeof INTRODB_CACHE_VERSION;
  imdbId: string;
  episodes: Record<string, CachedEpisode>;
}

export interface IntroDbCache {
  get(
    imdbId: string,
    season: number,
    episode: number,
  ): Promise<IntroDbSegments | undefined>;
  put(
    imdbId: string,
    season: number,
    episode: number,
    segments: IntroDbSegments,
  ): Promise<void>;
}

export interface IntroDbCacheOptions {
  /** Directory for the per-series JSON files, usually `server/cache/introdb`. */
  cacheDir: string;
  now?: () => Date;
}

/**
 * One file per IMDb id, written when a season or episode is grabbed. Playback
 * only reads these files; it never calls IntroDB itself.
 */
export function createIntroDbCache(options: IntroDbCacheOptions): IntroDbCache {
  const { cacheDir } = options;
  const now = options.now ?? (() => new Date());
  const files = new Map<string, IntroDbCacheFile>();
  const loading = new Map<string, Promise<IntroDbCacheFile>>();
  const writing = new Map<string, Promise<void>>();

  function filePath(imdbId: string): string {
    return path.join(cacheDir, `${imdbId}.json`);
  }

  async function load(imdbId: string): Promise<IntroDbCacheFile> {
    const cached = files.get(imdbId);
    if (cached) {
      return cached;
    }
    const pending = loading.get(imdbId);
    if (pending) {
      return pending;
    }

    const promise = readFile(filePath(imdbId), "utf8")
      .then((contents) => parseFile(contents, imdbId))
      .catch(() => emptyFile(imdbId))
      .then((file) => {
        files.set(imdbId, file);
        loading.delete(imdbId);
        return file;
      });
    loading.set(imdbId, promise);
    return promise;
  }

  async function save(imdbId: string, file: IntroDbCacheFile): Promise<void> {
    const previous = writing.get(imdbId) ?? Promise.resolve();
    const next = previous
      .then(() => writeFileAtomically(filePath(imdbId), JSON.stringify(file)))
      .catch((error: unknown) => {
        // A cache write failure must never affect playback or the grab flow.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`introdb cache write failed for ${imdbId}: ${message}`);
      });
    writing.set(imdbId, next);
    await next;
    if (writing.get(imdbId) === next) {
      writing.delete(imdbId);
    }
  }

  return {
    async get(imdbId, season, episode) {
      const file = await load(imdbId);
      return file.episodes[episodeKey(season, episode)]?.segments;
    },

    async put(imdbId, season, episode, segments) {
      const file = await load(imdbId);
      file.episodes[episodeKey(season, episode)] = {
        fetchedAt: now().toISOString(),
        segments,
      };
      await mkdir(cacheDir, { recursive: true });
      await save(imdbId, file);
    },
  };
}

export function episodeKey(season: number, episode: number): string {
  return `s${season}e${episode}`;
}

function emptyFile(imdbId: string): IntroDbCacheFile {
  return { version: INTRODB_CACHE_VERSION, imdbId, episodes: {} };
}

function parseFile(contents: string, imdbId: string): IntroDbCacheFile {
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed) || parsed.version !== INTRODB_CACHE_VERSION) {
    return emptyFile(imdbId);
  }
  if (parsed.imdbId !== imdbId || !isRecord(parsed.episodes)) {
    return emptyFile(imdbId);
  }
  return {
    version: INTRODB_CACHE_VERSION,
    imdbId,
    episodes: parsed.episodes as Record<string, CachedEpisode>,
  };
}

/** Write the file atomically; a partial JSON file would be useless on restart. */
async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
