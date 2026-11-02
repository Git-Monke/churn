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
      return new Response(JSON.stringify({ Items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createJellyfinClient(config, 500, "user-token").listLibrary("user-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
