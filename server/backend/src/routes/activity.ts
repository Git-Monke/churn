import type { FastifyInstance } from "fastify";

import { createActivityFeed } from "../activity-feed.js";
import type { AppConfig } from "../config.js";
import type { ReleaseEventStore } from "../release-events.js";

export function registerActivityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  events?: ReleaseEventStore,
): void {
  const feed = createActivityFeed(config);

  app.get("/api/activity", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const response = await feed.get();
    return { ...response, repicks: events?.list(5) ?? [] };
  });
}
