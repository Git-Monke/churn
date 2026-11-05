import type { IntroDbConfig } from "./config.js";
import { isUpstreamNotFound, UpstreamError } from "./errors.js";
import { fetchJson } from "./http.js";

/** One intro/recap/outro range, in seconds from the start of the item. */
export interface IntroDbSegment {
  startSec: number;
  endSec: number;
}

export interface IntroDbSegments {
  intro?: IntroDbSegment;
  recap?: IntroDbSegment;
  outro?: IntroDbSegment;
  postCredits?: IntroDbSegment;
}

const IMDB_ID_PATTERN = /^tt\d{7,8}$/;
const MAX_SEGMENT_MS = 24 * 60 * 60 * 1000;
const SEGMENT_FIELDS = [
  ["intro", "intro"],
  ["recap", "recap"],
  ["outro", "outro"],
  ["post_credits", "postCredits"],
] as const;

/**
 * Fetch the aggregated segments for one episode. IntroDB reads are public and
 * rate limited, so callers must store the result; `undefined` means the
 * episode has no data yet (HTTP 404), not that the service is broken.
 */
export async function fetchIntroDbSegments(
  config: IntroDbConfig,
  imdbId: string,
  season: number,
  episode: number,
): Promise<IntroDbSegments | undefined> {
  if (!IMDB_ID_PATTERN.test(imdbId)) {
    throw new UpstreamError(
      "introdb",
      "invalid_response",
      "IntroDB needs a valid IMDb id",
    );
  }
  if (
    !Number.isSafeInteger(season) ||
    season < 0 ||
    !Number.isSafeInteger(episode) ||
    episode < 0
  ) {
    throw new UpstreamError(
      "introdb",
      "invalid_response",
      "IntroDB needs valid season and episode numbers",
    );
  }

  const query = new URLSearchParams({
    imdb_id: imdbId,
    season: String(season),
    episode: String(episode),
  });

  let body: unknown;
  try {
    body = await fetchJson<unknown>(
      "introdb",
      `${config.url}/segments?${query.toString()}`,
      { timeoutMs: config.timeoutMs },
    );
  } catch (error) {
    if (isUpstreamNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  return mapIntroDbSegments(body);
}

/** Validate an IntroDB response; any unusable field is simply dropped. */
export function mapIntroDbSegments(body: unknown): IntroDbSegments | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const segments: IntroDbSegments = {};
  for (const [field, key] of SEGMENT_FIELDS) {
    const segment = mapSegment(body[field]);
    if (segment) {
      segments[key] = segment;
    }
  }
  return Object.keys(segments).length > 0 ? segments : undefined;
}

function mapSegment(value: unknown): IntroDbSegment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const startMs = value.start_ms;
  const endMs = value.end_ms;
  if (
    typeof startMs !== "number" ||
    typeof endMs !== "number" ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs > MAX_SEGMENT_MS ||
    endMs <= startMs
  ) {
    return undefined;
  }
  return {
    startSec: startMs / 1000,
    endSec: endMs / 1000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
