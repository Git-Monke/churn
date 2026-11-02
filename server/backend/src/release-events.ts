export interface ReleaseRepickEvent {
  id: number;
  at: string;
  service: "sonarr" | "radarr";
  /** Title of the movie or series, for the notice banner. */
  mediaTitle: string;
  seasonNumber?: number;
  fromTitle: string;
  toTitle: string;
  /** Seeders the indexer claimed for the release that stalled. */
  fromReportedSeeders?: number;
  /** Actual seeds qBittorrent had connected when churn gave up on it. */
  connectedSeeds?: number;
  /** Bytes/second measured when churn gave up on it. */
  downloadSpeed?: number;
  toReportedSeeders?: number;
}

export interface ReleaseEventStore {
  record(event: Omit<ReleaseRepickEvent, "id" | "at">): ReleaseRepickEvent;
  /** Newest first, capped at `limit`. */
  list(limit?: number): ReleaseRepickEvent[];
}

/**
 * Small in-memory ring of recent re-picks. It only exists so the dashboard can
 * explain why a download silently changed releases; nothing depends on it.
 */
export function createReleaseEventStore(maxEntries = 20): ReleaseEventStore {
  const events: ReleaseRepickEvent[] = [];
  let nextId = 1;

  return {
    record(event) {
      const entry: ReleaseRepickEvent = {
        ...event,
        id: nextId++,
        at: new Date().toISOString(),
      };
      events.unshift(entry);
      if (events.length > maxEntries) {
        events.length = maxEntries;
      }
      return entry;
    },
    list(limit = maxEntries) {
      return events.slice(0, limit);
    },
  };
}
