import type { ServiceConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson, fetchWithTimeout } from "../http.js";
import type { LibraryItem } from "../types.js";

export interface JellyfinPublicInfo {
  ServerName?: string;
  Version?: string;
  StartupWizardCompleted?: boolean;
}

export interface JellyfinSystemInfo extends JellyfinPublicInfo {
  OperatingSystemDisplayName?: string;
}

export interface JellyfinItem {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  Overview?: string;
  ImageTags?: {
    Primary?: string;
  };
}

interface JellyfinItemsResponse {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export interface JellyfinImageQuery {
  tag?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface JellyfinImage {
  body: Buffer;
  contentType: string;
}

const LIBRARY_PATH = "/Items";
const LIBRARY_QUERY = new URLSearchParams({
  Recursive: "true",
  IncludeItemTypes: "Movie,Series",
  SortBy: "SortName",
  SortOrder: "Ascending",
  Fields: "ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,Genres,Overview",
  ImageTypeLimit: "1",
  EnableImageTypes: "Primary",
});

export function createJellyfinClient(config: ServiceConfig, timeoutMs: number) {
  const authHeaders = (): Record<string, string> =>
    config.apiKey ? { "X-Emby-Token": config.apiKey } : {};

  return {
    async getPublicInfo(): Promise<JellyfinPublicInfo> {
      return fetchJson<JellyfinPublicInfo>("jellyfin", `${config.url}/System/Info/Public`, {
        timeoutMs,
      });
    },

    async getSystemInfo(): Promise<JellyfinSystemInfo> {
      if (!config.apiKey) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      return fetchJson<JellyfinSystemInfo>("jellyfin", `${config.url}/System/Info`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async listLibrary(): Promise<JellyfinItem[]> {
      if (!config.apiKey) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}${LIBRARY_PATH}?${LIBRARY_QUERY.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    async getPrimaryImage(itemId: string, query: JellyfinImageQuery): Promise<JellyfinImage | null> {
      if (!config.apiKey) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const params = new URLSearchParams();
      if (query.tag) params.set("tag", query.tag);
      if (query.maxWidth !== undefined) params.set("maxWidth", String(query.maxWidth));
      if (query.maxHeight !== undefined) params.set("maxHeight", String(query.maxHeight));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const url = `${config.url}/Items/${encodeURIComponent(itemId)}/Images/Primary${suffix}`;

      const response = await fetchWithTimeout(
        "jellyfin",
        url,
        { headers: { ...authHeaders(), accept: "image/*" } },
        timeoutMs,
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new UpstreamError(
            "jellyfin",
            "unauthorized",
            "Jellyfin rejected the API key",
            response.status,
          );
        }
        throw new UpstreamError(
          "jellyfin",
          "http",
          `Jellyfin returned HTTP ${response.status}`,
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

export type JellyfinClient = ReturnType<typeof createJellyfinClient>;

export function mapJellyfinItem(item: JellyfinItem): LibraryItem | null {
  if (!item.Id || !item.Name || (item.Type !== "Movie" && item.Type !== "Series")) {
    return null;
  }
  const tag = item.ImageTags?.Primary;
  return {
    id: item.Id,
    name: item.Name,
    type: item.Type,
    year: item.ProductionYear,
    overview: item.Overview,
    rating: item.CommunityRating,
    officialRating: item.OfficialRating,
    runtimeMinutes:
      item.RunTimeTicks === undefined ? undefined : Math.round(item.RunTimeTicks / 600_000_000),
    imageUrl: tag
      ? `/api/library/images/${encodeURIComponent(item.Id)}?tag=${encodeURIComponent(tag)}`
      : undefined,
  };
}
