import type { JellyfinClient, JellyfinItem } from "./upstream/jellyfin.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SERIES = 100;

export interface NextEpisodeLookupOptions {
  ttlMs?: number;
  maxSeries?: number;
  now?: () => number;
}

/**
 * Series episode lists change rarely and are only used for ordering. Cache
 * them per process and coalesce concurrent lookups for the same series.
 * Failures are not cached, so a transient Jellyfin error does not hide the
 * up-next prompt for the next minute.
 */
export function createNextEpisodeLookup(
  options: NextEpisodeLookupOptions = {},
): (client: JellyfinClient, seriesId: string) => Promise<JellyfinItem[] | undefined> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { episodes: JellyfinItem[]; fetchedAt: number }>();
  const pending = new Map<string, Promise<JellyfinItem[] | undefined>>();

  return async function getSeriesEpisodes(client, seriesId) {
    const cached = cache.get(seriesId);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.episodes;
    }
    if (cached) {
      cache.delete(seriesId);
    }

    const inFlight = pending.get(seriesId);
    if (inFlight) {
      return inFlight;
    }

    const request = client
      .getEpisodes(seriesId)
      .then((episodes) => {
        cache.delete(seriesId);
        cache.set(seriesId, { episodes, fetchedAt: now() });
        while (cache.size > maxSeries) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          cache.delete(oldest);
        }
        return episodes;
      })
      .catch(() => undefined)
      .finally(() => {
        pending.delete(seriesId);
      });

    pending.set(seriesId, request);
    return request;
  };
}
