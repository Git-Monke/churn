import { afterEach, describe, expect, it, vi } from "vitest";

import { createJellyfinClient, mapJellyfinItem } from "../src/upstream/jellyfin.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jellyfin item mapping", () => {
  it("maps movies and series to the frontend contract", () => {
    expect(
      mapJellyfinItem({
        Id: "abc123",
        Name: "Example Movie",
        Type: "Movie",
        ProductionYear: 2020,
        RunTimeTicks: 7_200_000_000,
        CommunityRating: 8.2,
        OfficialRating: "PG-13",
        Overview: "A film.",
        ImageTags: { Primary: "tag-1" },
      }),
    ).toEqual({
      id: "abc123",
      name: "Example Movie",
      type: "Movie",
      year: 2020,
      overview: "A film.",
      rating: 8.2,
      officialRating: "PG-13",
      runtimeMinutes: 12,
      imageUrl: "/api/library/images/abc123?tag=tag-1",
    });
  });

  it("omits the image URL when there is no primary image", () => {
    const item = mapJellyfinItem({ Id: "x", Name: "Show", Type: "Series" });
    expect(item?.imageUrl).toBeUndefined();
  });

  it("drops unsupported or incomplete items", () => {
    expect(mapJellyfinItem({ Id: "x", Name: "Song", Type: "Audio" })).toBeNull();
    expect(mapJellyfinItem({ Name: "No id", Type: "Movie" })).toBeNull();
    expect(mapJellyfinItem({ Id: "x", Type: "Movie" })).toBeNull();
  });
});


describe("Jellyfin authentication client", () => {
  const config = {
    id: "jellyfin" as const,
    name: "Jellyfin",
    url: "http://jellyfin.test:8096",
    apiKey: "api-key",
  };

  it("authenticates with the device header and returns the user", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://jellyfin.test:8096/Users/AuthenticateByName");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization:
          'MediaBrowser Client="Churn", Device="Churn Web", DeviceId="churn-web", Version="0.1.0"',
        "X-Emby-Device-Id": "churn-web",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        Username: "admin",
        Pw: "secret",
      });
      return new Response(
        JSON.stringify({
          AccessToken: "user-token",
          User: { Id: "user-1", Name: "admin", Policy: { IsAdministrator: true } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createJellyfinClient(config, 500).authenticate("admin", "secret");
    expect(result.AccessToken).toBe("user-token");
    expect(result.User).toMatchObject({ Id: "user-1", Name: "admin" });
  });

  it("uses an explicit token for user-scoped calls", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "X-Emby-Token": "user-token",
        "X-Emby-Device-Id": "churn-web",
      });
      const url = String(input);
      if (url.endsWith("/Users/user-1/Views")) {
        return new Response(
          JSON.stringify({ Items: [{ Id: "view-1", CollectionType: "movies" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toContain("/Users/user-1/Items?");
      expect(url).toContain("ParentId=view-1");
      expect(url).not.toContain("Recursive=true");
      return new Response(JSON.stringify({ Items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createJellyfinClient(config, 500, "user-token").listLibrary("user-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds the user id to item and PlaybackInfo requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "X-Emby-Token": "user-token" });
      const url = String(input);
      if (url.includes("/PlaybackInfo?")) {
        expect(url).toContain("/Items/item-1/PlaybackInfo?userId=user-1");
        return new Response(
          JSON.stringify({
            PlaySessionId: "session-1",
            MediaSources: [{ Id: "source-1", SupportsDirectPlay: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toContain("userId=user-1");
      return new Response(
        JSON.stringify({
          Id: "item-1",
          Name: "Movie",
          Type: "Movie",
          UserData: { PlaybackPositionTicks: 12, Played: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJellyfinClient(config, 500, "user-token");
    const [item, info] = await Promise.all([
      client.getItem("item-1", "user-1"),
      client.getPlaybackInfo("item-1", "user-1"),
    ]);
    expect(item.UserData?.PlaybackPositionTicks).toBe(12);
    expect(info.MediaSources?.[0]?.Id).toBe("source-1");
  });

  it("posts playback reports with the device headers and accepts 204", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "X-Emby-Token": "user-token",
        "X-Emby-Device-Id": "churn-web",
        "content-type": "application/json",
      });
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createJellyfinClient(config, 500, "user-token");
    const body = {
      ItemId: "item-1",
      MediaSourceId: "source-1",
      PlaySessionId: "session-1",
      PositionTicks: 100,
      CanSeek: true,
      IsPaused: false,
      IsMuted: false,
      PlayMethod: "DirectPlay" as const,
    };
    await client.reportPlaybackStart(body);
    await client.reportPlaybackProgress({ ...body, PositionTicks: 200 });
    await client.reportPlaybackStopped({
      ItemId: "item-1",
      MediaSourceId: "source-1",
      PlaySessionId: "session-1",
      PositionTicks: 300,
      Failed: false,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://jellyfin.test:8096/Sessions/Playing",
      "http://jellyfin.test:8096/Sessions/Playing/Progress",
      "http://jellyfin.test:8096/Sessions/Playing/Stopped",
    ]);
    expect(calls[1]?.body).toMatchObject({ PositionTicks: 200 });
    expect(calls[2]?.body).toMatchObject({ Failed: false });
  });
});
