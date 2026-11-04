import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";
import { mapWithConcurrency } from "./concurrency.js";
import { directDownloadSource } from "./direct-grab.js";
import { UpstreamError } from "./errors.js";
import {
  movieMetadataEntry,
  seriesMetadataEntry,
  type MediaCache,
  type MovieMetadataCacheEntry,
  type SeriesMetadataCacheEntry,
} from "./media-cache.js";
import {
  createReleaseParser,
  releaseCoversEpisode,
  releaseEpisodeLabel,
  releaseMatchesMovie,
  releaseMatchesSeries,
  releaseSearchCategory,
  releaseSearchQuery,
  releaseSeasonLabel,
  type ParsedReleaseName,
} from "./release-name.js";
import { groupShowReleases } from "./releases.js";
import type {
  CachedReleasesResponse,
  ReleaseGroup,
  ReleaseIndexerProgress,
  ReleaseIndexerState,
  ShowRelease,
} from "./types.js";
import { createProwlarrClient, type ProwlarrIndexer } from "./upstream/prowlarr.js";
import {
  createArrClient,
  type ServarrMovieResource,
  type ServarrRelease,
  type ServarrSeriesResource,
} from "./upstream/servarr.js";
import { errorMessage } from "./upstream/states.js";

const SNAPSHOT_VERSION = 2;
const RELEASE_SEARCH_TIMEOUT_MS = 30_000;
const MAX_RETAINED_JOBS = 100;

export type ReleaseSearchTarget =
  | { kind: "movie"; movieId: number }
  | { kind: "series"; seriesId: number; seasonNumber: number };

export interface RawIndexerRelease {
  /** Opaque id exposed to the browser. */
  id: string;
  indexerId: number;
  indexer: string;
  guid: string;
  title: string;
  size: number;
  seeders?: number;
  leechers?: number;
  protocol?: string;
  ageHours?: number;
  publishDate?: string;
  infoHash?: string;
  /** Server-side torrent source; never included in browser responses. */
  downloadUrl?: string;
  magnetUrl?: string;
  parsed: ParsedReleaseName;
}

