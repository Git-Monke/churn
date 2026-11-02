import { ApiError } from "./errors.js";
import type {
  JellyfinItem,
  JellyfinMediaSource,
  PlaybackInfoResponse,
  PlaybackProgressInfo,
  PlaybackStartInfo,
  PlaybackStopInfo,
} from "./upstream/jellyfin.js";

export type PlaybackState = "ok" | "unauthorized" | "unreachable";

export interface PlaybackItem {
  id: string;
  type: "Movie" | "Episode";
  name: string;
  seriesName?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  overview?: string;
  runtimeTicks?: number;
  positionTicks?: number;
  played?: boolean;
  imageUrl?: string;
  /** Same-origin redirect endpoint; never contains the Jellyfin token. */
  streamUrl: string;
  playSessionId?: string;
  mediaSourceId?: string;
  directPlay: boolean;
  playbackMethod: "direct" | "hls";
}

export interface PlaybackItemResponse {
  state: PlaybackState;
  detail?: string;
  item?: PlaybackItem;
}

export interface PlaybackReportInput {
  positionTicks?: number;
  playSessionId?: string;
  mediaSourceId?: string;
  isPaused?: boolean;
}

export interface PlaybackReportBodies {
  start: PlaybackStartInfo;
  progress: PlaybackProgressInfo;
  stop: PlaybackStopInfo;
}

const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const DIRECT_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm"]);
const DIRECT_VIDEO_CODECS = new Set(["h264", "avc1", "vp8", "vp9", "av1"]);
const DIRECT_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
  "pcm",
]);

