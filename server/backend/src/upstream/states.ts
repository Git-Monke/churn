import { isUnauthorized, UpstreamError } from "../errors.js";
import type { ArrServiceState } from "../types.js";

export function stateForError(error: unknown): ArrServiceState {
  return isUnauthorized(error) ? "unauthorized" : "unreachable";
}

export function errorMessage(error: unknown): string {
  return error instanceof UpstreamError ? error.message : "Service check failed";
}