export interface ReleaseSearchService {
  getMovie(movieId: number): Promise<CachedReleasesResponse>;
  getSeriesSeason(seriesId: number, seasonNumber: number): Promise<CachedReleasesResponse>;
  /** Narrow the cached season search to one episode. */
  getSeriesEpisode(
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<CachedReleasesResponse>;
  refreshMovie(movieId: number): Promise<CachedReleasesResponse>;
  refreshSeriesSeason(seriesId: number, seasonNumber: number): Promise<CachedReleasesResponse>;
  refreshSeriesEpisode(
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<CachedReleasesResponse>;
  /** Start missing background searches without waiting for them. */
  warmMovie(movieId: number): Promise<void>;
  /** Warm missing seasons in ascending order, one at a time. */
  warmSeries(seriesId: number, seasonNumbers: number[]): Promise<void>;
  findRelease(
    target: ReleaseSearchTarget,
    id: string,
  ): Promise<
    | {
        release: RawIndexerRelease;
        media: { title: string; year?: number };
      }
    | undefined
  >;
  invalidateMovie(movieId: number): Promise<void>;
  invalidateSeries(seriesId: number): Promise<void>;
}

interface SearchMedia {
  kind: "movie" | "series";
  id: number;
  title: string;
  year?: number;
}

interface JobIndexer {
  id: number;
  name: string;
  state: ReleaseIndexerState;
  count: number;
  detail?: string;
}

interface SearchJob {
  key: string;
  target: ReleaseSearchTarget;
  media: SearchMedia;
  query: string;
  category: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  indexers: JobIndexer[];
  releasesByIndexer: Map<number, RawIndexerRelease[]>;
  /** Resolves once the job has settled and its snapshot has been written. */
  settled: Promise<void>;
  settle: () => void;
}

interface SeriesWarmQueue {
  seasons: number[];
  running: Promise<void>;
}

interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  kind: "movie" | "series";
  movieId?: number;
  seriesId?: number;
  seasonNumber?: number;
  fetchedAt: string;
  indexers: JobIndexer[];
  releases: RawIndexerRelease[];
}

export interface ReleaseSearchOptions {
  /** Directory for persisted release-search snapshots. */
  cacheDir: string;
  now?: () => Date;
}

export function createReleaseSearchService(
  config: AppConfig,
  mediaCache: MediaCache,
  options: ReleaseSearchOptions,
): ReleaseSearchService {
  const { cacheDir } = options;
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, SearchJob>();
  const startingJobs = new Map<string, Promise<SearchJob>>();
  const seriesWarmQueues = new Map<number, SeriesWarmQueue>();
  const releaseParser = createReleaseParser(config);

  function completion(): Pick<SearchJob, "settled" | "settle"> {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { settled, settle };
  }

  function targetKey(target: ReleaseSearchTarget): string {
    return target.kind === "movie"
      ? `movie:${target.movieId}`
      : `series:${target.seriesId}:${target.seasonNumber}`;
  }

  function targetLabel(target: ReleaseSearchTarget): string {
    return target.kind === "movie" ? `movie-${target.movieId}` : `series-${target.seriesId}/s${target.seasonNumber}`;
  }

  function snapshotPath(target: ReleaseSearchTarget): string {
    return path.join(cacheDir, `${targetLabel(target)}.json`);
  }

  async function loadMedia(target: ReleaseSearchTarget): Promise<SearchMedia> {
    if (target.kind === "movie") {
      const cached = await ensureMovieMedia(target.movieId);
      return { kind: "movie", id: cached.id, title: cached.title, year: cached.year };
    }
    const cached = await ensureSeriesMedia(target.seriesId);
    return { kind: "series", id: cached.id, title: cached.title, year: cached.year };
  }

  async function ensureMovieMedia(movieId: number): Promise<MovieMetadataCacheEntry> {
    const cached = await mediaCache.getMovie(movieId);
    if (cached?.title) {
      return cached;
    }
    const service = config.services.radarr;
    if (!service.apiKey) {
      throw new UpstreamError(
        "radarr",
        "unauthorized",
        "Radarr API key is not configured; movie release search is unavailable",
      );
    }
    const client = createArrClient("radarr", service, config.requestTimeoutMs);
    let movie: ServarrMovieResource;
    try {
      movie = await client.getMovie(movieId);
    } catch (error) {
      throw releaseMediaError(error, "Radarr could not load this movie");
    }
    const entry = movieMetadataEntry(movie);
    if (!entry) {
      throw new UpstreamError("radarr", "invalid_response", "Radarr returned a movie without a title");
    }
    await mediaCache.putMovie(entry);
    return entry;
  }

  async function ensureSeriesMedia(seriesId: number): Promise<SeriesMetadataCacheEntry> {
    const cached = await mediaCache.getSeries(seriesId);
    if (cached?.title) {
      return cached;
    }
    const service = config.services.sonarr;
    if (!service.apiKey) {
      throw new UpstreamError(
        "sonarr",
        "unauthorized",
        "Sonarr API key is not configured; series release search is unavailable",
      );
    }
    const client = createArrClient("sonarr", service, config.requestTimeoutMs);
    let series: ServarrSeriesResource;
    try {
      series = await client.getSeries(seriesId);
    } catch (error) {
      throw releaseMediaError(error, "Sonarr could not load this series");
    }
    const entry = seriesMetadataEntry(series);
    if (!entry) {
      throw new UpstreamError("sonarr", "invalid_response", "Sonarr returned a series without a title");
    }
    await mediaCache.putSeries(entry);
    return entry;
  }

  function buildQuery(target: ReleaseSearchTarget, media: SearchMedia): string {
    return target.kind === "series"
      ? releaseSearchQuery(media, target.seasonNumber)
      : releaseSearchQuery(media);
  }

  function newJob(
    target: ReleaseSearchTarget,
    media: SearchMedia,
    prowlarrIndexers: ProwlarrIndexer[],
    snapshot?: Snapshot,
  ): SearchJob {
    const key = targetKey(target);
    const seeded = new Map<number, RawIndexerRelease[]>();
    for (const release of snapshot?.releases ?? []) {
      const list = seeded.get(release.indexerId);
      if (list) {
        list.push(release);
      } else {
        seeded.set(release.indexerId, [release]);
      }
    }
    return {
      key,
      target,
      media,
      query: buildQuery(target, media),
      category: releaseSearchCategory(target.kind),
      startedAt: now().toISOString(),
      indexers: prowlarrIndexers.map((indexer) => ({
        id: indexer.id as number,
        name: indexer.name?.trim() || `Indexer ${indexer.id}`,
        state: "pending",
        count: seeded.get(indexer.id as number)?.length ?? 0,
      })),
      releasesByIndexer: seeded,
      ...completion(),
    };
  }

  function startJob(
    target: ReleaseSearchTarget,
    seedSnapshot?: Snapshot,
  ): Promise<SearchJob> {
    const key = targetKey(target);
    const previous = jobs.get(key);
    if (previous && previous.completedAt === undefined) {
      return Promise.resolve(previous);
    }
    const starting = startingJobs.get(key);
    if (starting) {
      return starting;
    }
    const run = startJobNow(target, seedSnapshot).finally(() => {
      if (startingJobs.get(key) === run) {
        startingJobs.delete(key);
      }
    });
    startingJobs.set(key, run);
    return run;
  }

  async function startJobNow(
    target: ReleaseSearchTarget,
    seedSnapshot?: Snapshot,
  ): Promise<SearchJob> {
    const key = targetKey(target);
    if (!config.prowlarr.apiKey) {
      const media = await loadMedia(target);
      const job: SearchJob = {
        key,
        target,
        media,
        query: buildQuery(target, media),
        category: releaseSearchCategory(target.kind),
        startedAt: now().toISOString(),
        indexers: seedSnapshot?.indexers ?? [],
        releasesByIndexer: snapshotReleases(seedSnapshot),
        error:
          "Prowlarr API key is not configured. Set PROWLARR_API_KEY or keep torrent/config/prowlarr/config.xml.",
        ...completion(),
      };
      job.completedAt = now().toISOString();
      job.settle();
      jobs.set(key, job);
      pruneJobs();
      return job;
    }

    const [media, prowlarrCatalog] = await Promise.all([
      loadMedia(target),
      loadProwlarrIndexers(),
    ]);
    if (prowlarrCatalog.error) {
      const job: SearchJob = {
        key,
        target,
        media,
        query: buildQuery(target, media),
        category: releaseSearchCategory(target.kind),
        startedAt: now().toISOString(),
        indexers: seedSnapshot?.indexers ?? [],
        releasesByIndexer: snapshotReleases(seedSnapshot),
        error: prowlarrCatalog.error,
        ...completion(),
      };
      job.completedAt = now().toISOString();
      job.settle();
      jobs.set(key, job);
      pruneJobs();
      return job;
    }

    const job = newJob(target, media, prowlarrCatalog.indexers, seedSnapshot);
    jobs.set(key, job);
    pruneJobs();
    if (job.indexers.length === 0) {
      job.completedAt = now().toISOString();
      job.error = "Prowlarr has no enabled indexers.";
      try {
        await persist(job);
      } catch {
        // Keep the in-memory job usable even if the snapshot cannot be written.
      } finally {
        job.settle();
      }
      return job;
    }

    const prowlarr = createProwlarrClient(
      config.prowlarr,
      Math.max(config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
    );
    void Promise.all(
      job.indexers.map((indexer) => runIndexer(job, indexer, prowlarr.searchIndexer.bind(prowlarr))),
    ).catch(() => {
      // Individual indexer failures are recorded on the job. Persistence
      // failures must not leave the completion promise pending forever.
      job.settle();
    });
    return job;
  }

  async function runIndexer(
    job: SearchJob,
    indexer: JobIndexer,
    search: (id: number, query: string, options: { categories: string }) => Promise<unknown[]>,
  ): Promise<void> {
    indexer.state = "searching";
    try {
      const raw = await search(indexer.id, job.query, { categories: job.category });
      const releases = (
        await mapWithConcurrency(raw, 8, (entry) =>
          normalizeRelease(entry, job.target, job.media, indexer),
        )
      ).filter((entry): entry is RawIndexerRelease => entry !== null);
      job.releasesByIndexer.set(indexer.id, releases);
      indexer.count = releases.length;
      indexer.state = "finished";
      indexer.detail = undefined;
    } catch (error) {
      indexer.state = "error";
      indexer.detail = errorMessage(error);
    }
    if (job.completedAt === undefined && job.indexers.every(isSettled)) {
      await finishJob(job);
    }
  }

  async function finishJob(job: SearchJob): Promise<void> {
    if (jobs.get(job.key) !== job || job.completedAt !== undefined) {
      return;
    }
    job.completedAt = now().toISOString();
    try {
      await persist(job);
    } catch {
      // Results remain available in memory; a later refresh can rewrite the
      // snapshot.
    } finally {
      job.settle();
    }
  }

  async function persist(job: SearchJob): Promise<void> {
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      kind: job.target.kind,
      ...(job.target.kind === "movie"
        ? { movieId: job.target.movieId }
        : { seriesId: job.target.seriesId, seasonNumber: job.target.seasonNumber }),
      fetchedAt: job.completedAt ?? job.startedAt,
      indexers: job.indexers,
      releases: [...job.releasesByIndexer.values()].flat(),
    };
    const filePath = snapshotPath(job.target);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, filePath);
  }

