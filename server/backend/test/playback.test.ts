import { describe, expect, it } from "vitest";

import {
  buildJellyfinHlsUrl,
  buildJellyfinStreamUrl,
  canBrowserDirectPlay,
  mapPlaybackItem,
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
