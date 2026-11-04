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
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
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
      apiKey: "qbt_test-key",
    },
    prowlarr: {
      url: "http://prowlarr.test:9696",
      apiKey: "prowlarr-key",
    },
    vpn: {
      statusUrl: "http://vpn-status.test:8098",
      timeoutMs: 500,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function activeTorrent(overrides: Record<string, unknown> = {}) {
  return {
    hash: "abcdef0123456789",
    name: "Example.Show.S01.1080p",
    category: "tv",
    progress: 0.75,
    size: 2_000,
    amount_left: 500,
    dlspeed: 1_500_000,
    eta: 65,
    state: "downloading",
    ...overrides,
  };
}

function installFetch(options: {
  torrents?: () => unknown[];
  qbittorrentError?: boolean;
} = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([{ id: 42, title: "Example Show", tvdbId: 1234 }]);
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([{ id: 7, title: "Example Movie", year: 2022, tmdbId: 9876 }]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        expect(init?.headers).toMatchObject({ authorization: "Bearer qbt_test-key" });
        if (options.qbittorrentError) {
          throw new Error("connection refused");
        }
        return jsonResponse(options.torrents?.() ?? [activeTorrent()]);
      }
      throw new Error(`unexpected URL ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("qBittorrent activity feed caching", () => {
  it("serves concurrent and rapid requests from one snapshot", async () => {
    const calls = installFetch();
    let clock = 0;
    const feed = createActivityFeed(makeConfig(), {
      now: () => clock,
      snapshotTtlMs: 1000,
      metadataTtlMs: 60_000,
    });

    const [first, second] = await Promise.all([feed.get(), feed.get()]);
    expect(first.items).toHaveLength(1);
    expect(second).toBe(first);
    expect(first.services).toEqual([
      { id: "qbittorrent", state: "ok", count: 1 },
    ]);

    clock = 500;
    await feed.get();

    expect(calls.filter((url) => url.endsWith("/api/v2/torrents/info"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/v3/series"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/v3/movie"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("/api/v3/queue"))).toBe(false);
  });

  it("keeps the catalog across snapshots until its TTL expires", async () => {
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

    expect(calls.filter((url) => url.endsWith("/api/v2/torrents/info"))).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith("/api/v3/series"))).toHaveLength(1);

    clock = 70_000;
    await feed.get();
    expect(calls.filter((url) => url.endsWith("/api/v3/series"))).toHaveLength(2);
  });

  it("omits completed and seeding torrents", async () => {
    installFetch({
      torrents: () => [
        activeTorrent({ progress: 1, state: "stalledUP" }),
        activeTorrent({ hash: "active", name: "Example.Show.S01E02.1080p" }),
      ],
    });
    const feed = createActivityFeed(makeConfig(), { now: () => 0 });
    const response = await feed.get();

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({ key: "series:1234", queueCount: 1 });
  });

  it("reports qBittorrent failures without affecting the rest of the response", async () => {
    installFetch({ qbittorrentError: true });
    const feed = createActivityFeed(makeConfig(), { now: () => 0 });
    const response = await feed.get();

    expect(response.items).toEqual([]);
    expect(response.services[0]).toMatchObject({
      id: "qbittorrent",
      state: "unreachable",
      count: 0,
    });
  });

  it("marks qBittorrent unconfigured when no key is available", async () => {
    const calls = installFetch();
    const config = makeConfig();
    config.qbittorrent.apiKey = undefined;
    const feed = createActivityFeed(config, { now: () => 0 });
    const response = await feed.get();

    expect(response.services[0]).toMatchObject({
      id: "qbittorrent",
      state: "unconfigured",
    });
    expect(calls.some((url) => url.endsWith("/api/v2/torrents/info"))).toBe(false);
  });
});