  async function loadSnapshot(target: ReleaseSearchTarget): Promise<Snapshot | undefined> {
    try {
      const raw = await readFile(snapshotPath(target), "utf8");
      return parseSnapshot(JSON.parse(raw) as unknown, target);
    } catch {
      return undefined;
    }
  }

  function jobFromSnapshot(target: ReleaseSearchTarget, snapshot: Snapshot): SearchJob {
    const media = {
      kind: target.kind,
      id: target.kind === "movie" ? target.movieId : target.seriesId,
      title: "",
    } satisfies SearchMedia;
    const completed = completion();
    completed.settle();
    return {
      key: targetKey(target),
      target,
      media,
      query: "",
      category: releaseSearchCategory(target.kind),
      startedAt: snapshot.fetchedAt,
      completedAt: snapshot.fetchedAt,
      indexers: snapshot.indexers,
      releasesByIndexer: snapshotReleases(snapshot),
      ...completed,
    };
  }

  async function getJob(target: ReleaseSearchTarget): Promise<SearchJob> {
    const key = targetKey(target);
    const existing = jobs.get(key);
    if (existing) {
      return existing;
    }
    const snapshot = await loadSnapshot(target);
    if (snapshot) {
      const job = jobFromSnapshot(target, snapshot);
      jobs.set(key, job);
      pruneJobs();
      return job;
    }
    return startJob(target);
  }

