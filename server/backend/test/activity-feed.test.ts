import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityFeed } from "../src/activity-feed.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-test",
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    services: {
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
      },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://sonarr.test:8989",
        apiKey: "sonarr-key",
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://radarr.test:7878",
        apiKey: "radarr-key",
      },
    },
    qbittorrent: {
      url: "http://qbittorrent.test:8080",
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 101,
              title: "Example.Show.S01.1080p",
              status: "downloading",
              trackedDownloadState: "downloading",
              size: 1000,
              sizeleft: 250,
              seriesId: 42,
              seasonNumber: 1,
            },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 201,
              title: "Example.Movie.2022.1080p",
              status: "queued",
              trackedDownloadState: "downloading",
              size: 0,
              sizeleft: 0,
              movieId: 7,
            },
          ],
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ id: 7, title: "Example Movie", tmdbId: 9876 });
      }
      throw new Error(`unexpected URL ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activity feed caching", () => {
  it("serves concurrent and rapid requests from one upstream snapshot", async () => {
    const calls = installFetch();
    let clock = 0;
    const feed = createActivityFeed(makeConfig(), {
      now: () => clock,
      snapshotTtlMs: 1000,
      metadataTtlMs: 60_000,
    });

    const [first, second] = await Promise.all([feed.get(), feed.get()]);
    expect(first.items).toHaveLength(2);
    expect(second).toBe(first);

    clock = 500;
    await feed.get();

    expect(calls.filter((url) => url.includes("/api/v3/queue"))).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith("/api/v3/series/42"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/v3/movie/7"))).toHaveLength(1);
  });

  it("keeps cached metadata across snapshots until its TTL expires", async () => {
    const calls = installFetch();
    let clock = 0;
    const feed = createActivityFeed(makeConfig(), {
      now: () => clock,
      snapshotTtlMs: 1000,
      metadataTtlMs: 60_000,
    });

    await feed.get();
    clock = 1500;
    await feed.get();

    expect(calls.filter((url) => url.includes("/api/v3/queue"))).toHaveLength(4);
    expect(calls.filter((url) => url.endsWith("/api/v3/series/42"))).toHaveLength(1);

    clock = 70_000;
    await feed.get();
    expect(calls.filter((url) => url.endsWith("/api/v3/series/42"))).toHaveLength(2);
  });

  it("retries metadata that failed instead of caching the failure", async () => {
    const calls: string[] = [];
    let seriesCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/v3/queue")) {
          return jsonResponse({
            records: [
              {
                id: 101,
                title: "Example.Show.S01.1080p",
                status: "downloading",
                trackedDownloadState: "downloading",
                seriesId: 42,
              },
            ],
          });
        }
        if (url.endsWith("/api/v3/series/42")) {
          seriesCalls += 1;
          if (seriesCalls === 1) {
            return new Response("upstream exploded", { status: 500 });
          }
          return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    let clock = 0;
    const feed = createActivityFeed(makeConfig(), {
      now: () => clock,
      snapshotTtlMs: 1000,
      metadataTtlMs: 60_000,
    });

    const failed = await feed.get();
    expect(failed.items[0]?.title).toBe("Example.Show.S01.1080p");

    clock = 1500;
    const recovered = await feed.get();
    expect(recovered.items[0]?.title).toBe("Example Show");
    expect(seriesCalls).toBe(2);
  });
});

describe("qBittorrent progress overlay", () => {
  function overlayConfig(): AppConfig {
    return {
      ...makeConfig(),
      qbittorrent: { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
    };
  }

  function installOverlayFetch(options: { qbittorrent: () => Response }): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
          return jsonResponse({
            records: [
              {
                id: 101,
                downloadId: "ABCDEF0123456789",
                title: "Example.Show.S01.1080p",
                status: "downloading",
                trackedDownloadStatus: "ok",
                trackedDownloadState: "downloading",
                protocol: "torrent",
                downloadClient: "qBittorrent",
                size: 1000,
                sizeleft: 600,
                seriesId: 42,
                seasonNumber: 1,
              },
            ],
          });
        }
        if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
          return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
        }
        if (url.includes("radarr.test") && url.includes("/api/v3/queue")) {
          return jsonResponse({ records: [] });
        }
        if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
          expect(init?.headers).toMatchObject({ authorization: "Bearer qbt_test-key" });
          return options.qbittorrent();
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    return calls;
  }

  it("overlays live qBittorrent progress and speed once per snapshot", async () => {
    installOverlayFetch({
      qbittorrent: () =>
        jsonResponse([
          {
            hash: "abcdef0123456789",
            size: 2000,
            amount_left: 500,
            progress: 0.75,
            dlspeed: 1_500_000,
            eta: 65,
          },
        ]),
    });
    let clock = 0;
    const feed = createActivityFeed(overlayConfig(), {
      now: () => clock,
      snapshotTtlMs: 1000,
      metadataTtlMs: 60_000,
    });

    const [first, second] = await Promise.all([feed.get(), feed.get()]);
    expect(second).toBe(first);
    expect(first.items[0]).toMatchObject({
      title: "Example Show",
      progress: 75,
      sizeBytes: 2000,
      sizeLeftBytes: 500,
      timeLeft: "00:01:05",
      downloadSpeedBytes: 1_500_000,
    });
  });

  it("falls back to arr values when qBittorrent is unavailable", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
          return jsonResponse({
            records: [
              {
                id: 101,
                downloadId: "ABCDEF0123456789",
                title: "Example.Show.S01.1080p",
                status: "downloading",
                trackedDownloadState: "downloading",
                protocol: "torrent",
                size: 1000,
                sizeleft: 600,
                seriesId: 42,
              },
            ],
          });
        }
        if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
          return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
        }
        if (url.includes("radarr.test") && url.includes("/api/v3/queue")) {
          return jsonResponse({ records: [] });
        }
        if (url.includes("qbittorrent.test")) {
          throw new Error("connection refused");
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const config = overlayConfig();
    const feed = createActivityFeed(config);

    const response = await feed.get();
    expect(response.items[0]).toMatchObject({
      title: "Example Show",
      progress: 40,
      sizeBytes: 1000,
      sizeLeftBytes: 600,
    });
    expect(response.items[0]?.downloadSpeedBytes).toBeUndefined();
    expect(calls.filter((url) => url.includes("qbittorrent.test"))).toHaveLength(1);
  });
});
