import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import { ApiError, UpstreamError } from "../errors.js";
import { createVpnClient } from "../upstream/vpn.js";

export function registerVpnRoutes(app: FastifyInstance, config: AppConfig): void {
  const client = createVpnClient(config.vpn);

  app.get("/api/vpn", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return await client.getStatus();
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "invalid_response") {
        throw new ApiError(502, "invalid_response", error.message);
      }
      throw error;
    }
  });
}
