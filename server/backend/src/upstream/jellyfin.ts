import type { ServiceConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { fetchJson, fetchWithTimeout, upstreamResponseError } from "../http.js";
import type { LibraryItem } from "../types.js";

export interface JellyfinPublicInfo {
  ServerName?: string;
  Version?: string;
  StartupWizardCompleted?: boolean;
}

export interface JellyfinSystemInfo extends JellyfinPublicInfo {
  OperatingSystemDisplayName?: string;
}

export interface JellyfinUserPolicy {
  IsAdministrator?: boolean;
}

export interface JellyfinUser {
  Id?: string;
  Name?: string;
  Policy?: JellyfinUserPolicy;
}

export interface JellyfinAuthenticationResult {
  User?: JellyfinUser;
  AccessToken?: string;
  ServerId?: string;
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
  PremiereDate?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  SeriesName?: string;
  SeriesId?: string;
  /** Only returned when the query asks for the Path field. */
  Path?: string;
  ProviderIds?: Record<string, string>;
  UserData?: {
    PlaybackPositionTicks?: number;
    /** Jellyfin's own percentage; present on resume-list items. */
    PlayedPercentage?: number;
    Played?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
  };
  ImageTags?: {
    Primary?: string;
  };
  BackdropImageTags?: string[];
  /** Poster tag of the series an episode belongs to. */
  SeriesPrimaryImageTag?: string;
}

export interface JellyfinMediaStream {
  Type?: string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsExternal?: boolean;
  BitRate?: number;
  Width?: number;
  Height?: number;
  Channels?: number;
  VideoRange?: string;
}

export interface JellyfinMediaSource {
  Id?: string;
  Name?: string;
  Container?: string;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  MediaStreams?: JellyfinMediaStream[];
}

export interface PlaybackInfoResponse {
  MediaSources?: JellyfinMediaSource[];
  PlaySessionId?: string;
}

export interface PlaybackStartInfo {
  ItemId: string;
  MediaSourceId?: string;
  PlaySessionId?: string;
  PositionTicks?: number;
  CanSeek: boolean;
  IsPaused: boolean;
  IsMuted: boolean;
  PlayMethod: "DirectPlay" | "Transcode";
}

export interface PlaybackProgressInfo extends PlaybackStartInfo {}

export interface PlaybackStopInfo {
  ItemId: string;
  MediaSourceId?: string;
  PlaySessionId?: string;
  PositionTicks?: number;
  Failed: boolean;
}

interface JellyfinItemsResponse {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export type JellyfinImageType = "Primary" | "Backdrop";

export interface JellyfinImageQuery {
  /** Defaults to the poster/thumbnail (`Primary`). */
  type?: JellyfinImageType;
  tag?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface JellyfinImage {
  body: Buffer;
  contentType: string;
}

const CLIENT_NAME = "Churn";
const DEVICE_NAME = "Churn Web";
const DEFAULT_DEVICE_ID = "churn-web";
const CLIENT_VERSION = "0.1.0";

export interface JellyfinClientOptions {
  /** Unique per Churn session so Jellyfin never revokes another login. */
  deviceId?: string;
  deviceName?: string;
}

const LIBRARY_QUERY = new URLSearchParams({
  // Recurse so movies Jellyfin nests under a folder item are still listed. That
  // happens when a movie folder holds more than one video (a second release of
  // the same movie, for example): Jellyfin turns the folder itself into a
  // `Folder` item and puts the movies underneath it. A non-recursive query then
  // only returns the folder, and churn's library/search would miss the movie.
  Recursive: "true",
  IncludeItemTypes: "Movie,Series",
  SortBy: "SortName",
  SortOrder: "Ascending",
  Fields: "ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,Genres,Overview,ProviderIds",
  ImageTypeLimit: "1",
  EnableImageTypes: "Primary",
});
const DETAIL_FIELDS = "ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,Genres,Overview,ProviderIds";
const RESUME_FIELDS =
  "RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,SeriesPrimaryImageTag";

export function createJellyfinClient(
  config: ServiceConfig,
  timeoutMs: number,
  token: string | undefined = config.apiKey,
  options: JellyfinClientOptions = {},
) {
  const deviceId = options.deviceId ?? DEFAULT_DEVICE_ID;
  const deviceName = options.deviceName ?? DEVICE_NAME;
  const authorizationHeader = `MediaBrowser Client="${CLIENT_NAME}", Device="${deviceName}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;

  const deviceHeaders = (): Record<string, string> => ({
    "X-Emby-Client": CLIENT_NAME,
    "X-Emby-Device-Name": deviceName,
    "X-Emby-Device-Id": deviceId,
    "X-Emby-Client-Version": CLIENT_VERSION,
  });

  const authHeaders = (): Record<string, string> =>
    token ? { "X-Emby-Token": token, ...deviceHeaders() } : deviceHeaders();

  const postNoContent = async (url: string, body: unknown): Promise<void> => {
    if (!token) {
      throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
    }
    const response = await fetchWithTimeout(
      "jellyfin",
      url,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!response.ok) {
      throw await upstreamResponseError("jellyfin", response);
    }
  };

  return {
    async authenticate(username: string, password: string): Promise<JellyfinAuthenticationResult> {
      return fetchJson<JellyfinAuthenticationResult>(
        "jellyfin",
        `${config.url}/Users/AuthenticateByName`,
        {
          timeoutMs,
          method: "POST",
          headers: { Authorization: authorizationHeader, ...deviceHeaders() },
          body: { Username: username, Pw: password },
        },
      );
    },

    async logout(accessToken: string): Promise<void> {
      await fetchWithTimeout(
        "jellyfin",
        `${config.url}/Sessions/Logout`,
        {
          method: "POST",
          headers: { "X-Emby-Token": accessToken, ...deviceHeaders() },
        },
        timeoutMs,
      );
    },

    /** Create a Jellyfin user. Requires an admin API key or token. */
    async createUser(name: string, password: string): Promise<JellyfinUser> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      return fetchJson<JellyfinUser>("jellyfin", `${config.url}/Users/New`, {
        method: "POST",
        body: { Name: name, Password: password },
        headers: authHeaders(),
        timeoutMs,
      });
    },

    /**
     * Change a user's password. With a user token, `currentPassword` proves the
     * old credential. With an admin API key, omit it to reset the password.
     */
    async setUserPassword(
      jellyfinUserId: string,
      newPassword: string,
      options: { currentPassword?: string } = {},
    ): Promise<void> {
      const body: Record<string, string> = { NewPw: newPassword };
      if (options.currentPassword !== undefined) {
        body.CurrentPw = options.currentPassword;
      }
      await postNoContent(
        `${config.url}/Users/${encodeURIComponent(jellyfinUserId)}/Password`,
        body,
      );
    },

    /** Delete a Jellyfin user, revoking its tokens and watch state. */
    async deleteUser(jellyfinUserId: string): Promise<void> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const response = await fetchWithTimeout(
        "jellyfin",
        `${config.url}/Users/${encodeURIComponent(jellyfinUserId)}`,
        { method: "DELETE", headers: authHeaders() },
        timeoutMs,
      );
      if (!response.ok) {
        throw await upstreamResponseError("jellyfin", response);
      }
    },

    async getPublicInfo(): Promise<JellyfinPublicInfo> {
      return fetchJson<JellyfinPublicInfo>("jellyfin", `${config.url}/System/Info/Public`, {
        timeoutMs,
      });
    },

    async getSystemInfo(): Promise<JellyfinSystemInfo> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      return fetchJson<JellyfinSystemInfo>("jellyfin", `${config.url}/System/Info`, {
        timeoutMs,
        headers: authHeaders(),
      });
    },

    async listUserViews(userId: string): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}/Users/${encodeURIComponent(userId)}/Views`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    /**
     * Lists only items that are still reachable through one of the user's
     * library views. A global `/Items?Recursive=true` query also returns
     * orphaned records that Jellyfin keeps after a library path is removed,
     * which made in-progress download files look like library items.
     */
    async listLibrary(userId: string): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const views = await this.listUserViews(userId);
      const libraries = views.filter(
        (view): view is JellyfinItem & { Id: string } => typeof view.Id === "string" && view.Id.length > 0,
      );
      const itemsByView = await Promise.all(
        libraries.map(async (view) => {
          const query = new URLSearchParams(LIBRARY_QUERY);
          query.set("ParentId", view.Id);
          const response = await fetchJson<JellyfinItemsResponse>(
            "jellyfin",
            `${config.url}/Users/${encodeURIComponent(userId)}/Items?${query.toString()}`,
            { timeoutMs, headers: authHeaders() },
          );
          return response.Items ?? [];
        }),
      );
      const seen = new Set<string>();
      return itemsByView.flat().filter((item) => {
        const key = item.Id ?? `${item.Type ?? ""}:${item.Name ?? ""}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    },

    /**
     * Jellyfin's per-user resume list: partly watched movies and episodes,
     * newest first, already excluding finished items. `UserItems/Resume` is the
     * route Jellyfin 10.11 serves; the legacy `Users/{id}/Items/Resume` returns
     * the same body.
     */
    async listResumeItems(userId: string, limit: number): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({
        userId,
        Limit: String(limit),
        MediaTypes: "Video",
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        Fields: RESUME_FIELDS,
        ImageTypeLimit: "1",
        EnableImageTypes: "Primary,Backdrop",
      });
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}/UserItems/Resume?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    async getItem(itemId: string, userId?: string): Promise<JellyfinItem> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({ Fields: DETAIL_FIELDS });
      if (userId) {
        query.set("userId", userId);
      }
      return fetchJson<JellyfinItem>(
        "jellyfin",
        `${config.url}/Items/${encodeURIComponent(itemId)}?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
    },

    async getPlaybackInfo(itemId: string, userId: string): Promise<PlaybackInfoResponse> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({ userId });
      return fetchJson<PlaybackInfoResponse>(
        "jellyfin",
        `${config.url}/Items/${encodeURIComponent(itemId)}/PlaybackInfo?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
    },

    async reportPlaybackStart(body: PlaybackStartInfo): Promise<void> {
      await postNoContent(`${config.url}/Sessions/Playing`, body);
    },

    async reportPlaybackProgress(body: PlaybackProgressInfo): Promise<void> {
      await postNoContent(`${config.url}/Sessions/Playing/Progress`, body);
    },

    async reportPlaybackStopped(body: PlaybackStopInfo): Promise<void> {
      await postNoContent(`${config.url}/Sessions/Playing/Stopped`, body);
    },

    async getSeasons(seriesId: string): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({
        Fields: "ProviderIds",
        ImageTypeLimit: "1",
        EnableImageTypes: "Primary",
      });
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}/Shows/${encodeURIComponent(seriesId)}/Seasons?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    /**
     * Jellyfin only fills `UserData` (played flag, playback position, played
     * percentage) when the request names a user, so anything that shows watch
     * state passes `userId`. Background scans and metadata warmers stay
     * user-agnostic by omitting it.
     */
    async getEpisodes(seriesId: string, userId?: string): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({
        Fields: "Overview,ProviderIds",
        ImageTypeLimit: "1",
        EnableImageTypes: "Primary",
      });
      if (userId) {
        query.set("userId", userId);
      }
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}/Shows/${encodeURIComponent(seriesId)}/Episodes?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    /**
     * Every Movie or Series with its provider ids and path. Jellyfin's
     * `AnyProviderIdEquals` filter is unreliable (it also returns unrelated
     * items), so churn matches provider ids itself.
     */
    async listItemsByType(type: "Movie" | "Series"): Promise<JellyfinItem[]> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const query = new URLSearchParams({
        Recursive: "true",
        IncludeItemTypes: type,
        Fields: "ProviderIds,Path",
        ImageTypeLimit: "0",
        Limit: "5000",
      });
      const response = await fetchJson<JellyfinItemsResponse>(
        "jellyfin",
        `${config.url}/Items?${query.toString()}`,
        { timeoutMs, headers: authHeaders() },
      );
      return response.Items ?? [];
    },

    async refreshLibrary(): Promise<void> {
      await postNoContent(`${config.url}/Library/Refresh`, {});
    },

    /** Delete a movie/series from the Jellyfin library and its filesystem. */
    async deleteItem(itemId: string): Promise<void> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const response = await fetchWithTimeout(
        "jellyfin",
        `${config.url}/Items/${encodeURIComponent(itemId)}`,
        { method: "DELETE", headers: authHeaders() },
        timeoutMs,
      );
      if (!response.ok) {
        throw await upstreamResponseError("jellyfin", response);
      }
    },

    async getItemImage(itemId: string, query: JellyfinImageQuery): Promise<JellyfinImage | null> {
      if (!token) {
        throw new UpstreamError("jellyfin", "unauthorized", "Jellyfin API key is not configured");
      }
      const params = new URLSearchParams();
      if (query.tag) params.set("tag", query.tag);
      if (query.maxWidth !== undefined) params.set("maxWidth", String(query.maxWidth));
      if (query.maxHeight !== undefined) params.set("maxHeight", String(query.maxHeight));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      // A backdrop image is always the first one; Jellyfin rejects
      // `Images/Backdrop` without an index.
      const imageType = query.type === "Backdrop" ? "Backdrop/0" : "Primary";
      const url = `${config.url}/Items/${encodeURIComponent(itemId)}/Images/${imageType}${suffix}`;

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
    tmdbId: providerNumber(item, "tmdb"),
    tvdbId: providerNumber(item, "tvdb"),
    imdbId: providerString(item, "imdb"),
  };
}

function providerNumber(item: JellyfinItem, key: string): number | undefined {
  const value = providerString(item, key);
  if (value === undefined) {
    return undefined;
  }
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Provider id lookup shared with the library scan's resolution check. */
export function providerString(item: JellyfinItem, key: string): string | undefined {
  const entry = Object.entries(item.ProviderIds ?? {}).find(
    ([providerKey]) => providerKey.toLowerCase() === key.toLowerCase(),
  );
  return entry?.[1]?.trim() || undefined;
}