/** Build the same-origin URL the browser puts on `<video src>`. */
export function playbackStreamPath(
  itemId: string,
  mediaSourceId?: string,
  playSessionId?: string,
): string {
  const params = new URLSearchParams();
  if (mediaSourceId) {
    params.set("mediaSourceId", mediaSourceId);
  }
  if (playSessionId) {
    params.set("playSessionId", playSessionId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/api/playback/items/${encodeURIComponent(itemId)}/stream${suffix}`;
}

/** Same-origin HLS manifest URL used when the source needs transcoding. */
export function playbackHlsPath(
  itemId: string,
  mediaSourceId?: string,
  playSessionId?: string,
): string {
  const params = new URLSearchParams();
  if (mediaSourceId) {
    params.set("mediaSourceId", mediaSourceId);
  }
  if (playSessionId) {
    params.set("playSessionId", playSessionId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/api/playback/items/${encodeURIComponent(itemId)}/hls.m3u8${suffix}`;
}

/**
 * Jellyfin's direct-play flag only means the server can serve the original
 * file. It does not mean a browser can decode it (for example HEVC video with
 * AC3 audio inside an MKV). Only use direct play for containers/codecs that
 * browsers reliably support.
 */
export function canBrowserDirectPlay(
  source: JellyfinMediaSource | undefined,
): boolean {
  if (!source || source.SupportsDirectPlay !== true) {
    return false;
  }

  const containers = (source.Container ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (
    containers.length > 0 &&
    !containers.some((container) => DIRECT_CONTAINERS.has(container))
  ) {
    return false;
  }

  const streams = source.MediaStreams ?? [];
  if (streams.length === 0) {
    // Older Jellyfin responses may omit streams; trust SupportsDirectPlay.
    return true;
  }

  const video = streams.filter((stream) => stream.Type === "Video");
  const audio = streams.filter((stream) => stream.Type === "Audio");
  if (video.length === 0) {
    return false;
  }

  return (
    video.every(
      (stream) =>
        stream.Codec !== undefined &&
        DIRECT_VIDEO_CODECS.has(stream.Codec.toLowerCase()),
    ) &&
    audio.every(
      (stream) =>
        stream.Codec !== undefined &&
        DIRECT_AUDIO_CODECS.has(stream.Codec.toLowerCase()),
    )
  );
}

/**
 * Build the Jellyfin URL behind the redirect. Concatenate instead of using
 * `new URL("/...")` so a public URL with a base path survives.
 */
export function buildJellyfinStreamUrl(
  publicUrl: string,
  itemId: string,
  mediaSourceId: string | undefined,
  playSessionId: string | undefined,
  token: string,
): string {
  const params = new URLSearchParams({ static: "true" });
  if (mediaSourceId) {
    params.set("mediaSourceId", mediaSourceId);
  }
  if (playSessionId) {
    params.set("playSessionId", playSessionId);
  }
  params.set("api_key", token);
  return `${publicUrl}/Videos/${encodeURIComponent(itemId)}/stream?${params.toString()}`;
}

/**
 * Build a Jellyfin HLS manifest URL. Explicit codec/bitrate parameters are
 * required; without them Jellyfin picks its tiny default transcode profile.
 */
export function buildJellyfinHlsUrl(
  publicUrl: string,
  itemId: string,
  source: JellyfinMediaSource | undefined,
  playSessionId: string | undefined,
  token: string,
): string {
  const video = source?.MediaStreams?.find((stream) => stream.Type === "Video");
  const maxHeight = clamp(
    Math.round(video?.Height ?? 1080),
    240,
    2160,
  );
  const videoBitrate = clamp(
    Math.round(source?.Bitrate ?? video?.BitRate ?? 8_000_000),
    1_000_000,
    20_000_000,
  );

  const params = new URLSearchParams({
    VideoCodec: "h264",
    AudioCodec: "aac",
    MaxAudioChannels: "2",
    AudioBitrate: "192000",
    MaxHeight: String(maxHeight),
    VideoBitrate: String(videoBitrate),
    SegmentContainer: "ts",
  });
  if (source?.Id) {
    params.set("MediaSourceId", source.Id);
  }
  if (playSessionId) {
    params.set("PlaySessionId", playSessionId);
  }
  params.set("api_key", token);
  return `${publicUrl}/Videos/${encodeURIComponent(itemId)}/master.m3u8?${params.toString()}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pickMediaSource(
  info: PlaybackInfoResponse,
): { source?: JellyfinMediaSource; playSessionId?: string; directPlay: boolean } {
  const source =
    info.MediaSources?.find((candidate) => Boolean(candidate.Id)) ??
    info.MediaSources?.[0];
  return {
    source,
    playSessionId: info.PlaySessionId,
    directPlay: source?.SupportsDirectPlay === true,
  };
}

export function mapPlaybackItem(
  item: JellyfinItem,
  source: JellyfinMediaSource | undefined,
  playSessionId: string | undefined,
  streamUrl: string,
  directPlay = canBrowserDirectPlay(source),
): PlaybackItem | null {
  if (
    !item.Id ||
    !item.Name ||
    (item.Type !== "Movie" && item.Type !== "Episode")
  ) {
    return null;
  }

  const tag = item.ImageTags?.Primary;
  const playback: PlaybackItem = {
    id: item.Id,
    type: item.Type,
    name: item.Name,
    streamUrl,
    directPlay,
    playbackMethod: directPlay ? "direct" : "hls",
  };

  assignIfDefined(playback, "seriesName", item.SeriesName);
  assignIfDefined(playback, "seriesId", item.SeriesId);
  assignIfDefined(playback, "seasonNumber", item.ParentIndexNumber);
  assignIfDefined(playback, "episodeNumber", item.IndexNumber);
  assignIfDefined(playback, "year", item.ProductionYear);
  assignIfDefined(playback, "overview", item.Overview);
  assignIfDefined(playback, "runtimeTicks", item.RunTimeTicks);
  assignIfDefined(
    playback,
    "positionTicks",
    item.UserData?.PlaybackPositionTicks,
  );
  assignIfDefined(playback, "played", item.UserData?.Played);
  assignIfDefined(
    playback,
    "imageUrl",
    tag
      ? `/api/library/images/${encodeURIComponent(item.Id)}?tag=${encodeURIComponent(tag)}`
      : undefined,
  );
  assignIfDefined(playback, "playSessionId", playSessionId);
  assignIfDefined(playback, "mediaSourceId", source?.Id);

  return playback;
}

/** Validate a report body; unknown keys are ignored. */
export function parsePlaybackReport(body: unknown): PlaybackReportInput {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_playback_report", "Playback report must be an object");
  }
  const input = body as Record<string, unknown>;
  const report: PlaybackReportInput = {};

  if (input.positionTicks !== undefined) {
    const ticks = input.positionTicks;
    if (
      typeof ticks !== "number" ||
      !Number.isSafeInteger(ticks) ||
      ticks < 0
    ) {
      throw new ApiError(
        400,
        "invalid_playback_report",
        "positionTicks must be a non-negative integer",
      );
    }
    report.positionTicks = ticks;
  }
  if (input.playSessionId !== undefined) {
    report.playSessionId = validateId(input.playSessionId, "playSessionId");
  }
  if (input.mediaSourceId !== undefined) {
    report.mediaSourceId = validateId(input.mediaSourceId, "mediaSourceId");
  }
  if (input.isPaused !== undefined) {
    if (typeof input.isPaused !== "boolean") {
      throw new ApiError(
        400,
        "invalid_playback_report",
        "isPaused must be a boolean",
      );
    }
    report.isPaused = input.isPaused;
  }

  return report;
}

export function playbackReportBodies(
  itemId: string,
  input: PlaybackReportInput,
): PlaybackReportBodies {
  const base = {
    ItemId: itemId,
    MediaSourceId: input.mediaSourceId,
    PlaySessionId: input.playSessionId,
    PositionTicks: input.positionTicks,
    CanSeek: true,
    IsMuted: false,
    PlayMethod: "DirectPlay" as const,
  };
  const isPaused = input.isPaused ?? false;

  return {
    start: { ...base, IsPaused: isPaused },
    progress: { ...base, IsPaused: isPaused },
    stop: {
      ItemId: itemId,
      MediaSourceId: input.mediaSourceId,
      PlaySessionId: input.playSessionId,
      PositionTicks: input.positionTicks,
      Failed: false,
    },
  };
}

function validateId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_playback_report", `Invalid ${name}`);
  }
  return value;
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
