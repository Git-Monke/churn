import type { UpstreamServiceId } from "./errors.js";
import { UpstreamError } from "./errors.js";

interface JsonRequestOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/** Fetch with a hard timeout, translating network/timeout failures. */
export async function fetchWithTimeout(
  service: UpstreamServiceId,
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
  service: UpstreamServiceId,
  url: string,
  options: JsonRequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  const init: RequestInit = { headers, method: options.method ?? "GET" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetchWithTimeout(service, url, init, options.timeoutMs);

  if (!response.ok) {
    throw await upstreamResponseError(service, response);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(service, "invalid_response", `${service} returned invalid JSON`);
  }
}

export function postJson<T>(
  service: UpstreamServiceId,
  url: string,
  body: unknown,
  options: Omit<JsonRequestOptions, "method" | "body">,
): Promise<T> {
  return fetchJson<T>(service, url, { ...options, method: "POST", body });
}

export async function upstreamResponseError(
  service: UpstreamServiceId,
  response: Response,
): Promise<UpstreamError> {
  if (response.status === 401 || response.status === 403) {
    return new UpstreamError(service, "unauthorized", `${service} rejected the API key`, response.status);
  }
  const detail = await readErrorDetail(response);
  const message = detail
    ? `${service} returned HTTP ${response.status}: ${detail}`
    : `${service} returned HTTP ${response.status}`;
  return new UpstreamError(service, "http", message, response.status);
}

/** Read a concise, browser-safe message from a Sonarr/Radarr error body. */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text.trim()) {
    return undefined;
  }

  try {
    const body: unknown = JSON.parse(text);
    const messages = collectArrMessages(body);
    if (messages.length > 0) {
      return truncate(messages.join("; "));
    }
  } catch {
    // Fall through to a plain-text response.
  }

  if (text.trimStart().startsWith("<")) {
    return undefined;
  }
  return truncate(text.replace(/\s+/g, " ").trim());
}

function collectArrMessages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectArrMessages(entry));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of ["errorMessage", "message"]) {
    const message = record[key];
    if (typeof message === "string" && message.trim()) {
      messages.push(message.trim());
    }
  }
  return messages;
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}