  async function get(target: ReleaseSearchTarget): Promise<CachedReleasesResponse> {
    return buildResponse(await getJob(target));
  }

  async function refresh(
    target: ReleaseSearchTarget,
    episodeNumber?: number,
  ): Promise<CachedReleasesResponse> {
    const key = targetKey(target);
    const existing = jobs.get(key);
    if (existing && existing.completedAt === undefined) {
      return buildResponse(existing, episodeNumber);
    }
    const snapshot = existing ? undefined : await loadSnapshot(target);
    const job = await startJob(target, snapshot);
    return buildResponse(job, episodeNumber);
  }

  function buildResponse(
    job: SearchJob,
    episodeNumber?: number,
  ): CachedReleasesResponse {
    const mapped = mapJobReleases(job, episodeNumber);
    const groups = groupShowReleases(mapped, { includeUnavailable: true });
    const progress = buildProgress(job, episodeNumber);
    const allSettled = job.indexers.length > 0 && job.indexers.every(isSettled);
    const allFailed =
      allSettled && job.indexers.every((indexer) => indexer.state === "error");
    const state: CachedReleasesResponse["state"] = job.error
      ? "error"
      : allSettled
        ? allFailed && mapped.length === 0
          ? "error"
          : "ready"
        : "searching";
    const detail =
      job.error ??
      (state === "error"
        ? job.indexers.find((indexer) => indexer.detail)?.detail ??
          "No indexer returned a usable release."
        : undefined);

    return {
      kind: job.target.kind === "movie" ? "movie" : "series-season",
      service: job.target.kind === "movie" ? "radarr" : "sonarr",
      targetId: job.target.kind === "movie" ? job.target.movieId : job.target.seriesId,
      ...(job.target.kind === "series" ? { seasonNumber: job.target.seasonNumber } : {}),
      ...(episodeNumber === undefined ? {} : { episodeNumber }),
      state,
      refreshing: job.completedAt === undefined,
      ...(detail ? { detail } : {}),
      ...(job.completedAt ? { fetchedAt: job.completedAt } : { fetchedAt: job.startedAt }),
      releaseCount: groups.reduce((total, group) => total + group.releases.length, 0),
      groups,
      progress,
    };
  }

