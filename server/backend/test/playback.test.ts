import { describe, expect, it } from "vitest";

import {
  availablePlaybackQualities,
  buildJellyfinHlsUrl,
  buildJellyfinStreamUrl,
  canBrowserDirectPlay,
  mapPlaybackItem,
  parsePlaybackQuality,
  parsePlaybackReport,
  playbackHlsPath,
  playbackReportBodies,
  playbackStreamPath,
  pickMediaSource,
} from "../src/playback.js";
import { ApiError } from "../src/errors.js";
import type { JellyfinItem } from "../src/upstream/jellyfin.js";

describe("playback URLs", () => {
  it("builds a same-origin stream path without a token", () => {
    expect(playbackStreamPath("item-1", "source-1", "session-1")).toBe(
      "/api/playback/items/item-1/stream?mediaSourceId=source-1&playSessionId=session-1",
    );
    expect(playbackStreamPath("item-1")).toBe(
      "/api/playback/items/item-1/stream",
    );
  });

  it("builds a same-origin HLS manifest path", () => {
    expect(playbackHlsPath("item-1", "source-1", "session-1")).toBe(
      "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1",
    );
  });

  it("builds a Jellyfin static stream URL on the public base path", () => {
    const url = buildJellyfinStreamUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      "source-1",
      "session-1",
      "user token+/=",
    );
    expect(url).toContain(
      "https://media.example.test/jellyfin/Videos/item-1/stream?",
    );
    expect(url).toContain("static=true");
    expect(url).toContain("mediaSourceId=source-1");
    expect(url).toContain("playSessionId=session-1");
    expect(url).toContain("api_key=user+token%2B%2F%3D");
  });

  it("builds a transcoding HLS URL with the source dimensions", () => {
    const url = buildJellyfinHlsUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      {
        Id: "source-1",
        Bitrate: 8_785_944,
        MediaStreams: [
          { Type: "Video", Codec: "hevc", Height: 822 },
          { Type: "Audio", Codec: "ac3", Channels: 6 },
        ],
      },
      "session-1",
      "user token",
    );
    expect(url).toContain(
      "https://media.example.test/jellyfin/Videos/item-1/master.m3u8?",
    );
    expect(url).toContain("VideoCodec=h264");
    expect(url).toContain("AudioCodec=aac");
    expect(url).toContain("MaxHeight=822");
    expect(url).toContain("VideoBitrate=8785944");
    expect(url).toContain("MediaSourceId=source-1");
    expect(url).toContain("PlaySessionId=session-1");
    expect(url).toContain("api_key=user+token");
  });
});

describe("browser direct play compatibility", () => {
  it("rejects MKV with HEVC video and AC3 audio", () => {
    expect(
      canBrowserDirectPlay({
        Id: "source-1",
        Container: "mkv",
        SupportsDirectPlay: true,
        MediaStreams: [
          { Type: "Video", Codec: "hevc" },
          { Type: "Audio", Codec: "ac3" },
        ],
      }),
    ).toBe(false);
  });

  it("accepts MP4 with H.264 and AAC", () => {
    expect(
      canBrowserDirectPlay({
        Id: "source-1",
        Container: "mp4",
        SupportsDirectPlay: true,
        MediaStreams: [
          { Type: "Video", Codec: "h264" },
          { Type: "Audio", Codec: "aac" },
        ],
      }),
    ).toBe(true);
  });

  it("trusts direct play when streams are omitted", () => {
    expect(
      canBrowserDirectPlay({ SupportsDirectPlay: true }),
    ).toBe(true);
    expect(
      canBrowserDirectPlay({ SupportsDirectPlay: false }),
    ).toBe(false);
  });
});

describe("playback media sources", () => {
  it("picks the first source with an id and reports direct play", () => {
    expect(
      pickMediaSource({
        PlaySessionId: "session-1",
        MediaSources: [
          { Id: "source-1", SupportsDirectPlay: true },
          { Id: "source-2", SupportsDirectPlay: false },
        ],
      }),
    ).toMatchObject({
      playSessionId: "session-1",
      directPlay: true,
      source: { Id: "source-1" },
    });
  });

  it("falls back to a source without an id and marks directPlay false", () => {
    expect(
      pickMediaSource({ MediaSources: [{ SupportsDirectPlay: false }] }),
    ).toMatchObject({ directPlay: false });
  });
});

