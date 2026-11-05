import type { FastifyInstance } from "fastify";

import {
  serviceUrlForRequest,
  type AppConfig,
  type ServiceConfig,
  type ServiceId,
} from "../config.js";
import { isUnauthorized, UpstreamError } from "../errors.js";
import type { ServiceState, ServiceStatus, StatusResponse } from "../types.js";
import { createJellyfinClient } from "../upstream/jellyfin.js";
import { createArrClient } from "../upstream/servarr.js";

export function registerStatusRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/status", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const checkedAt = new Date().toISOString();
    const probed = await Promise.all([
      probeJellyfin(config.services.jellyfin, config.requestTimeoutMs),
      probeArr("sonarr", config.services.sonarr, config.requestTimeoutMs),
      probeArr("radarr", config.services.radarr, config.requestTimeoutMs),
    ]);
    // Health checks run against the internal URLs; the browser gets an address
    // it can actually reach (LAN, tailnet or MagicDNS host).
    const services = probed.map((service) => ({
      ...service,
      url: serviceUrlForRequest(config, service.id, request.headers),
    }));
    const response: StatusResponse = { checkedAt, services };
    return response;
  });
}

async function probeJellyfin(service: ServiceConfig, timeoutMs: number): Promise<ServiceStatus> {
  const started = Date.now();
  const client = createJellyfinClient(service, timeoutMs);
  let publicInfo;
  try {
    publicInfo = await client.getPublicInfo();
  } catch (error) {
    return failedStatus("jellyfin", service, error, started);
  }

  const base: ServiceStatus = {
    id: "jellyfin",
    name: service.name,
    url: service.url,
    state: "ok",
    version: publicInfo.Version,
    latencyMs: Date.now() - started,
  };

  if (publicInfo.StartupWizardCompleted === false) {
    return {
      ...base,
      state: "unconfigured",
      detail: "Jellyfin first-run setup is not complete",
    };
  }

  if (!service.apiKey) {
    return {
      ...base,
      state: "unconfigured",
      detail: "Set JELLYFIN_API_KEY in server/.env to enable the library",
    };
  }

  try {
    await client.getSystemInfo();
    return { ...base, latencyMs: Date.now() - started };
  } catch (error) {
    return failedStatus("jellyfin", service, error, started, base.version);
  }
}

async function probeArr(
  id: Extract<ServiceId, "sonarr" | "radarr">,
  service: ServiceConfig,
  timeoutMs: number,
): Promise<ServiceStatus> {
  const started = Date.now();
  if (!service.apiKey) {
    return {
      id,
      name: service.name,
      url: service.url,
      state: "unconfigured",
      detail: `API key not found; set ${id.toUpperCase()}_API_KEY or keep server/config/${id}/config.xml`,
    };
  }

  try {
    const status = await createArrClient(id, service, timeoutMs).getSystemStatus();
    return {
      id,
      name: service.name,
      url: service.url,
      state: "ok",
      version: status.version,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return failedStatus(id, service, error, started);
  }
}

function failedStatus(
  id: ServiceId,
  service: ServiceConfig,
  error: unknown,
  started: number,
  version?: string,
): ServiceStatus {
  const state: ServiceState = isUnauthorized(error) ? "unauthorized" : "unreachable";
  return {
    id,
    name: service.name,
    url: service.url,
    state,
    version,
    detail: errorMessage(error),
    latencyMs: Date.now() - started,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof UpstreamError) {
    return error.message;
  }
  return "Service check failed";
}