  function mapJobReleases(job: SearchJob, episodeNumber?: number): ShowRelease[] {
    const indexers = new Map(job.indexers.map((indexer) => [indexer.id, indexer]));
    const deduped = new Map<string, { release: RawIndexerRelease; indexer: JobIndexer }>();
    for (const release of [...job.releasesByIndexer.values()].flat()) {
      const indexer = indexers.get(release.indexerId);
      if (!indexer) {
        continue;
      }
      if (
        episodeNumber !== undefined &&
        !releaseCoversEpisode(release.parsed, episodeNumber)
      ) {
        continue;
      }
      const key = release.infoHash?.toLowerCase() || `${release.indexerId}:${release.guid}`;
      const existing = deduped.get(key);
      if (!existing || (release.seeders ?? 0) > (existing.release.seeders ?? 0)) {
        deduped.set(key, { release, indexer });
      }
    }

    return [...deduped.values()].map(({ release, indexer }) =>
      mapRelease(release, indexer, job),
    );
  }

  function mapRelease(
    release: RawIndexerRelease,
    indexer: JobIndexer,
    job: SearchJob,
  ): ShowRelease {
    const canGrab = directDownloadSource(release) !== undefined;
    const downloadDetail = canGrab
      ? undefined
      : "This result does not include a torrent or magnet URL. Refresh the search to try again.";
    return {
      id: release.id,
      title: release.title,
      indexer: release.indexer,
      sizeBytes: release.size,
      ...(release.parsed.quality ? { quality: release.parsed.quality } : {}),
      ...(release.parsed.tier !== undefined
        ? { tier: release.parsed.tier, tierLabel: release.parsed.quality }
        : {}),
      seasonLabel: releaseSeasonLabel(release.parsed),
      ...(releaseEpisodeLabel(release.parsed)
        ? { episodeLabel: releaseEpisodeLabel(release.parsed) }
        : {}),
      multiSeason: release.parsed.seasonNumbers.length > 1,
      approved: true,
      canGrab,
      recommended: false,
      rejections: [],
      mappedEpisodeCount: release.parsed.episodeNumbers.length,
      ...(release.protocol === "torrent" || release.protocol === "usenet"
        ? { protocol: release.protocol }
        : {}),
      ...(release.seeders !== undefined ? { seeders: release.seeders } : {}),
      ...(release.leechers !== undefined ? { leechers: release.leechers } : {}),
      ...(release.ageHours !== undefined ? { ageHours: release.ageHours } : {}),
      ...(release.publishDate ? { publishDate: release.publishDate } : {}),
      ...(job.target.kind === "series"
        ? { searchSeasonNumber: job.target.seasonNumber }
        : {}),
      ...(downloadDetail ? { downloadDetail } : {}),
    };
  }

