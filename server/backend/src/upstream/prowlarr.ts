import type { ProwlarrConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson } from "../http.js";

export interface ProwlarrIndexer {
  id?: number;
  name?: string;
  enable?: boolean;
  protocol?: string;
  privacy?: string;
}

export interface ProwlarrCategory {
  id?: number;
  name?: string;
}

export interface ProwlarrRelease {
  guid?: string;
  title?: string;
  size?: number;
  indexerId?: number;
  indexer?: string;
  protocol?: string;
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  publishDate?: string;
  infoHash?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  categories?: ProwlarrCategory[];
}

export interface ProwlarrSearchOptions {
  /** Torznab category, e.g. 5000 for TV and 2000 for movies. */
  categories?: string;
  limit?: number;
  type?: "search" | "tvsearch" | "moviesearch";
}

export function createProwlarrClient(config: ProwlarrConfig, timeoutMs: number) {
  const authHeaders = (): Record<string, string> => {
    if (!config.apiKey) {
      throw new UpstreamError("prowlarr", "unauthorized", "Prowlarr API key is not configured");
    }
    return { "X-Api-Key": config.apiKey };
  };

  const get = <T>(path: string): Promise<T> =>
    fetchJson<T>("prowlarr", `${config.url}${path}`, {
      timeoutMs,
      headers: authHeaders(),
    });

  return {
    async listIndexers(): Promise<ProwlarrIndexer[]> {
      return get<ProwlarrIndexer[]>("/api/v1/indexer");
    },

    /** Search one indexer. Prowlarr fans out only to the id we give it. */
    async searchIndexer(
      indexerId: number,
      query: string,
      options: ProwlarrSearchOptions = {},
    ): Promise<ProwlarrRelease[]> {
      const params = new URLSearchParams({
        query,
        indexerIds: String(indexerId),
        type: options.type ?? "search",
        limit: String(options.limit ?? 100),
      });
      if (options.categories) {
        params.set("categories", options.categories);
      }
      return get<ProwlarrRelease[]>(`/api/v1/search?${params.toString()}`);
    },
  };
}

export type ProwlarrClient = ReturnType<typeof createProwlarrClient>;
