import type { ServiceId } from "./config.js";

export type UpstreamServiceId = ServiceId | "qbittorrent" | "prowlarr" | "vpn";

export type UpstreamErrorKind = "unreachable" | "unauthorized" | "http" | "invalid_response";

/** An upstream request failed. Messages are safe to return to the browser. */
export class UpstreamError extends Error {
  readonly service: UpstreamServiceId;
  readonly kind: UpstreamErrorKind;
  readonly status?: number;

  constructor(service: UpstreamServiceId, kind: UpstreamErrorKind, message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.service = service;
    this.kind = kind;
    this.status = status;
  }
}

/** An error deliberately exposed through the API's `{ error }` envelope. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === "unauthorized";
}

export function isUnreachable(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === "unreachable";
}

export function isInvalidResponse(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === "invalid_response";
}

export function isUpstreamNotFound(error: unknown): boolean {
  return error instanceof UpstreamError && error.status === 404;
}
