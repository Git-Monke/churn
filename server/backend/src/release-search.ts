import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";
import { mapWithConcurrency } from "./concurrency.js";
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
  type ServarrIndexer,
  type ServarrMovieResource,
  type ServarrRelease,
  type ServarrSeriesResource,
} from "./upstream/servarr.js";
import { errorMessage } from "./upstream/states.js";

const SNAPSHOT_VERSION = 1;
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
  parsed: ParsedReleaseName;
}

export interface ReleaseSearchService {
  getMovie(movieId: number): Promise<CachedReleasesResponse>;
  getSeriesSeason(seriesId: number, seasonNumber: number): Promise<CachedReleasesResponse>;
  refreshMovie(movieId: number): Promise<CachedReleasesResponse>;
  refreshSeriesSeason(seriesId: number, seasonNumber: number): Promise<CachedReleasesResponse>;
  /** Start missing background searches without waiting for them. */
  warmMovie(movieId: number): Promise<void>;
  warmSeries(seriesId: number, seasonNumbers: number[]): Promise<void>;
  findRelease(
    target: ReleaseSearchTarget,
    id: string,
  ): Promise<{ release: RawIndexerRelease; arrIndexerId?: number } | undefined>;
  resolveArrIndexer(kind: "movie" | "series", indexerName: string): Promise<number | undefined>;
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
  arrIndexerId?: number;
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
  arrIndexersKnown: boolean;
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

interface CachedArrIndexers {
  value: ServarrIndexer[];
  expiresAt: number;
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
  const arrIndexerCache = new Map<"sonarr" | "radarr", CachedArrIndexers>();
  const releaseParser = createReleaseParser(config);

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

  async function loadArrIndexers(kind: "movie" | "series"): Promise<{
    indexers: ServarrIndexer[];
    known: boolean;
  }> {
    const serviceId = kind === "movie" ? "radarr" : "sonarr";
    const cached = arrIndexerCache.get(serviceId);
    if (cached && now().getTime() < cached.expiresAt) {
      return { indexers: cached.value, known: true };
    }
    const service = config.services[serviceId];
    if (!service.apiKey) {
      return { indexers: [], known: false };
    }
    try {
      const client = createArrClient(serviceId, service, config.requestTimeoutMs);
      const indexers = await client.getIndexers();
      arrIndexerCache.set(serviceId, {
        value: indexers,
        expiresAt: now().getTime() + 60_000,
      });
      return { indexers, known: true };
    } catch {
      return { indexers: [], known: false };
    }
  }

  function arrIndexerFor(
    prowlarrName: string,
    arrIndexers: ServarrIndexer[],
  ): number | undefined {
    const wanted = normalizeIndexerName(prowlarrName);
    return arrIndexers.find((indexer) => normalizeIndexerName(indexer.name ?? "") === wanted)?.id;
  }