  function buildProgress(
    job: SearchJob,
    episodeNumber?: number,
  ): NonNullable<CachedReleasesResponse["progress"]> {
    const indexers: ReleaseIndexerProgress[] = job.indexers.map((indexer) => ({
      id: indexer.id,
      name: indexer.name,
      state: indexer.state,
      count:
        episodeNumber === undefined
          ? indexer.count
          : (job.releasesByIndexer.get(indexer.id) ?? []).filter((release) =>
              releaseCoversEpisode(release.parsed, episodeNumber),
            ).length,
      canGrab: true,
      ...(indexer.detail ? { detail: indexer.detail } : {}),
    }));
    return {
      finished: job.indexers.filter(isSettled).length,
      total: job.indexers.length,
      indexers,
    };
  }

  async function findRelease(
    target: ReleaseSearchTarget,
    id: string,
  ): Promise<
    | {
        release: RawIndexerRelease;
        media: { title: string; year?: number };
      }
    | undefined
  > {
    const key = targetKey(target);
    let job = jobs.get(key);
    if (!job) {
      const snapshot = await loadSnapshot(target);
      if (snapshot) {
        job = jobFromSnapshot(target, snapshot);
        jobs.set(key, job);
      }
    }
    if (!job) {
      return undefined;
    }
    for (const release of [...job.releasesByIndexer.values()].flat()) {
      if (release.id !== id) {
        continue;
      }
      let media: SearchMedia = job.media;
      if (!media.title) {
        try {
          media = await loadMedia(target);
        } catch {
          media = { ...media, title: release.title };
        }
      }
      return {
        release,
        media: {
          title: media.title,
          ...(media.year !== undefined ? { year: media.year } : {}),
        },
      };
    }
    return undefined;
  }

  function pruneJobs(): void {
    if (jobs.size <= MAX_RETAINED_JOBS) {
      return;
    }
    const completed = [...jobs.entries()]
      .filter(([, job]) => job.completedAt !== undefined)
      .sort((left, right) =>
        (left[1].completedAt ?? "").localeCompare(right[1].completedAt ?? ""),
      );
    for (const [key] of completed.slice(0, jobs.size - MAX_RETAINED_JOBS)) {
      jobs.delete(key);
    }
  }

  async function invalidateMovie(movieId: number): Promise<void> {
    const target: ReleaseSearchTarget = { kind: "movie", movieId };
    jobs.delete(targetKey(target));
    await Promise.all([
      rm(snapshotPath(target), { force: true }),
      mediaCache.invalidateMovie(movieId),
    ]);
  }

  async function invalidateSeries(seriesId: number): Promise<void> {
    for (const key of [...jobs.keys()]) {
      if (key.startsWith(`series:${seriesId}:`)) {
        jobs.delete(key);
      }
    }
    await Promise.all([
      rm(path.join(cacheDir, `series-${seriesId}`), { recursive: true, force: true }),
      mediaCache.invalidateSeries(seriesId),
    ]);
  }

  async function loadProwlarrIndexers(): Promise<{
    indexers: ProwlarrIndexer[];
    error?: string;
  }> {
    try {
      const client = createProwlarrClient(config.prowlarr, config.requestTimeoutMs);
      const indexers = (await client.listIndexers()).filter(
        (indexer) => indexer.enable !== false && Number.isInteger(indexer.id),
      );
      return { indexers };
    } catch (error) {
      return {
        indexers: [],
        error: `Prowlarr could not list its indexers: ${errorMessage(error)}`,
      };
    }
  }


