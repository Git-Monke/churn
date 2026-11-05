import type { FastifyInstance } from "fastify";

import { serviceUrlForRequest, type AppConfig, type ServiceId } from "../config.js";
import { ApiError } from "../errors.js";

const SERVICE_IDS: ServiceId[] = ["jellyfin", "sonarr", "radarr"];

export function registerServiceRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get<{ Params: { id: string } }>("/api/services/:id/open", async (request, reply) => {
    const id = request.params.id as ServiceId;
    if (!SERVICE_IDS.includes(id)) {
      throw new ApiError(404, "unknown_service", `Unknown service: ${request.params.id}`);
    }
    // Redirect to the address the browser can reach, not the internal one.
    const url = serviceUrlForRequest(config, id, request.headers);
    if (!/^https?:\/\//i.test(url)) {
      throw new ApiError(500, "invalid_service_url", `${id} has an invalid URL`);
    }
    return reply.redirect(url, 302);
  });
}