describe("playback item mapping", () => {
  const item: JellyfinItem = {
    Id: "item-1",
    Name: "Pilot",
    Type: "Episode",
    SeriesName: "Example Show",
    SeriesId: "series-1",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    ProductionYear: 2020,
    Overview: "An episode.",
    RunTimeTicks: 30_000_000_000,
    ImageTags: { Primary: "tag-1" },
    UserData: { PlaybackPositionTicks: 12_000_000, Played: false },
  };

  it("maps resume state, episode metadata and image proxy URL", () => {
    expect(
      mapPlaybackItem(
        item,
        { Id: "source-1", SupportsDirectPlay: true },
        "session-1",
        "/api/playback/items/item-1/stream",
      ),
    ).toMatchObject({
      id: "item-1",
      type: "Episode",
      name: "Pilot",
      seriesName: "Example Show",
      seriesId: "series-1",
      seasonNumber: 1,
      episodeNumber: 2,
      year: 2020,
      overview: "An episode.",
      runtimeTicks: 30_000_000_000,
      positionTicks: 12_000_000,
      played: false,
      imageUrl: "/api/library/images/item-1?tag=tag-1",
      streamUrl: "/api/playback/items/item-1/stream",
      playSessionId: "session-1",
      mediaSourceId: "source-1",
      directPlay: true,
    });
  });

  it("drops unsupported or incomplete items", () => {
    expect(mapPlaybackItem({ Id: "x", Name: "Song", Type: "Audio" }, undefined, undefined, "/x")).toBeNull();
    expect(mapPlaybackItem({ Name: "No id", Type: "Movie" }, undefined, undefined, "/x")).toBeNull();
  });
});

describe("playback report parsing", () => {
  it("accepts a complete report", () => {
    expect(
      parsePlaybackReport({
        positionTicks: 123,
        playSessionId: "session-1",
        mediaSourceId: "source-1",
        isPaused: true,
        ignored: "x",
      }),
    ).toEqual({
      positionTicks: 123,
      playSessionId: "session-1",
      mediaSourceId: "source-1",
      isPaused: true,
    });
  });

  it("accepts an empty report", () => {
    expect(parsePlaybackReport(undefined)).toEqual({});
  });

  it("rejects invalid ticks, booleans and ids", () => {
    expect(() => parsePlaybackReport({ positionTicks: -1 })).toThrow(ApiError);
    expect(() => parsePlaybackReport({ positionTicks: 1.5 })).toThrow(ApiError);
    expect(() => parsePlaybackReport({ positionTicks: "1" })).toThrow(ApiError);
    expect(() => parsePlaybackReport({ isPaused: "yes" })).toThrow(ApiError);
    expect(() => parsePlaybackReport({ playSessionId: "bad id" })).toThrow(ApiError);
    expect(() => parsePlaybackReport({ mediaSourceId: "" })).toThrow(ApiError);
  });

  it("builds PascalCase start, progress and stop payloads", () => {
    const bodies = playbackReportBodies("item-1", {
      positionTicks: 500,
      playSessionId: "session-1",
      mediaSourceId: "source-1",
      isPaused: true,
    });

    expect(bodies.start).toEqual({
      ItemId: "item-1",
      MediaSourceId: "source-1",
      PlaySessionId: "session-1",
      PositionTicks: 500,
      CanSeek: true,
      IsMuted: false,
      PlayMethod: "DirectPlay",
      IsPaused: true,
    });
    expect(bodies.progress.IsPaused).toBe(true);
    expect(bodies.stop).toEqual({
      ItemId: "item-1",
      MediaSourceId: "source-1",
      PlaySessionId: "session-1",
      PositionTicks: 500,
      Failed: false,
    });
  });
});