  async function warmSeriesSeasons(seriesId: number, seasonNumbers: number[]): Promise<void> {
    const seasons = [...new Set(seasonNumbers)]
      .filter((season) => Number.isInteger(season) && season > 0)
      .sort((left, right) => left - right);
    if (seasons.length === 0) {
      return;
    }

    const existing = seriesWarmQueues.get(seriesId);
    if (existing) {
      const known = new Set(existing.seasons);
      for (const season of seasons) {
        if (!known.has(season)) {
          existing.seasons.push(season);
        }
      }
      existing.seasons.sort((left, right) => left - right);
      await existing.running;
      return;
    }

    const queue: SeriesWarmQueue = {
      seasons,
      running: Promise.resolve(),
    };
    seriesWarmQueues.set(seriesId, queue);
    queue.running = runSeriesWarmQueue(seriesId, queue).finally(() => {
      if (seriesWarmQueues.get(seriesId) === queue) {
        seriesWarmQueues.delete(seriesId);
      }
    });
    await queue.running;
  }

  async function runSeriesWarmQueue(
    seriesId: number,
    queue: SeriesWarmQueue,
  ): Promise<void> {
    // Load the series once here so a cold media cache still knows which seasons
    // are already complete and can skip their searches.
    const cached = await ensureSeriesMedia(seriesId).catch(() => undefined);
    const complete = new Set(cached?.completeSeasons ?? []);
    queue.seasons = queue.seasons.filter((season) => !complete.has(season));

    while (queue.seasons.length > 0) {
      const seasonNumber = queue.seasons.shift() as number;
      const target: ReleaseSearchTarget = { kind: "series", seriesId, seasonNumber };
      const key = targetKey(target);
      const existing = jobs.get(key);
      if (existing) {
        if (existing.completedAt === undefined) {
          await existing.settled;
        }
        continue;
      }
      if (await loadSnapshot(target)) {
        continue;
      }
      try {
        const job = await startJob(target);
        await job.settled;
      } catch {
        // One season failing must not stop the queue from reaching later
        // seasons. The next explicit request will retry it.
      }
    }
  }

  return {
    getMovie(movieId) {
      return get({ kind: "movie", movieId });
    },
    getSeriesSeason(seriesId, seasonNumber) {
      return get({ kind: "series", seriesId, seasonNumber });
    },
    async getSeriesEpisode(seriesId, seasonNumber, episodeNumber) {
      const target: ReleaseSearchTarget = { kind: "series", seriesId, seasonNumber };
      return buildResponse(await getJob(target), episodeNumber);
    },
    refreshMovie: (movieId) => refresh({ kind: "movie", movieId }),
    refreshSeriesSeason: (seriesId, seasonNumber) =>
      refresh({ kind: "series", seriesId, seasonNumber }),
    refreshSeriesEpisode: (seriesId, seasonNumber, episodeNumber) =>
      refresh({ kind: "series", seriesId, seasonNumber }, episodeNumber),
    async warmMovie(movieId) {
      const target: ReleaseSearchTarget = { kind: "movie", movieId };
      if (!jobs.has(targetKey(target))) {
        await startJob(target);
      }
    },
    warmSeries: warmSeriesSeasons,
    findRelease,
    invalidateMovie,
    invalidateSeries,
  };

  function snapshotReleases(snapshot: Snapshot | undefined): Map<number, RawIndexerRelease[]> {
    const releases = new Map<number, RawIndexerRelease[]>();
    for (const release of snapshot?.releases ?? []) {
      const list = releases.get(release.indexerId);
      if (list) {
        list.push(release);
      } else {
        releases.set(release.indexerId, [release]);
      }
    }
    return releases;
  }

