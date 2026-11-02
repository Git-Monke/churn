import type { ServiceConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { deleteRequest, fetchJson, fetchWithTimeout, postJson } from "../http.js";

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

export interface ServarrSeriesStatistics {
  episodeFileCount?: number;
  episodeCount?: number;
  totalEpisodeCount?: number;
  percentOfEpisodes?: number;
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
  statistics?: ServarrSeriesStatistics;
}

export interface ServarrMovieResource extends ServarrLookupBase {
  studio?: string;
  tmdbId?: number;
  hasFile?: boolean;
  ratings?: {
    imdb?: ServarrRating;
    tmdb?: ServarrRating;
  };
}

export interface ServarrQueueStatusMessage {
  title?: string;
  messages?: string[];
}

export interface ServarrQueueRecord {
  id?: number;
  downloadId?: string;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  protocol?: string;
  downloadClient?: string;
  indexer?: string;
  seriesId?: number;
  episodeId?: number;
  seasonNumber?: number;
  movieId?: number;
  quality?: {
    quality?: {
      name?: string;
    };
  };
  statusMessages?: ServarrQueueStatusMessage[];
  /** Populated by the qBittorrent overlay; arr never sends this field. */
  downloadSpeed?: number;
}

export interface ServarrQueueResponse {
  page?: number;
  pageSize?: number;
  totalRecords?: number;
  records?: ServarrQueueRecord[];
}

export interface ServarrReleaseQuality {
  id?: number;
  name?: string;
  source?: string;
  resolution?: number;
}

export interface ServarrReleaseQualityModel {
  quality?: ServarrReleaseQuality;
  revision?: {
    version?: number;
    real?: number;
    isRepack?: boolean;
  };
}

export interface ServarrLanguage {
  id?: number;
  name?: string;
}

export interface ServarrReleaseEpisode {
  id?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  title?: string;
}

/** A release returned by Sonarr's interactive season/episode search. */
export interface ServarrRelease {
  guid?: string;
  indexerId?: number;
  indexer?: string;
  title?: string;
  size?: number;
  quality?: ServarrReleaseQualityModel;
  qualityWeight?: number;
  releaseWeight?: number;
  seasonNumber?: number;
  seasonNumbers?: number[];
  episodeNumbers?: number[];
  mappedSeasonNumber?: number;
  mappedEpisodeNumbers?: number[];
  mappedEpisodeInfo?: ServarrReleaseEpisode[];
  approved?: boolean;
  rejected?: boolean;
  temporarilyRejected?: boolean;
  downloadAllowed?: boolean;
  rejections?: string[];
  protocol?: string;
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  publishDate?: string;
  infoUrl?: string;
  fullSeason?: boolean;
  languages?: ServarrLanguage[];
}

export interface ServarrEpisode {
  id?: number;
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  title?: string;
  overview?: string;
  airDateUtc?: string;
  hasFile?: boolean;
  monitored?: boolean;
  episodeFileId?: number;
}

export interface ServarrMediaCover {
  body: Buffer;
  contentType: string;
}

/** Posters and fanart are a few hundred KB; anything huge is not artwork. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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

    async getQueue(): Promise<ServarrQueueRecord[]> {
      const query = new URLSearchParams({ page: "1", pageSize: "1000" });
      if (service === "sonarr") {
        query.set("includeUnknownSeriesItems", "true");
      }
      const response = await get<ServarrQueueResponse>(`/api/v3/queue?${query.toString()}`);
      return response.records ?? [];
    },

    /** Cancel one queue record and remove the release from the download client. */
    async removeQueueRecord(
      queueId: number,
      options: { blocklist?: boolean; skipRedownload?: boolean } = {},
    ): Promise<void> {
      const query = new URLSearchParams({
        removeFromClient: "true",
        blocklist: String(options.blocklist ?? false),
        skipRedownload: String(options.skipRedownload ?? true),
        changeCategory: "false",
      });
      await deleteRequest(service, `${config.url}/api/v3/queue/${queueId}?${query.toString()}`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async deleteMovie(id: number, deleteFiles = true): Promise<void> {
      const query = new URLSearchParams({
        deleteFiles: String(deleteFiles),
        addImportExclusion: "false",
      });
      await deleteRequest(service, `${config.url}/api/v3/movie/${id}?${query.toString()}`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async deleteSeries(id: number, deleteFiles = true): Promise<void> {
      const query = new URLSearchParams({
        deleteFiles: String(deleteFiles),
        addImportExclusion: "false",
      });
      await deleteRequest(service, `${config.url}/api/v3/series/${id}?${query.toString()}`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async getSeries(id: number): Promise<ServarrSeriesResource> {
      return get<ServarrSeriesResource>(`/api/v3/series/${id}`);
    },

    async getMovie(id: number): Promise<ServarrMovieResource> {
      return get<ServarrMovieResource>(`/api/v3/movie/${id}`);
    },

    async getEpisodes(seriesId: number): Promise<ServarrEpisode[]> {
      const query = new URLSearchParams({ seriesId: String(seriesId) });
      return get<ServarrEpisode[]>(`/api/v3/episode?${query.toString()}`);
    },

    async getSeasonReleases(seriesId: number, seasonNumber: number): Promise<ServarrRelease[]> {
      const query = new URLSearchParams({
        seriesId: String(seriesId),
        seasonNumber: String(seasonNumber),
      });
      return get<ServarrRelease[]>(`/api/v3/release?${query.toString()}`);
    },

    async getEpisodeReleases(seriesId: number, episodeId: number): Promise<ServarrRelease[]> {
      const query = new URLSearchParams({
        seriesId: String(seriesId),
        episodeId: String(episodeId),
      });
      return get<ServarrRelease[]>(`/api/v3/release?${query.toString()}`);
    },

    async getMovieReleases(movieId: number): Promise<ServarrRelease[]> {
      const query = new URLSearchParams({ movieId: String(movieId) });
      return get<ServarrRelease[]>(`/api/v3/release?${query.toString()}`);
    },

    /** Ask the arr to search itself (used when churn finds no usable release). */
    async runCommand(payload: Record<string, unknown>): Promise<unknown> {
      return postJson<unknown>(service, `${config.url}/api/v3/command`, payload, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async grabRelease(payload: Record<string, unknown>): Promise<unknown> {
      return postJson<unknown>(
        service,
        `${config.url}/api/v3/release`,
        payload,
        { timeoutMs, headers: authHeaders() },
      );
    },

    async addSeries(payload: Record<string, unknown>): Promise<ServarrSeriesResource> {
      return postJson<ServarrSeriesResource>(
        service,
        `${config.url}/api/v3/series`,
        payload,
        { timeoutMs, headers: authHeaders() },
      );
    },

    /** Update an existing series, including its per-season monitoring flags. */
    async updateSeries(
      id: number,
      payload: Record<string, unknown>,
    ): Promise<ServarrSeriesResource> {
      return fetchJson<ServarrSeriesResource>(
        service,
        `${config.url}/api/v3/series/${id}`,
        { timeoutMs, headers: authHeaders(), method: "PUT", body: payload },
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

    /**
     * Fetch artwork from a public CDN URL (not the session-protected
     * `/MediaCoverProxy/...` path on the app itself).
     */
    async getRemoteImage(url: string): Promise<ServarrMediaCover | null> {
      const response = await fetchWithTimeout(
        service,
        url,
        { headers: { accept: "image/*" } },
        timeoutMs,
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new UpstreamError(
          service,
          "http",
          `${service} artwork returned HTTP ${response.status}`,
          response.status,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        throw new UpstreamError(
          service,
          "http",
          `${service} artwork was not an image`,
          response.status,
        );
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > MAX_IMAGE_BYTES) {
        throw new UpstreamError(service, "http", `${service} artwork was too large`, 413);
      }
      return { body, contentType };
    },
  };
}

export type ArrClient = ReturnType<typeof createArrClient>;
