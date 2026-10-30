import type { LibraryResponse, StatusResponse } from "./types";

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
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

export function fetchStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>("/api/status");
}

export function fetchLibrary(): Promise<LibraryResponse> {
  return getJson<LibraryResponse>("/api/library");
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