  async function normalizeRelease(
    raw: unknown,
    target: ReleaseSearchTarget,
    media: { title: string; year?: number },
    indexer: { id: number; name: string },
  ): Promise<RawIndexerRelease | null> {
    if (!isRecord(raw)) {
      return null;
    }
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const guid = typeof raw.guid === "string" ? raw.guid.trim() : "";
    if (!title || !guid) {
      return null;
    }
    const parsed = await releaseParser.parse(target.kind, title);
    if (!parsed) {
      return null;
    }
    const matches =
      target.kind === "movie"
        ? releaseMatchesMovie(parsed, media)
        : releaseMatchesSeries(parsed, media, target.seasonNumber);
    if (!matches) {
      return null;
    }
    return {
      id: releaseKey(indexer.id, guid),
      indexerId: indexer.id,
      indexer: indexer.name,
      guid,
      title,
      size: finiteNumber(raw.size) ?? 0,
      seeders: nonNegative(raw.seeders),
      leechers: nonNegative(raw.leechers),
      protocol: typeof raw.protocol === "string" ? raw.protocol : undefined,
      ageHours: nonNegative(raw.ageHours),
      publishDate: typeof raw.publishDate === "string" ? raw.publishDate : undefined,
      infoHash: typeof raw.infoHash === "string" ? raw.infoHash : undefined,
      downloadUrl: nonEmptyString(raw.downloadUrl),
      magnetUrl: nonEmptyString(raw.magnetUrl),
      parsed,
    };
  }
}

/** Match a Prowlarr result to the corresponding Sonarr/Radarr release. */
export function findMatchingArrRelease(
  releases: ServarrRelease[],
  candidate: { guid: string; title: string; infoHash?: string },
): ServarrRelease | undefined {
  const guidMatch = releases.find((release) => release.guid === candidate.guid);
  if (guidMatch) {
    return guidMatch;
  }
  const hash = candidate.infoHash?.toLowerCase();
  if (hash) {
    const hashMatch = releases.find((release) =>
      [release.infoHash, release.releaseHash].some(
        (value) => value?.toLowerCase() === hash,
      ),
    );
    if (hashMatch) {
      return hashMatch;
    }
  }
  const title = normalizeTitle(candidate.title);
  return releases.find((release) => normalizeTitle(release.title ?? "") === title);
}



function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isSettled(indexer: JobIndexer): boolean {
  return indexer.state === "finished" || indexer.state === "error";
}

function releaseMediaError(error: unknown, fallback: string): Error {
  if (error instanceof UpstreamError) {
    return new UpstreamError(
      error.service,
      error.kind,
      `${fallback}: ${error.message}`,
      error.status,
    );
  }
  return new Error(`${fallback}: ${errorMessage(error)}`);
}

function releaseKey(indexerId: number, guid: string): string {
  return createHash("sha256")
    .update(`${indexerId}\u0000${guid}`)
    .digest("hex")
    .slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function parseSnapshot(value: unknown, target: ReleaseSearchTarget): Snapshot | undefined {
  if (!isObject(value) || value.version !== SNAPSHOT_VERSION) {
    return undefined;
  }
  if (value.kind !== target.kind) {
    return undefined;
  }
  if (typeof value.fetchedAt !== "string" || !Array.isArray(value.releases)) {
    return undefined;
  }
  const indexers = Array.isArray(value.indexers)
    ? value.indexers.filter(isSnapshotIndexer)
    : [];
  const releases = value.releases.filter(isSnapshotRelease);
  return {
    version: SNAPSHOT_VERSION,
    kind: target.kind,
    ...(target.kind === "movie"
      ? { movieId: target.movieId }
      : { seriesId: target.seriesId, seasonNumber: target.seasonNumber }),
    fetchedAt: value.fetchedAt,
    indexers,
    releases,
  };
}

function isSnapshotIndexer(value: unknown): value is JobIndexer {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    typeof value.name === "string" &&
    (value.state === "pending" ||
      value.state === "searching" ||
      value.state === "finished" ||
      value.state === "error") &&
    typeof value.count === "number"
  );
}

function isSnapshotRelease(value: unknown): value is RawIndexerRelease {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.indexerId === "number" &&
    typeof value.indexer === "string" &&
    typeof value.guid === "string" &&
    typeof value.title === "string" &&
    typeof value.size === "number" &&
    (value.downloadUrl === undefined || typeof value.downloadUrl === "string") &&
    (value.magnetUrl === undefined || typeof value.magnetUrl === "string") &&
    isObject(value.parsed) &&
    Array.isArray((value.parsed as Record<string, unknown>).titleTokens)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
