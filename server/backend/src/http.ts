import type { ServiceId } from "./config.js";
import { UpstreamError } from "./errors.js";

interface JsonRequestOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
}

/** Fetch with a hard timeout, translating network/timeout failures. */
export async function fetchWithTimeout(
  service: ServiceId,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new UpstreamError(service, "unreachable", `${service} did not respond in time`);
    }
    throw new UpstreamError(service, "unreachable", `${service} is unreachable`);
  }
}

export async function fetchJson<T>(
  service: ServiceId,
  url: string,
  options: JsonRequestOptions,
): Promise<T> {
  const response = await fetchWithTimeout(
    service,
    url,
    { headers: { accept: "application/json", ...options.headers } },
    options.timeoutMs,
  );

  if (!response.ok) {
    throw upstreamResponseError(service, response);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(service, "invalid_response", `${service} returned invalid JSON`);
  }
}

export function upstreamResponseError(service: ServiceId, response: Response): UpstreamError {
  if (response.status === 401 || response.status === 403) {
    return new UpstreamError(service, "unauthorized", `${service} rejected the API key`, response.status);
  }
  return new UpstreamError(service, "http", `${service} returned HTTP ${response.status}`, response.status);
}