describe("playback quality presets", () => {
  const hdSource = {
    Id: "source-1",
    Bitrate: 15_000_000,
    MediaStreams: [
      { Type: "Video", Codec: "hevc", Height: 1080 },
      { Type: "Audio", Codec: "ac3", Channels: 6 },
    ],
  };

  it("caps bitrate and resolution for each tier", () => {
    const medium = buildJellyfinHlsUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      hdSource,
      "session-1",
      "token",
      "medium",
    );
    expect(medium).toContain("MaxHeight=720");
    expect(medium).toContain("VideoBitrate=5000000");

    const low = buildJellyfinHlsUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      hdSource,
      "session-1",
      "token",
      "low",
    );
    expect(low).toContain("MaxHeight=480");
    expect(low).toContain("VideoBitrate=2000000");
  });

  it("never encodes above the source", () => {
    const url = buildJellyfinHlsUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      {
        Bitrate: 1_500_000,
        MediaStreams: [{ Type: "Video", Codec: "h264", Height: 576 }],
      },
      undefined,
      "token",
      "low",
    );
    expect(url).toContain("MaxHeight=480");
    expect(url).toContain("VideoBitrate=1500000");
  });

  it("keeps the source resolution and bitrate for max", () => {
    const url = buildJellyfinHlsUrl(
      "https://media.example.test/jellyfin",
      "item-1",
      {
        Bitrate: 30_000_000,
        MediaStreams: [{ Type: "Video", Codec: "hevc", Height: 2160 }],
      },
      undefined,
      "token",
      "max",
    );
    expect(url).toContain("MaxHeight=2160");
    expect(url).toContain("VideoBitrate=20000000");
  });

  it("offers every tier below a large source", () => {
    expect(availablePlaybackQualities(hdSource)).toEqual([
      { id: "max", label: "Max", detail: "Original quality" },
      { id: "high", label: "High", detail: "1080p · 10 Mbps" },
      { id: "medium", label: "Medium", detail: "720p · 5 Mbps" },
      { id: "low", label: "Low", detail: "480p · 2 Mbps" },
    ]);
  });

  it("hides tiers the source is already below", () => {
    const mkvSource = {
      Bitrate: 8_785_944,
      MediaStreams: [{ Type: "Video", Codec: "hevc", Height: 822 }],
    };
    expect(availablePlaybackQualities(mkvSource).map((option) => option.id)).toEqual([
      "max",
      "medium",
      "low",
    ]);

    const lightSource = {
      Bitrate: 3_000_000,
      MediaStreams: [{ Type: "Video", Codec: "h264", Height: 720 }],
    };
    expect(availablePlaybackQualities(lightSource).map((option) => option.id)).toEqual([
      "max",
      "low",
    ]);

    const tinySource = {
      Bitrate: 1_000_000,
      MediaStreams: [{ Type: "Video", Codec: "h264", Height: 480 }],
    };
    expect(availablePlaybackQualities(tinySource).map((option) => option.id)).toEqual([
      "max",
    ]);
    expect(availablePlaybackQualities(undefined).map((option) => option.id)).toEqual([
      "max",
      "medium",
      "low",
    ]);
  });

  it("parses valid quality values and rejects the rest", () => {
    expect(parsePlaybackQuality(undefined)).toBe("max");
    expect(parsePlaybackQuality("medium")).toBe("medium");
    expect(() => parsePlaybackQuality("ultra")).toThrow(ApiError);
    expect(() => parsePlaybackQuality(720)).toThrow(ApiError);
  });

  it("adds the quality to the same-origin HLS path only when transcoding", () => {
    expect(playbackHlsPath("item-1", "source-1", "session-1", "medium")).toBe(
      "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1&quality=medium",
    );
    expect(playbackHlsPath("item-1", "source-1", "session-1", "max")).toBe(
      "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1",
    );
  });

  it("exposes the applied quality and the selectable presets", () => {
    const mapped = mapPlaybackItem(
      { Id: "item-1", Name: "Film", Type: "Movie" },
      hdSource,
      "session-1",
      "/api/playback/items/item-1/hls.m3u8?quality=low",
      false,
      "low",
    );
    expect(mapped).toMatchObject({
      quality: "low",
      playbackMethod: "hls",
      directPlay: false,
    });
    expect(mapped?.qualities).toHaveLength(4);
  });
});

describe("playback report play method", () => {
  it("reports HLS sessions as transcodes", () => {
    expect(parsePlaybackReport({ playbackMethod: "hls" })).toEqual({
      playbackMethod: "hls",
    });
    expect(() => parsePlaybackReport({ playbackMethod: "stream" })).toThrow(ApiError);
    expect(
      playbackReportBodies("item-1", {
        playbackMethod: "hls",
        playSessionId: "session-1",
      }).start.PlayMethod,
    ).toBe("Transcode");
    expect(playbackReportBodies("item-1", {}).start.PlayMethod).toBe("DirectPlay");
  });
});
