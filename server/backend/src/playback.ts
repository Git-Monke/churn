import { ApiError } from "./errors.js";
import { PLAYBACK_CLIENT_PROFILES, type PlaybackClientId } from "./playback-clients.js";
import type { IntroDbSegments } from "./introdb.js";
import type {
  JellyfinItem,
  JellyfinMediaSource,
  PlaybackInfoResponse,
  PlaybackProgressInfo,
  PlaybackStartInfo,
  PlaybackStopInfo,
} from "./upstream/jellyfin.js";

export type PlaybackState = "ok" | "unauthorized" | "unreachable";

export type PlaybackQuality = "max" | "high" | "medium" | "low";

export interface PlaybackQualityOption {
  id: PlaybackQuality;
  label: string;
  /** Pre-formatted caps, e.g. "720p · 5 Mbps". */
  detail: string;
}

export interface QualityTranscodeCaps {
  height: number;
  bitrate: number;
}

export const PLAYBACK_QUALITIES: readonly PlaybackQuality[] = [
  "max",
  "high",
  "medium",
  "low",
];

/**
 * Transcode presets offered in the player. `max` is the original file: direct
 * play when the browser can decode it, otherwise today's source-bitrate
 * transcode. The other tiers cap both resolution and bitrate; Jellyfin scales
 * down during the H.264 encode it already does.
 */
export const QUALITY_PRESETS: Record<
  PlaybackQuality,
  { label: string; maxHeight?: number; bitrate?: number }
> = {
  max: { label: "Max" },
  high: { label: "High", maxHeight: 1080, bitrate: 10_000_000 },
  medium: { label: "Medium", maxHeight: 720, bitrate: 5_000_000 },
  low: { label: "Low", maxHeight: 480, bitrate: 2_000_000 },
};

const DEFAULT_SOURCE_BITRATE = 8_000_000;
const MIN_TRANSCODE_BITRATE = 1_000_000;
const MAX_TRANSCODE_BITRATE = 20_000_000;
const MIN_TRANSCODE_HEIGHT = 240;
const MAX_TRANSCODE_HEIGHT = 2160;

export interface PlaybackItem {
  id: string;
  type: "Movie" | "Episode";
  name: string;
  seriesName?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  /** Content rating such as `TV-PG`; movies only in practice. */
  officialRating?: string;
  /** ISO air date for episodes (`2009-04-16T00:00:00.0000000Z`). */
  premiereDate?: string;
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
  /** The client profile the stream was chosen for (`?client=`). */
  client: PlaybackClientId;
  quality: PlaybackQuality;
  /** Selectable presets for this source; always contains `max`. */
  qualities: PlaybackQualityOption[];
  /** Text subtitle tracks the browser can render as WebVTT overlays. */
  subtitles: PlaybackSubtitle[];
  /** The next episode in Jellyfin's list, when this item is an episode. */
  nextEpisode?: PlaybackNextEpisode;
  /**
   * Intro/recap/credits ranges warmed from IntroDB when the season or episode
   * was grabbed. Absent when there is no cached data for this episode.
   */
  segments?: IntroDbSegments;
}

export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface PlaybackSubtitle {
  /** Jellyfin stream index; stable per item, not across episodes. */
  index: number;
  /** Container track name such as `English [SDH]`, when tagged. */
  title?: string;
  language?: string;
  /** Same-origin WebVTT proxy; never contains the Jellyfin token. */
  url: string;
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
  playbackMethod?: "direct" | "hls";
}

export interface PlaybackReportBodies {
  start: PlaybackStartInfo;
  progress: PlaybackProgressInfo;
  stop: PlaybackStopInfo;
}

