import { ApiError } from "./errors.js";

/**
 * What each kind of client can play, so the server decides direct play and
 * builds the right transcode for it, in one tested place. A client names
 * itself with `?client=` on the playback routes; the dashboard sends nothing
 * and gets `web`.
 */
export type PlaybackClientId = "web" | "tvos";

export const PLAYBACK_CLIENTS: readonly PlaybackClientId[] = ["web", "tvos"];

export interface PlaybackClientProfile {
  /** Files the client can play as they are. */
  directPlay: {
    containers: ReadonlySet<string>;
    videoCodecs: ReadonlySet<string>;
    audioCodecs: ReadonlySet<string>;
  };
  /** How Jellyfin should stream everything else, as HLS. */
  hls: {
    /** Jellyfin codec names, preferred first. */
    videoCodecs: string;
    audioCodecs: string;
    maxAudioChannels: number;
    audioBitrate: number;
    segmentContainer: "ts" | "mp4";
    /**
     * At Max quality, copy video and audio the client can decode instead of
     * re-encoding them (Jellyfin then only repackages the file).
     */
    copyAtMax: boolean;
    /** List text subtitles inside the playlist, for players that pick them there. */
    subtitlesInManifest: boolean;
  };
}

export const PLAYBACK_CLIENT_PROFILES: Record<PlaybackClientId, PlaybackClientProfile> = {
  /** Browsers: what every current browser decodes; H.264/AAC stereo otherwise. */
  web: {
    directPlay: {
      containers: new Set(["mp4", "m4v", "mov", "webm"]),
      videoCodecs: new Set(["h264", "avc1", "vp8", "vp9", "av1"]),
      audioCodecs: new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm"]),
    },
    hls: {
      videoCodecs: "h264",
      audioCodecs: "aac",
      maxAudioChannels: 2,
      audioBitrate: 192_000,
      segmentContainer: "ts",
      copyAtMax: false,
      subtitlesInManifest: false,
    },
  },
  /**
   * Apple TV with AVPlayer: MP4/MOV with H.264 or HEVC (including HDR10 and
   * Dolby Vision 5 and 8), and AAC, AC-3 or E-AC-3 audio (E-AC-3 carries
   * Atmos). MKV is repackaged into fragmented MP4, which HEVC over HLS needs;
   * DTS and TrueHD become E-AC-3 5.1. Text subtitles are listed in the
   * playlist, where AVPlayer looks for them.
   */
  tvos: {
    directPlay: {
      containers: new Set(["mp4", "m4v", "mov"]),
      videoCodecs: new Set(["h264", "avc1", "hevc", "h265", "hvc1"]),
      audioCodecs: new Set(["aac", "ac3", "eac3", "alac", "mp3", "flac"]),
    },
    hls: {
      videoCodecs: "hevc,h264",
      audioCodecs: "eac3,ac3,aac",
      maxAudioChannels: 6,
      audioBitrate: 640_000,
      segmentContainer: "mp4",
      copyAtMax: true,
      subtitlesInManifest: true,
    },
  },
};

/** Validate a `client` query value; missing means the dashboard (`web`). */
export function parsePlaybackClient(value: unknown): PlaybackClientId {
  if (value === undefined) {
    return "web";
  }
  if (typeof value === "string" && (PLAYBACK_CLIENTS as readonly string[]).includes(value)) {
    return value as PlaybackClientId;
  }
  throw new ApiError(400, "invalid_client", `client must be one of: ${PLAYBACK_CLIENTS.join(", ")}`);
}
