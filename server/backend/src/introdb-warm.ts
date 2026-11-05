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
  warmFromGrab(
    seriesId: number,
    seasonNumber: number,
    episodeNumber?: number,
  ): Promise<void>;
  /** Read-only lookup used by the playback route; never calls IntroDB. */
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
}

interface EpisodeNumber {
  seasonNumber: number;
  episodeNumber: number;
}

export function createIntroDbService(
  options: IntroDbServiceOptions,
): IntroDbService {
  const { config, cache, mediaCache } = options;
  const warn = options.onWarning ?? (() => undefined);

  return {
    segmentsFor(imdbId, seasonNumber, episodeNumber) {
      return cache.get(imdbId, seasonNumber, episodeNumber);
    },

    async warmFromGrab(seriesId, seasonNumber, episodeNumber) {
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

        // Sequential on purpose: a season is a handful of small requests and
        // this runs in the background while the download is still going.
        for (const episode of episodes) {
          try {
            const segments = await fetchIntroDbSegments(
              config.introdb,
              imdbId,
              episode.seasonNumber,
              episode.episodeNumber,
            );
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
      } catch (error) {
        warn(`IntroDB warm-up failed for series ${seriesId}: ${messageOf(error)}`);
      }
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