const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

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
  quality?: PlaybackQuality,
  client: PlaybackClientId = "web",
): string {
  const params = new URLSearchParams();
  if (mediaSourceId) {
    params.set("mediaSourceId", mediaSourceId);
  }
  if (playSessionId) {
    params.set("playSessionId", playSessionId);
  }
  if (quality && quality !== "max") {
    params.set("quality", quality);
  }
  if (client !== "web") {
    params.set("client", client);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/api/playback/items/${encodeURIComponent(itemId)}/hls.m3u8${suffix}`;
}

/**
 * Subtitle codecs Jellyfin can convert to WebVTT. Bitmap tracks (PGS, DVDSUB)
 * are not listed: they would have to be burned into a transcode.
 */
const TEXT_SUBTITLE_CODECS: Record<string, true> = {
  subrip: true,
  srt: true,
  ass: true,
  ssa: true,
  webvtt: true,
  vtt: true,
  mov_text: true,
  text: true,
};

/** Same-origin WebVTT proxy URL for one subtitle stream. */
export function subtitleTrackPath(
  itemId: string,
  mediaSourceId: string,
  index: number,
): string {
  const params = new URLSearchParams({ mediaSourceId });
  return `/api/playback/items/${encodeURIComponent(itemId)}/subtitles/${index}?${params.toString()}`;
}

/** Validate a `quality` query value; missing means the original stream. */
export function parsePlaybackQuality(value: unknown): PlaybackQuality {
  if (value === undefined) {
    return "max";
  }
  if (
    typeof value === "string" &&
    (PLAYBACK_QUALITIES as readonly string[]).includes(value)
  ) {
    return value as PlaybackQuality;
  }
  throw new ApiError(
    400,
    "invalid_quality",
    "quality must be max, high, medium or low",
  );
}

function sourceBitrate(source: JellyfinMediaSource | undefined): number {
  const video = source?.MediaStreams?.find((stream) => stream.Type === "Video");
  return Math.round(
    source?.Bitrate ?? video?.BitRate ?? DEFAULT_SOURCE_BITRATE,
  );
}

/** Caps the original file needs when the browser cannot direct-play it. */
function sourceTranscodeCaps(
  source: JellyfinMediaSource | undefined,
): QualityTranscodeCaps {
  const video = source?.MediaStreams?.find((stream) => stream.Type === "Video");
  return {
    height: clamp(
      Math.round(video?.Height ?? 1080),
      MIN_TRANSCODE_HEIGHT,
      MAX_TRANSCODE_HEIGHT,
    ),
    bitrate: clamp(
      sourceBitrate(source),
      MIN_TRANSCODE_BITRATE,
      MAX_TRANSCODE_BITRATE,
    ),
  };
}

/**
 * Effective transcode caps for a preset. Presets never exceed the source, so a
 * 10 Mbps tier on a 3 Mbps file encodes at 3 Mbps and a 1080p tier on a 720p
 * file stays at 720p.
 */
export function qualityTranscodeCaps(
  source: JellyfinMediaSource | undefined,
  quality: PlaybackQuality = "max",
): QualityTranscodeCaps {
  const base = sourceTranscodeCaps(source);
  const preset = QUALITY_PRESETS[quality];
  if (preset.maxHeight === undefined || preset.bitrate === undefined) {
    return base;
  }
  return {
    height: clamp(
      Math.min(preset.maxHeight, base.height),
      MIN_TRANSCODE_HEIGHT,
      MAX_TRANSCODE_HEIGHT,
    ),
    bitrate: clamp(
      Math.min(preset.bitrate, base.bitrate),
      MIN_TRANSCODE_BITRATE,
      MAX_TRANSCODE_BITRATE,
    ),
  };
}

/**
 * Presets worth offering: `max` plus every tier strictly lighter than the
 * source. A source already below the smallest tier gets no picker.
 */
export function availablePlaybackQualities(
  source: JellyfinMediaSource | undefined,
): PlaybackQualityOption[] {
  const originalBitrate = sourceBitrate(source);
  const options: PlaybackQualityOption[] = [
    { id: "max", label: QUALITY_PRESETS.max.label, detail: "Original quality" },
  ];
  for (const id of ["high", "medium", "low"] as const) {
    const preset = QUALITY_PRESETS[id];
    if (preset.bitrate === undefined || preset.bitrate >= originalBitrate) {
      continue;
    }
    options.push({
      id,
      label: preset.label,
      detail: formatQualityDetail(qualityTranscodeCaps(source, id)),
    });
  }
  return options;
}

function formatQualityDetail(caps: QualityTranscodeCaps): string {
  const mbps = caps.bitrate / 1_000_000;
  const bitrate = Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1);
  return `${caps.height}p · ${bitrate} Mbps`;
}

/**
 * Pick the first episode after the current `(season, episode)`. Season 0
 * specials stay in their own season; a special never rolls into season 1.
 */
export function pickNextEpisode(
  episodes: JellyfinItem[],
  current: { id?: string; seasonNumber?: number; episodeNumber?: number },
): PlaybackNextEpisode | undefined {
  const currentSeason = current.seasonNumber;
  const currentEpisode = current.episodeNumber;
  if (
    currentSeason === undefined ||
    currentEpisode === undefined ||
    !Number.isInteger(currentSeason) ||
    !Number.isInteger(currentEpisode)
  ) {
    return undefined;
  }

  const specialsOnly = currentSeason === 0;
  const byCode = new Map<string, PlaybackNextEpisode>();
  for (const episode of episodes) {
    if (episode.Type !== undefined && episode.Type !== "Episode") {
      continue;
    }
    if (!episode.Id || !episode.Name) {
      continue;
    }
    const season = episode.ParentIndexNumber;
    const number = episode.IndexNumber;
    if (
      season === undefined ||
      number === undefined ||
      !Number.isInteger(season) ||
      !Number.isInteger(number)
    ) {
      continue;
    }
    if (specialsOnly ? season !== 0 : season === 0) {
      continue;
    }
    const key = `${season}:${number}`;
    if (!byCode.has(key)) {
      byCode.set(key, {
        id: episode.Id,
        name: episode.Name,
        seasonNumber: season,
        episodeNumber: number,
      });
    }
  }

  const ordered = [...byCode.values()].sort(
    (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
  );
  return ordered.find(
    (episode) =>
      episode.seasonNumber > currentSeason ||
      (episode.seasonNumber === currentSeason &&
        episode.episodeNumber > currentEpisode),
  );
}

/**
 * Jellyfin's direct-play flag only means the server can serve the original
 * file. It does not mean the client can decode it (for example HEVC video
 * with AC3 audio inside an MKV in a browser). Direct play only when the
 * client's profile covers the container and every video and audio codec.
 */
export function canDirectPlay(
  source: JellyfinMediaSource | undefined,
  client: PlaybackClientId = "web",
): boolean {
  if (!source || source.SupportsDirectPlay !== true) {
    return false;
  }
  const profile = PLAYBACK_CLIENT_PROFILES[client].directPlay;

  const containers = (source.Container ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (
    containers.length > 0 &&
    !containers.some((container) => profile.containers.has(container))
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
        profile.videoCodecs.has(stream.Codec.toLowerCase()),
    ) &&
    audio.every(
      (stream) =>
        stream.Codec !== undefined &&
        profile.audioCodecs.has(stream.Codec.toLowerCase()),
    )
  );
}

/** The dashboard's rule: `canDirectPlay` for the `web` profile. */
export function canBrowserDirectPlay(source: JellyfinMediaSource | undefined): boolean {
  return canDirectPlay(source, "web");
}

/**
 * Build the upstream Jellyfin stream URL the backend proxies. Concatenate
 * instead of using `new URL("/...")` so a base path survives. The URL never
 * leaves the server; the client authenticates with headers.
 */
export function buildJellyfinStreamUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string | undefined,
  playSessionId: string | undefined,
): string {
  const params = new URLSearchParams({ static: "true" });
  if (mediaSourceId) {
    params.set("mediaSourceId", mediaSourceId);
  }
  if (playSessionId) {
    params.set("playSessionId", playSessionId);
  }
  return `${baseUrl}/Videos/${encodeURIComponent(itemId)}/stream?${params.toString()}`;
}

/**
 * Build the upstream Jellyfin HLS manifest URL. Explicit codec/bitrate
 * parameters are required; without them Jellyfin picks its tiny default
 * transcode profile. The URL is fetched server-side and never handed out.
 */
export function buildJellyfinHlsUrl(
  baseUrl: string,
  itemId: string,
  source: JellyfinMediaSource | undefined,
  playSessionId: string | undefined,
  quality: PlaybackQuality = "max",
  client: PlaybackClientId = "web",
): string {
  const hls = PLAYBACK_CLIENT_PROFILES[client].hls;
  const copy = hls.copyAtMax && quality === "max";
  const params = new URLSearchParams({
    VideoCodec: copy ? hls.videoCodecs : "h264",
    AudioCodec: hls.audioCodecs,
    MaxAudioChannels: String(hls.maxAudioChannels),
    AudioBitrate: String(hls.audioBitrate),
    SegmentContainer: hls.segmentContainer,
  });
  if (copy) {
    // Repackage what the client can decode; caps would force a re-encode of
    // anything above them, such as a 4K remux at 60 Mbps.
    params.set("AllowVideoStreamCopy", "true");
    params.set("AllowAudioStreamCopy", "true");
    params.set("VideoBitrate", String(Math.max(sourceBitrate(source), MIN_TRANSCODE_BITRATE)));
  } else {
    const { height: maxHeight, bitrate: videoBitrate } = qualityTranscodeCaps(source, quality);
    params.set("MaxHeight", String(maxHeight));
    params.set("VideoBitrate", String(videoBitrate));
  }
  if (hls.subtitlesInManifest) {
    params.set("EnableSubtitlesInManifest", "true");
    params.set("SubtitleMethod", "Hls");
  }
  if (source?.Id) {
    params.set("MediaSourceId", source.Id);
  }
  if (playSessionId) {
    params.set("PlaySessionId", playSessionId);
  }
  return `${baseUrl}/Videos/${encodeURIComponent(itemId)}/master.m3u8?${params.toString()}`;
}

/**
 * Repoint every URI in a Jellyfin HLS playlist at the same-origin asset proxy.
 * Relative and absolute URIs are both resolved against `upstreamUrl`; anything
 * outside `<basePath>/Videos/<itemId>/` is left untouched.
 */
export function rewriteHlsPlaylist(
  playlist: string,
  itemId: string,
  upstreamUrl: string,
  jellyfinBaseUrl: string,
): string {
  const basePath = new URL(jellyfinBaseUrl).pathname.replace(/\/+$/, "");
  const prefix = `${basePath}/Videos/${encodeURIComponent(itemId)}/`;
  const rewrite = (uri: string): string => {
    let resolved: URL;
    try {
      resolved = new URL(uri, upstreamUrl);
    } catch {
      return uri;
    }
    if (!resolved.pathname.startsWith(prefix)) {
      return uri;
    }
    resolved.searchParams.delete("api_key");
    const search =
      resolved.searchParams.size > 0 ? `?${resolved.searchParams.toString()}` : "";
    const asset = resolved.pathname.slice(prefix.length);
    return `/api/playback/items/${encodeURIComponent(itemId)}/jellyfin/${asset}${search}`;
  };
  return playlist
    .split(/\r?\n/)
    .map((line) =>
      line.startsWith("#")
        ? line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`)
        : line.trim() === ""
          ? line
          : rewrite(line.trim()),
    )
    .join("\n");
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

