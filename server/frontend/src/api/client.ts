import type {
  ActivityResponse,
  AuthSessionResponse,
  CancelLibraryItemResponse,
  LoginInput,
  LoginResponse,
  CreateRequestInput,
  CreateRequestResponse,
  GrabShowReleaseInput,
  GrabShowReleaseResponse,
  LibraryResponse,
  PlaybackItemResponse,
  PlaybackReport,
  RequestedLibraryResponse,
  RequestOptionsResponse,
  SearchResponse,
  ShowDetailResponse,
  ShowReleasesResponse,
  ShowSource,
  StatusResponse,
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

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status");
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

export function fetchPlayback(itemId: string): Promise<PlaybackItemResponse> {
  return getJson<PlaybackItemResponse>(
    `/api/playback/items/${encodeURIComponent(itemId)}`,
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

export function fetchShowReleases(
  source: ShowSource,
  id: string,
  seasonNumber: number,
  options: { episodeNumber?: number; allSeasons?: boolean } = {},
): Promise<ShowReleasesResponse> {
  const params = new URLSearchParams({ season: String(seasonNumber) });
  if (options.episodeNumber !== undefined) {
    params.set("episode", String(options.episodeNumber));
  }
  if (options.allSeasons) {
    params.set("scope", "all");
  }
  return getJson<ShowReleasesResponse>(
    `/api/library/shows/${source}/${encodeURIComponent(id)}/releases?${params.toString()}`,
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
