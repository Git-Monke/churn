import type { ServiceConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson, fetchWithTimeout, postJson } from "../http.js";

export interface ServarrSystemStatus {
  appName?: string;
  instanceName?: string;
  version?: string;
}

export type ArrServiceId = "sonarr" | "radarr";

export interface ServarrQualityProfile {
  id: number;
  name: string;
}

export interface ServarrRootFolder {
  id?: number;
  path: string;
  accessible: boolean;
  freeSpace?: number;
}

export interface ServarrImage {
  coverType?: string;
  url?: string;
  remoteUrl?: string;
}

export interface ServarrRating {
  value?: number;
  votes?: number;
}

export interface ServarrSeason {
  seasonNumber: number;
  monitored: boolean;
}

export interface ServarrLookupBase {
  id?: number;
  title?: string;
  year?: number;
  overview?: string;
  certification?: string;
  runtime?: number;
  genres?: string[];
  images?: ServarrImage[];
  titleSlug?: string;
  imdbId?: string;
}

export interface ServarrSeriesResource extends ServarrLookupBase {
  network?: string;
  tvdbId?: number;
  tmdbId?: number;
  seasons?: ServarrSeason[];
  ratings?: ServarrRating;
}

export interface ServarrMovieResource extends ServarrLookupBase {
  studio?: string;
  tmdbId?: number;
  ratings?: {
    imdb?: ServarrRating;
    tmdb?: ServarrRating;
  };
}

export interface ServarrMediaCover {
  body: Buffer;
  contentType: string;
}

export function createArrClient(service: ArrServiceId, config: ServiceConfig, timeoutMs: number) {
  const authHeaders = (): Record<string, string> => {
    if (!config.apiKey) {
      throw new UpstreamError(service, "unauthorized", `${service} API key is not configured`);
    }
    return { "X-Api-Key": config.apiKey };
  };

  const get = <T>(path: string): Promise<T> =>
    fetchJson<T>(service, `${config.url}${path}`, { timeoutMs, headers: authHeaders() });

  return {
    async getSystemStatus(): Promise<ServarrSystemStatus> {
      return get<ServarrSystemStatus>("/api/v3/system/status");
    },

    async lookupSeries(term: string): Promise<ServarrSeriesResource[]> {
      const query = new URLSearchParams({ term });
      return get<ServarrSeriesResource[]>(`/api/v3/series/lookup?${query.toString()}`);
    },

    async lookupMovie(term: string): Promise<ServarrMovieResource[]> {
      const query = new URLSearchParams({ term });
      return get<ServarrMovieResource[]>(`/api/v3/movie/lookup?${query.toString()}`);
    },

    async listSeries(): Promise<ServarrSeriesResource[]> {
      return get<ServarrSeriesResource[]>("/api/v3/series");
    },

    async listMovies(): Promise<ServarrMovieResource[]> {
      return get<ServarrMovieResource[]>("/api/v3/movie");
    },

    async getQualityProfiles(): Promise<ServarrQualityProfile[]> {
      return get<ServarrQualityProfile[]>("/api/v3/qualityprofile");
    },

    async getRootFolders(): Promise<ServarrRootFolder[]> {
      return get<ServarrRootFolder[]>("/api/v3/rootfolder");
    },

    async addSeries(payload: Record<string, unknown>): Promise<ServarrSeriesResource> {
      return postJson<ServarrSeriesResource>(
        service,
        `${config.url}/api/v3/series`,
        payload,
        { timeoutMs, headers: authHeaders() },
      );
    },

    async addMovie(payload: Record<string, unknown>): Promise<ServarrMovieResource> {
      return postJson<ServarrMovieResource>(
        service,
        `${config.url}/api/v3/movie`,
        payload,
        { timeoutMs, headers: authHeaders() },
      );
    },

    async getMediaCover(path: string): Promise<ServarrMediaCover | null> {
      const response = await fetchWithTimeout(
        service,
        `${config.url}${path}`,
        { headers: { ...authHeaders(), accept: "image/*" } },
        timeoutMs,
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new UpstreamError(
            service,
            "unauthorized",
            `${service} rejected the API key`,
            response.status,
          );
        }
        throw new UpstreamError(
          service,
          "http",
          `${service} returned HTTP ${response.status}`,
          response.status,
        );
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "image/jpeg",
      };
    },
  };
}

export type ArrClient = ReturnType<typeof createArrClient>;
