import type { AppConfig } from "./config.js";
import { fetchIntroDbSegments, type IntroDbSegments } from "./introdb.js";
import type { IntroDbCache } from "./introdb-cache.js";
import { seriesMetadataEntry, type MediaCache } from "./media-cache.js";
import { createArrClient } from "./upstream/servarr.js";

export interface IntroDbService {
  /**
   * Warm one episode or every episode of one season. Start it after a grab
   * succeeds and do not await it: the download must not wait for metadata.
   */
  warm(
    seriesId: number,
    seasonNumber: number,
    episodeNumber?: number,
  ): Promise<void>;
  /**
   * Playback lookup. A cache miss warms that one episode on demand, so a
   * season imported before the grab warm-up existed — or one whose cache was
   * lost — still gets segments. The wait is bounded: the fetch continues in
   * the background and a later play reads what it stored.
   */
  segmentsFor(
    imdbId: string,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<IntroDbSegments | undefined>;
}

export interface IntroDbServiceOptions {
  config: AppConfig;
  cache: IntroDbCache;
  mediaCache: MediaCache;
  onWarning?: (message: string) => void;
  /** How long `segmentsFor` waits for an on-demand fetch. */
  onDemandWaitMs?: number;
}

interface EpisodeNumber {
  seasonNumber: number;
  episodeNumber: number;
}

const DEFAULT_ON_DEMAND_WAIT_MS = 2_000;

export function createIntroDbService(
  options: IntroDbServiceOptions,
): IntroDbService {
  const { config, cache, mediaCache } = options;
  const warn = options.onWarning ?? (() => undefined);
  const onDemandWaitMs = options.onDemandWaitMs ?? DEFAULT_ON_DEMAND_WAIT_MS;
  /**
   * One warm per episode or season at a time. Playback retries and the grab
   * warm-up can ask for the same data together; IntroDB reads are rate limited.
   */
  const inFlight = new Map<string, Promise<void>>();

  function once(key: string, run: () => Promise<void>): Promise<void> {
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }
    const promise = run().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function fetchEpisodes(
    imdbId: string,
    episodes: EpisodeNumber[],
  ): Promise<void> {
    // Sequential on purpose: a season is a handful of small requests and this
    // runs in the background while the download is still going.
    for (const episode of episodes) {
      try {
        const segments = await fetchIntroDbSegments(
          config.introdb,
          imdbId,
          episode.seasonNumber,
          episode.episodeNumber,
        );
        // No segments: IntroDB has no data for this episode yet. Not worth a
        // log line per episode, and it is retried the next time it plays.
        if (segments) {
          await cache.put(
            imdbId,
            episode.seasonNumber,
            episode.episodeNumber,
            segments,
          );
        }
      } catch (error) {
        warn(
          `IntroDB lookup failed for ${imdbId} S${episode.seasonNumber}E${episode.episodeNumber}: ${messageOf(error)}`,
        );
      }
    }
  }

  function warm(
    seriesId: number,
    seasonNumber: number,
    episodeNumber?: number,
  ): Promise<void> {
    return once(`series:${seriesId}:${seasonNumber}:${episodeNumber ?? "*"}`, async () => {
      try {
        const imdbId = await resolveImdbId(config, mediaCache, seriesId);
        if (!imdbId) {
          warn(`no IMDb id for Sonarr series ${seriesId}; skipping IntroDB`);
          return;
        }

        const episodes =
          episodeNumber === undefined
            ? await loadSeasonEpisodes(config, seriesId, seasonNumber)
            : [{ seasonNumber, episodeNumber }];
        await fetchEpisodes(imdbId, episodes);
      } catch (error) {
        warn(
          `IntroDB warm-up failed for series ${seriesId}: ${messageOf(error)}`,
        );
      }
    });
  }

  function backfill(
    imdbId: string,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<void> {
    return once(
      `episode:${imdbId}:${seasonNumber}:${episodeNumber}`,
      () =>
        fetchEpisodes(imdbId, [{ seasonNumber, episodeNumber }]).catch(
          (error: unknown) => {
            warn(
              `IntroDB backfill failed for ${imdbId} S${seasonNumber}E${episodeNumber}: ${messageOf(error)}`,
            );
          },
        ),
    );
  }

  return {
    warm,

    async segmentsFor(imdbId, seasonNumber, episodeNumber) {
      const cached = await cache.get(imdbId, seasonNumber, episodeNumber);
      if (cached) {
        return cached;
      }

      const wait = new Promise<void>((resolve) => {
        setTimeout(resolve, onDemandWaitMs).unref();
      });
      await Promise.race([
        backfill(imdbId, seasonNumber, episodeNumber),
        wait,
      ]);
      return cache.get(imdbId, seasonNumber, episodeNumber);
    },
  };
}

async function resolveImdbId(
  config: AppConfig,
  mediaCache: MediaCache,
  seriesId: number,
): Promise<string | undefined> {
  const cached = await mediaCache.getSeries(seriesId);
  if (cached?.imdbId) {
    return cached.imdbId;
  }
  if (!config.services.sonarr.apiKey) {
    return undefined;
  }

  const client = createArrClient(
    "sonarr",
    config.services.sonarr,
    config.requestTimeoutMs,
  );
  const series = await client.getSeries(seriesId);
  const entry = seriesMetadataEntry(series);
  if (!entry) {
    return undefined;
  }
  await mediaCache.putSeries(entry);
  return entry.imdbId;
}

async function loadSeasonEpisodes(
  config: AppConfig,
  seriesId: number,
  seasonNumber: number,
): Promise<EpisodeNumber[]> {
  if (!config.services.sonarr.apiKey) {
    return [];
  }

  const client = createArrClient(
    "sonarr",
    config.services.sonarr,
    config.requestTimeoutMs,
  );
  const episodes = await client.getEpisodes(seriesId);
  const seen = new Set<number>();
  return episodes
    .filter((episode) => {
      const number = episode.episodeNumber;
      if (
        episode.seasonNumber !== seasonNumber ||
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 0 ||
        seen.has(number)
      ) {
        return false;
      }
      seen.add(number);
      return true;
    })
    .map((episode) => ({
      seasonNumber,
      episodeNumber: episode.episodeNumber as number,
    }))
    .sort((left, right) => left.episodeNumber - right.episodeNumber);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
