import type { ServiceConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson } from "../http.js";

export interface ServarrSystemStatus {
  appName?: string;
  instanceName?: string;
  version?: string;
}

export type ArrServiceId = "sonarr" | "radarr";

export function createArrClient(service: ArrServiceId, config: ServiceConfig, timeoutMs: number) {
  return {
    async getSystemStatus(): Promise<ServarrSystemStatus> {
      if (!config.apiKey) {
        throw new UpstreamError(service, "unauthorized", `${service} API key is not configured`);
      }
      return fetchJson<ServarrSystemStatus>(
        service,
        `${config.url}/api/v3/system/status`,
        { timeoutMs, headers: { "X-Api-Key": config.apiKey } },
      );
    },
  };
}

export type ArrClient = ReturnType<typeof createArrClient>;
