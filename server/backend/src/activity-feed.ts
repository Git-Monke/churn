import type { AppConfig, QbittorrentConfig } from "./config.js";
import {
  buildActivityItem,
  buildMovieActivityItem,
  buildSeriesActivityItem,
  filterActiveQueueRecords,
} from "./activity.js";
import { applyTorrentProgress, indexTorrents, type TorrentIndex } from "./torrent-progress.js";
import type { ActivityItem, ActivityResponse, ActivityServiceState } from "./types.js";
import { errorMessage, stateForError } from "./upstream/states.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrMovieResource,
  type ServarrQueueRecord,
  type ServarrSeriesResource,
} from "./upstream/servarr.js";
import { createQbittorrentClient } from "./upstream/qbittorrent.js";

interface ServiceActivity {
  items: ActivityItem[];
  status: ActivityServiceState;
}

interface LoadedQueue {
  records: ServarrQueueRecord[];
  status: ActivityServiceState;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface ActivityFeedOptions {
  now?: () => number;
  /** How long a whole activity snapshot is reused before re-reading the queues. */
  snapshotTtlMs?: number;
  /** How long series/movie metadata is reused. Artwork and titles rarely change. */
  metadataTtlMs?: number;
}

export interface ActivityFeed {
  get(): Promise<ActivityResponse>;
}

/**
 * The UI polls this frequently, so requests need to be cheap. A snapshot cache
 * coalesces every browser tab into one upstream refresh, and the metadata cache
 * removes the per-title requests that used to run on every poll.
 */
const DEFAULT_SNAPSHOT_TTL_MS = 400;
const DEFAULT_METADATA_TTL_MS = 5 * 60_000;

export function createActivityFeed(
  config: AppConfig,
  options: ActivityFeedOptions = {},
): ActivityFeed {
  const now = options.now ?? Date.now;
  const snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const metadata = new MetadataCache(now, options.metadataTtlMs ?? DEFAULT_METADATA_TTL_MS);

  let snapshot: CacheEntry<ActivityResponse> | undefined;
  let inFlight: Promise<ActivityResponse> | undefined;

  async function load(): Promise<ActivityResponse> {
    const [sonarrQueue, radarrQueue, torrents] = await Promise.all([
      loadQueue("sonarr", config.services.sonarr, config.requestTimeoutMs),
      loadQueue("radarr", config.services.radarr, config.requestTimeoutMs),
      loadQbittorrent(config.qbittorrent, config.requestTimeoutMs),
    ]);
    const [sonarr, radarr] = await Promise.all([
      mapQueueActivity("sonarr", config, sonarrQueue, torrents, metadata),
      mapQueueActivity("radarr", config, radarrQueue, torrents, metadata),
    ]);
    const items = [...sonarr.items, ...radarr.items];

    return {
      checkedAt: new Date(now()).toISOString(),
      services: [sonarr.status, radarr.status],
      items,
      total: items.length,
    };
  }

  return {
    get(): Promise<ActivityResponse> {
      if (snapshot && now() < snapshot.expiresAt) {
        return Promise.resolve(snapshot.value);
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = load()
        .then((response) => {
          snapshot = { value: response, expiresAt: now() + snapshotTtlMs };
          return response;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}

async function loadQueue(
  id: ArrServiceId,
  service: AppConfig["services"][ArrServiceId],
  timeoutMs: number,
): Promise<LoadedQueue> {
  if (!service.apiKey) {
    return { records: [], status: failedStatus(id, "unconfigured", unconfiguredDetail(id)) };
  }

  const client = createArrClient(id, service, timeoutMs);
  try {
    const active = filterActiveQueueRecords(await client.getQueue());
    return { records: active, status: { id, state: "ok", count: active.length } };
  } catch (error) {
    return { records: [], status: failedStatus(id, stateForError(error), errorMessage(error)) };
  }
}

/** qBittorrent is optional: a missing key or a failed request just disables the overlay. */
async function loadQbittorrent(
  config: QbittorrentConfig,
  timeoutMs: number,
): Promise<TorrentIndex> {
  if (!config.apiKey) {
    return new Map();
  }
  try {
    const client = createQbittorrentClient(config, Math.min(timeoutMs, 2000));
    return indexTorrents(await client.getTorrents());
  } catch {
    return new Map();
  }
}

async function mapQueueActivity(
  id: ArrServiceId,
  config: AppConfig,
  queue: LoadedQueue,
  torrents: TorrentIndex,
  metadata: MetadataCache,
): Promise<ServiceActivity> {
  if (queue.status.state !== "ok") {
    return { items: [], status: queue.status };
  }

  const client = createArrClient(id, config.services[id], config.requestTimeoutMs);
  const records = applyTorrentProgress(queue.records, torrents);
  const items =
    id === "sonarr"
      ? await mapSeriesActivity(client, records, metadata)
      : await mapMovieActivity(client, records, metadata);
  return { items, status: queue.status };
}

function failedStatus(
  id: ArrServiceId,
  state: ActivityServiceState["state"],
  detail: string,
): ActivityServiceState {
  return { id, state, detail, count: 0 };
}

async function mapSeriesActivity(
  client: ReturnType<typeof createArrClient>,
  records: ServarrQueueRecord[],
  metadata: MetadataCache,
): Promise<ActivityItem[]> {
  const { known, unknown } = groupRecords(records, "seriesId");
  const details = await loadMetadata("sonarr", [...known.keys()], (id) => client.getSeries(id), metadata);
  const items: ActivityItem[] = [];

  for (const [id, group] of known) {
    const item = buildSeriesActivityItem(id, group, details.get(id));
    if (item) {
      items.push(item);
    }
  }
  for (const record of unknown) {
    const item = buildActivityItem({
      service: "sonarr",
      kind: "series",
      key: `series:sonarr:queue:${record.id ?? "unknown"}`,
      records: [record],
    });
    if (item) {
      items.push(item);
    }
  }
  return items;
}

async function mapMovieActivity(
  client: ReturnType<typeof createArrClient>,
  records: ServarrQueueRecord[],
  metadata: MetadataCache,
): Promise<ActivityItem[]> {
  const { known, unknown } = groupRecords(records, "movieId");
  const details = await loadMetadata("radarr", [...known.keys()], (id) => client.getMovie(id), metadata);
  const items: ActivityItem[] = [];

  for (const [id, group] of known) {
    const item = buildMovieActivityItem(id, group, details.get(id));
    if (item) {
      items.push(item);
    }
  }
  for (const record of unknown) {
    const item = buildActivityItem({
      service: "radarr",
      kind: "movie",
      key: `movie:radarr:queue:${record.id ?? "unknown"}`,
      records: [record],
    });
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function groupRecords(
  records: ServarrQueueRecord[],
  key: "seriesId" | "movieId",
): { known: Map<number, ServarrQueueRecord[]>; unknown: ServarrQueueRecord[] } {
  const known = new Map<number, ServarrQueueRecord[]>();
  const unknown: ServarrQueueRecord[] = [];
  for (const record of records) {
    const id = record[key];
    if (id === undefined) {
      unknown.push(record);
      continue;
    }
    const group = known.get(id);
    if (group) {
      group.push(record);
    } else {
      known.set(id, [record]);
    }
  }
  return { known, unknown };
}

async function loadMetadata<T extends ServarrSeriesResource | ServarrMovieResource>(
  service: ArrServiceId,
  ids: number[],
  load: (id: number) => Promise<T>,
  cache: MetadataCache,
): Promise<Map<number, T>> {
  const metadata = new Map<number, T>();
  const missing: number[] = [];
  for (const id of ids) {
    const cached = cache.get<T>(service, id);
    if (cached) {
      metadata.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) {
    return metadata;
  }

  const results = await Promise.allSettled(missing.map((id) => load(id)));
  results.forEach((result, index) => {
    const id = missing[index];
    if (result.status === "fulfilled" && id !== undefined) {
      metadata.set(id, result.value);
      cache.set(service, id, result.value);
    }
  });
  return metadata;
}

function unconfiguredDetail(id: ArrServiceId): string {
  return `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`;
}

type MetadataValue = ServarrSeriesResource | ServarrMovieResource;

class MetadataCache {
  private readonly entries = new Map<string, CacheEntry<MetadataValue>>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  get<T extends MetadataValue>(service: ArrServiceId, id: number): T | undefined {
    const entry = this.entries.get(`${service}:${id}`);
    if (!entry) {
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(`${service}:${id}`);
      return undefined;
    }
    return entry.value as T;
  }

  set(service: ArrServiceId, id: number, value: MetadataValue): void {
    this.entries.set(`${service}:${id}`, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }
}
