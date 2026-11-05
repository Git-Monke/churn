import type {
  ActivityResponse,
  AuthSessionResponse,
  CancelJellyfinItemResponse,
  CancelLibraryItemResponse,
  CancelEpisodeDownloadResponse,
  CancelMovieDownloadResponse,
  CreateProfileResponse,
  LoginInput,
  LoginResponse,
  ManagedProfile,
  ProfileLoginInput,
  ProfileLoginResponse,
  ProfileSummary,
  CreateRequestInput,
  CreateRequestResponse,
  CachedReleasesResponse,
  GrabMovieReleaseInput,
  GrabShowReleaseInput,
  GrabShowReleaseResponse,
  LibraryResponse,
  MovieDetailResponse,
  MovieDownloadResponse,
  PlaybackItemResponse,
  PlaybackQuality,
  PlaybackReport,
  RequestedLibraryResponse,
  RequestOptionsResponse,
  SearchResponse,
  ShowDetailResponse,
  ShowDownloadsResponse,
  ShowReleasesResponse,
  ShowSource,
  StatusResponse,
  VpnStatusResponse,
} from "./types";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      window.dispatchEvent(new Event("churn:unauthorized"));
    }
    const error = isErrorEnvelope(body) ? body.error : undefined;
    throw new ApiClientError(
      error?.message ?? `Request failed with HTTP ${response.status}`,
      response.status,
      error?.code,
    );
  }
  return body as T;
}

function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path);
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "DELETE" });
}

export function fetchSession(): Promise<AuthSessionResponse> {
  return getJson<AuthSessionResponse>("/api/auth/session");
}

export function login(input: LoginInput): Promise<LoginResponse> {
  return postJson<LoginResponse>("/api/auth/login", input);
}

export function logout(): Promise<null> {
  return postJson<null>("/api/auth/logout", {});
}

export function fetchProfiles(): Promise<ProfileSummary[]> {
  return getJson<ProfileSummary[]>("/api/auth/profiles");
}

export function profileLogin(input: ProfileLoginInput): Promise<ProfileLoginResponse> {
  return postJson<ProfileLoginResponse>("/api/auth/profile-login", input);
}

export function fetchManagedProfiles(): Promise<ManagedProfile[]> {
  return getJson<ManagedProfile[]>("/api/profiles");
}

export function createProfile(name: string): Promise<CreateProfileResponse> {
  return postJson<CreateProfileResponse>("/api/profiles", { name });
}

export function resetProfilePin(id: string): Promise<CreateProfileResponse> {
  return postJson<CreateProfileResponse>(
    `/api/profiles/${encodeURIComponent(id)}/pin`,
    {},
  );
}

export function deleteProfile(id: string): Promise<void> {
  return deleteJson<void>(`/api/profiles/${encodeURIComponent(id)}`);
}

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status");
}

export function fetchVpnStatus(): Promise<VpnStatusResponse> {
  return getJson<VpnStatusResponse>("/api/vpn");
}

export function fetchLibrary(): Promise<LibraryResponse> {
  return getJson<LibraryResponse>("/api/library");
}

export function fetchRequestedLibrary(): Promise<RequestedLibraryResponse> {
  return getJson<RequestedLibraryResponse>("/api/library/requested");
}

export function fetchRequestOptions(): Promise<RequestOptionsResponse> {
  return getJson<RequestOptionsResponse>("/api/requests/options");
}

export function cancelLibraryItem(
  service: "sonarr" | "radarr",
  id: number,
): Promise<CancelLibraryItemResponse> {
  return deleteJson<CancelLibraryItemResponse>(
    `/api/library/requested/${service}/${encodeURIComponent(String(id))}`,
  );
}

export function cancelJellyfinLibraryItem(
  id: string,
): Promise<CancelJellyfinItemResponse> {
  return deleteJson<CancelJellyfinItemResponse>(
    `/api/library/jellyfin/${encodeURIComponent(id)}`,
  );
}

