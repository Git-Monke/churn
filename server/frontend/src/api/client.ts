import type {
  CreateRequestInput,
  CreateRequestResponse,
  LibraryResponse,
  RequestOptionsResponse,
  SearchResponse,
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

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status");
}

export function fetchLibrary(): Promise<LibraryResponse> {
  return getJson<LibraryResponse>("/api/library");
}

export function fetchRequestOptions(): Promise<RequestOptionsResponse> {
  return getJson<RequestOptionsResponse>("/api/requests/options");
}

export function fetchSearch(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  return getJson<SearchResponse>(`/api/search?${params.toString()}`);
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
