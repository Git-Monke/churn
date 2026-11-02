import type { FastifyInstance } from "fastify";

import { createActivityFeed } from "../activity-feed.js";
import type { AppConfig } from "../config.js";

export function registerActivityRoutes(app: FastifyInstance, config: AppConfig): void {
  const feed = createActivityFeed(config);

  app.get("/api/activity", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return feed.get();
  });
}
