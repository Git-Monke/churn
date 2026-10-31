import type { FastifyInstance } from "fastify";

import type { AppConfig, ServiceConfig } from "../config.js";
import {
  buildMovieActivityItem,
  buildSeriesActivityItem,
  buildActivityItem,
  filterActiveQueueRecords,
} from "../activity.js";
import type { ActivityItem, ActivityResponse, ActivityServiceState } from "../types.js";
import { errorMessage, stateForError } from "../upstream/states.js";
import {
  createArrClient,
  type ArrServiceId,
  type ServarrMovieResource,
  type ServarrQueueRecord,
  type ServarrSeriesResource,
} from "../upstream/servarr.js";

interface ServiceActivity {
  items: ActivityItem[];
  status: ActivityServiceState;
}

export function registerActivityRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/activity", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const [sonarr, radarr] = await Promise.all([
      loadActivity("sonarr", config.services.sonarr, config.requestTimeoutMs),
      loadActivity("radarr", config.services.radarr, config.requestTimeoutMs),
    ]);
    const items = [...sonarr.items, ...radarr.items];

    const response: ActivityResponse = {
      checkedAt: new Date().toISOString(),
      services: [sonarr.status, radarr.status],
      items,
      total: items.length,
    };
    return response;
  });
}

async function loadActivity(
  id: ArrServiceId,
  service: ServiceConfig,
  timeoutMs: number,
): Promise<ServiceActivity> {
  if (!service.apiKey) {
    return failedActivity(id, "unconfigured", unconfiguredDetail(id));
  }

  const client = createArrClient(id, service, timeoutMs);
  let queue: ServarrQueueRecord[];
  try {
    queue = await client.getQueue();
  } catch (error) {
    return failedActivity(id, stateForError(error), errorMessage(error));
  }

  const active = filterActiveQueueRecords(queue);
  const count = active.length;
  if (id === "sonarr") {
    const items = await mapSeriesActivity(client, active);
    return { items, status: { id, state: "ok", count } };
  }
  const items = await mapMovieActivity(client, active);
  return { items, status: { id, state: "ok", count } };
}

async function mapSeriesActivity(
  client: ReturnType<typeof createArrClient>,
  records: ServarrQueueRecord[],
): Promise<ActivityItem[]> {
  const { known, unknown } = groupRecords(records, "seriesId");
  const metadata = await loadMetadata([...known.keys()], (id) => client.getSeries(id));
  const items: ActivityItem[] = [];

  for (const [id, group] of known) {
    const item = buildSeriesActivityItem(id, group, metadata.get(id));
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
): Promise<ActivityItem[]> {
  const { known, unknown } = groupRecords(records, "movieId");
  const metadata = await loadMetadata([...known.keys()], (id) => client.getMovie(id));
  const items: ActivityItem[] = [];

  for (const [id, group] of known) {
    const item = buildMovieActivityItem(id, group, metadata.get(id));
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
  ids: number[],
  load: (id: number) => Promise<T>,
): Promise<Map<number, T>> {
  const results = await Promise.allSettled(ids.map((id) => load(id)));
  const metadata = new Map<number, T>();
  results.forEach((result, index) => {
    const id = ids[index];
    if (result.status === "fulfilled" && id !== undefined) {
      metadata.set(id, result.value);
    }
  });
  return metadata;
}

function failedActivity(
  id: ArrServiceId,
  state: ActivityServiceState["state"],
  detail: string,
): ServiceActivity {
  return { items: [], status: { id, state, detail, count: 0 } };
}

function unconfiguredDetail(id: ArrServiceId): string {
  return `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`;
}