export function cancelEpisodeDownload(
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<CancelEpisodeDownloadResponse> {
  return deleteJson<CancelEpisodeDownloadResponse>(
    `/api/library/shows/sonarr/${encodeURIComponent(String(seriesId))}/episodes/${encodeURIComponent(String(seasonNumber))}/${encodeURIComponent(String(episodeNumber))}/download`,
  );
}

export function fetchSearch(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  return getJson<SearchResponse>(`/api/search?${params.toString()}`);
}

export function fetchActivity(): Promise<ActivityResponse> {
  return getJson<ActivityResponse>("/api/activity");
}

export function fetchShow(
  source: ShowSource,
  id: string,
): Promise<ShowDetailResponse> {
  return getJson<ShowDetailResponse>(`/api/library/shows/${source}/${encodeURIComponent(id)}`);
}

export function fetchMovieDownload(
  source: "jellyfin" | "radarr",
  id: string,
): Promise<MovieDownloadResponse> {
  return getJson<MovieDownloadResponse>(
    `/api/library/movies/${source}/${encodeURIComponent(id)}/download`,
  );
}

export function fetchShowDownloads(
  source: ShowSource,
  id: string,
): Promise<ShowDownloadsResponse> {
  return getJson<ShowDownloadsResponse>(
    `/api/library/shows/${source}/${encodeURIComponent(id)}/downloads`,
  );
}

export function fetchPlayback(
  itemId: string,
  quality?: PlaybackQuality,
): Promise<PlaybackItemResponse> {
  const suffix =
    quality && quality !== "max" ? `?quality=${encodeURIComponent(quality)}` : "";
  return getJson<PlaybackItemResponse>(
    `/api/playback/items/${encodeURIComponent(itemId)}${suffix}`,
  );
}

export function reportPlaybackStart(
  itemId: string,
  body: PlaybackReport,
): Promise<null> {
  return postJson<null>(
    `/api/playback/items/${encodeURIComponent(itemId)}/start`,
    body,
  );
}

export function reportPlaybackProgress(
  itemId: string,
  body: PlaybackReport,
): Promise<null> {
  return postJson<null>(
    `/api/playback/items/${encodeURIComponent(itemId)}/progress`,
    body,
  );
}

export function reportPlaybackStop(
  itemId: string,
  body: PlaybackReport,
): Promise<null> {
  return postJson<null>(
    `/api/playback/items/${encodeURIComponent(itemId)}/stop`,
    body,
  );
}

export function fetchSeasonReleases(
  seriesId: number,
  seasonNumber: number,
): Promise<CachedReleasesResponse> {
  const params = new URLSearchParams({ season: String(seasonNumber) });
  return getJson<CachedReleasesResponse>(
    `/api/library/shows/sonarr/${encodeURIComponent(String(seriesId))}/releases?${params.toString()}`,
  );
}

export function refreshSeasonReleases(
  seriesId: number,
  seasonNumber: number,
): Promise<CachedReleasesResponse> {
  const params = new URLSearchParams({ season: String(seasonNumber) });
  return postJson<CachedReleasesResponse>(
    `/api/library/shows/sonarr/${encodeURIComponent(String(seriesId))}/releases/refresh?${params.toString()}`,
    {},
  );
}

export function fetchEpisodeReleases(
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<CachedReleasesResponse> {
  const params = new URLSearchParams({
    season: String(seasonNumber),
    episode: String(episodeNumber),
  });
  return getJson<CachedReleasesResponse>(
    `/api/library/shows/sonarr/${encodeURIComponent(String(seriesId))}/releases?${params.toString()}`,
  );
}

export function refreshEpisodeReleases(
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
): Promise<CachedReleasesResponse> {
  const params = new URLSearchParams({
    season: String(seasonNumber),
    episode: String(episodeNumber),
  });
  return postJson<CachedReleasesResponse>(
    `/api/library/shows/sonarr/${encodeURIComponent(String(seriesId))}/releases/refresh?${params.toString()}`,
    {},
  );
}

export function fetchMovie(
  source: "jellyfin" | "radarr",
  id: string,
): Promise<MovieDetailResponse> {
  return getJson<MovieDetailResponse>(
    `/api/library/movies/${source}/${encodeURIComponent(id)}`,
  );
}

export function cancelMovieDownload(
  source: "jellyfin" | "radarr",
  id: string,
): Promise<CancelMovieDownloadResponse> {
  return deleteJson<CancelMovieDownloadResponse>(
    `/api/library/movies/${source}/${encodeURIComponent(id)}/download`,
  );
}

export function fetchMovieReleases(movieId: number): Promise<CachedReleasesResponse> {
  return getJson<CachedReleasesResponse>(
    `/api/library/movies/${encodeURIComponent(String(movieId))}/releases`,
  );
}

export function refreshMovieReleases(movieId: number): Promise<CachedReleasesResponse> {
  return postJson<CachedReleasesResponse>(
    `/api/library/movies/${encodeURIComponent(String(movieId))}/releases/refresh`,
    {},
  );
}

export function grabMovieRelease(
  movieId: number,
  input: GrabMovieReleaseInput,
): Promise<GrabShowReleaseResponse> {
  return postJson<GrabShowReleaseResponse>(
    `/api/library/movies/${encodeURIComponent(String(movieId))}/releases/grab`,
    input,
  );
}

export function grabShowRelease(
  source: ShowSource,
  id: string,
  input: GrabShowReleaseInput,
): Promise<GrabShowReleaseResponse> {
  return postJson<GrabShowReleaseResponse>(
    `/api/library/shows/${source}/${encodeURIComponent(id)}/releases/grab`,
    input,
  );
}

export function createRequest(input: CreateRequestInput): Promise<CreateRequestResponse> {
  return postJson<CreateRequestResponse>("/api/requests", input);
}

function isErrorEnvelope(value: unknown): value is { error: { code?: string; message?: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  );
}