  function newJob(
    target: ReleaseSearchTarget,
    media: SearchMedia,
    prowlarrIndexers: ProwlarrIndexer[],
    arrIndexers: ServarrIndexer[],
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
        arrIndexerId: arrIndexerFor(indexer.name ?? "", arrIndexers),
      })),
      releasesByIndexer: seeded,
      arrIndexersKnown: true,
    };
  }

  async function startJob(
    target: ReleaseSearchTarget,
    seedSnapshot?: Snapshot,
  ): Promise<SearchJob> {
    const key = targetKey(target);
    const previous = jobs.get(key);
    if (previous && previous.completedAt === undefined) {
      return previous;
    }

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
        arrIndexersKnown: true,
        error:
          "Prowlarr API key is not configured. Set PROWLARR_API_KEY or keep torrent/config/prowlarr/config.xml.",
      };
      jobs.set(key, job);
      pruneJobs();
      return job;
    }

    const [media, prowlarrCatalog, arr] = await Promise.all([
      loadMedia(target),
      loadProwlarrIndexers(),
      loadArrIndexers(target.kind),
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
        arrIndexersKnown: arr.known,
        error: prowlarrCatalog.error,
      };
      jobs.set(key, job);
      pruneJobs();
      return job;
    }

    const job = newJob(target, media, prowlarrCatalog.indexers, arr.indexers, seedSnapshot);
    job.arrIndexersKnown = arr.known;
    jobs.set(key, job);
    pruneJobs();
    if (job.indexers.length === 0) {
      job.completedAt = now().toISOString();
      job.error = "Prowlarr has no enabled indexers.";
      await persist(job);
      return job;
    }

    const prowlarr = createProwlarrClient(
      config.prowlarr,
      Math.max(config.requestTimeoutMs, RELEASE_SEARCH_TIMEOUT_MS),
    );
    void Promise.all(
      job.indexers.map((indexer) => runIndexer(job, indexer, prowlarr.searchIndexer.bind(prowlarr))),
    );
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
    await persist(job);
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
      arrIndexersKnown: true,
    };
  }

  async function get(target: ReleaseSearchTarget): Promise<CachedReleasesResponse> {
    const key = targetKey(target);
    const existing = jobs.get(key);
    if (existing) {
      return buildResponse(existing);
    }
    const snapshot = await loadSnapshot(target);
    if (snapshot) {
      const job = jobFromSnapshot(target, snapshot);
      jobs.set(key, job);
      pruneJobs();
      return buildResponse(job);
    }
    const job = await startJob(target);
    return buildResponse(job);
  }

  async function refresh(target: ReleaseSearchTarget): Promise<CachedReleasesResponse> {
    const key = targetKey(target);
    const existing = jobs.get(key);
    if (existing && existing.completedAt === undefined) {
      return buildResponse(existing);
    }
    const snapshot = existing ? undefined : await loadSnapshot(target);
    const job = await startJob(target, snapshot);
    return buildResponse(job);
  }

  function buildResponse(job: SearchJob): CachedReleasesResponse {
    const mapped = mapJobReleases(job);
    const groups = groupShowReleases(mapped, { includeUnavailable: true });
    const progress = buildProgress(job);
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
      state,
      refreshing: job.completedAt === undefined,
      ...(detail ? { detail } : {}),
      ...(job.completedAt ? { fetchedAt: job.completedAt } : { fetchedAt: job.startedAt }),
      releaseCount: groups.reduce((total, group) => total + group.releases.length, 0),
      groups,
      progress,
    };
  }

  function mapJobReleases(job: SearchJob): ShowRelease[] {
    const indexers = new Map(job.indexers.map((indexer) => [indexer.id, indexer]));
    const deduped = new Map<string, { release: RawIndexerRelease; indexer: JobIndexer }>();
    for (const release of [...job.releasesByIndexer.values()].flat()) {
      const indexer = indexers.get(release.indexerId);
      if (!indexer) {
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
    const canGrab = !job.arrIndexersKnown || indexer.arrIndexerId !== undefined;
    const downloadDetail = canGrab
      ? undefined
      : `This indexer is not synced to ${job.target.kind === "movie" ? "Radarr" : "Sonarr"}. Add it in Prowlarr's app sync to download it.`;
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

  function buildProgress(job: SearchJob): NonNullable<CachedReleasesResponse["progress"]> {
    const indexers: ReleaseIndexerProgress[] = job.indexers.map((indexer) => ({
      id: indexer.id,
      name: indexer.name,
      state: indexer.state,
      count: indexer.count,
      canGrab: !job.arrIndexersKnown || indexer.arrIndexerId !== undefined,
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
  ): Promise<{ release: RawIndexerRelease; arrIndexerId?: number } | undefined> {
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
      const indexer = job.indexers.find((entry) => entry.id === release.indexerId);
      return { release, ...(indexer?.arrIndexerId !== undefined ? { arrIndexerId: indexer.arrIndexerId } : {}) };
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


  return {
    getMovie(movieId) {
      return get({ kind: "movie", movieId });
    },
    getSeriesSeason(seriesId, seasonNumber) {
      return get({ kind: "series", seriesId, seasonNumber });
    },
    refreshMovie: (movieId) => refresh({ kind: "movie", movieId }),
    refreshSeriesSeason: (seriesId, seasonNumber) =>
      refresh({ kind: "series", seriesId, seasonNumber }),
    async warmMovie(movieId) {
      const target: ReleaseSearchTarget = { kind: "movie", movieId };
      if (!jobs.has(targetKey(target))) {
        await startJob(target);
      }
    },
    async warmSeries(seriesId, seasonNumbers) {
      const seasons = [...new Set(seasonNumbers)]
        .filter((season) => Number.isInteger(season) && season > 0)
        .sort((left, right) => left - right);
      for (const seasonNumber of seasons) {
        const target: ReleaseSearchTarget = { kind: "series", seriesId, seasonNumber };
        if (!jobs.has(targetKey(target))) {
          await startJob(target);
        }
      }
    },
    findRelease,
    async resolveArrIndexer(kind, indexerName) {
      const arr = await loadArrIndexers(kind);
      return arrIndexerFor(indexerName, arr.indexers);
    },
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

function normalizeIndexerName(name: string): string {
  return name
    .replace(/\(prowlarr\)/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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
    isObject(value.parsed) &&
    Array.isArray((value.parsed as Record<string, unknown>).titleTokens)
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
