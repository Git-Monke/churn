import type { FastifyInstance } from "fastify";

import { API_FEATURES, API_VERSIONS, CURRENT_API_VERSION } from "../api-version.js";
import type { HealthResponse, MetaResponse } from "../types.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async (_request, reply): Promise<HealthResponse> => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  // Public, like /api/health: a client checks it before signing in.
  app.get("/api/meta", async (_request, reply): Promise<MetaResponse> => {
    reply.header("cache-control", "no-store");
    return {
      api: { versions: [...API_VERSIONS], current: CURRENT_API_VERSION },
      features: [...API_FEATURES],
    };
  });
}