/**
 * Text subtitle streams the player can overlay. Bitmap tracks are skipped:
 * the player has no burn-in path, so listing them would offer a track that
 * cannot render.
 */
function mapSubtitles(
  itemId: string,
  source: JellyfinMediaSource | undefined,
): PlaybackSubtitle[] {
  if (!source?.Id) {
    return [];
  }
  const tracks: PlaybackSubtitle[] = [];
  for (const stream of source.MediaStreams ?? []) {
    if (
      stream.Type !== "Subtitle" ||
      stream.Index === undefined ||
      stream.Codec === undefined ||
      TEXT_SUBTITLE_CODECS[stream.Codec.toLowerCase()] !== true
    ) {
      continue;
    }
    const track: PlaybackSubtitle = {
      index: stream.Index,
      url: subtitleTrackPath(itemId, source.Id, stream.Index),
    };
    if (stream.Title) {
      track.title = stream.Title;
    }
    if (stream.Language) {
      track.language = stream.Language;
    }
    tracks.push(track);
  }
  return tracks;
}

export function mapPlaybackItem(
  item: JellyfinItem,
  source: JellyfinMediaSource | undefined,
  playSessionId: string | undefined,
  streamUrl: string,
  directPlay = canBrowserDirectPlay(source),
  quality: PlaybackQuality = "max",
  client: PlaybackClientId = "web",
): PlaybackItem | null {
  if (
    !item.Id ||
    !item.Name ||
    (item.Type !== "Movie" && item.Type !== "Episode")
  ) {
    return null;
  }

  const itemId = item.Id;
  const tag = item.ImageTags?.Primary;
  const playback: PlaybackItem = {
    id: itemId,
    type: item.Type,
    name: item.Name,
    streamUrl,
    directPlay,
    playbackMethod: directPlay ? "direct" : "hls",
    client,
    quality,
    qualities: availablePlaybackQualities(source),
    subtitles: mapSubtitles(itemId, source),
  };

  assignIfDefined(playback, "seriesName", item.SeriesName);
  assignIfDefined(playback, "seriesId", item.SeriesId);
  assignIfDefined(playback, "seasonNumber", item.ParentIndexNumber);
  assignIfDefined(playback, "episodeNumber", item.IndexNumber);
  assignIfDefined(playback, "year", item.ProductionYear);
  assignIfDefined(playback, "officialRating", item.OfficialRating);
  assignIfDefined(playback, "premiereDate", item.PremiereDate);
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
  if (input.playbackMethod !== undefined) {
    if (input.playbackMethod !== "direct" && input.playbackMethod !== "hls") {
      throw new ApiError(
        400,
        "invalid_playback_report",
        "playbackMethod must be direct or hls",
      );
    }
    report.playbackMethod = input.playbackMethod;
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
    // HLS sessions are Jellyfin transcodes; saying DirectPlay would make the
    // dashboard claim the original file is being streamed.
    PlayMethod: (input.playbackMethod === "hls"
      ? "Transcode"
      : "DirectPlay") as "DirectPlay" | "Transcode",
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
