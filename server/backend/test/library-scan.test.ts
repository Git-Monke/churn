import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  createLibraryScanWatcher,
  isDirectDownloadIndexed,
  type ImportEvent,
} from "../src/library-scan.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";

function makeConfig(
  overrides: {
    sonarrKey?: boolean;
    radarrKey?: boolean;
    jellyfinKey?: boolean;
    qbittorrentKey?: boolean;
  } = {},
): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-test",
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    stateDir: "/tmp/churn-test/.churn-state",
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
    services: {
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: overrides.jellyfinKey === false ? undefined : "jellyfin-key",
      },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://sonarr.test:8989",
        apiKey: overrides.sonarrKey === false ? undefined : "sonarr-key",
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://radarr.test:7878",
        apiKey: overrides.radarrKey === false ? undefined : "radarr-key",
      },
    },
    qbittorrent: {
      url: "http://qbittorrent.test:8080",
      apiKey: overrides.qbittorrentKey === false ? undefined : "qbt-key",
    },
    prowlarr: {
      url: "http://prowlarr.test:9696",
      apiKey: "prowlarr-key",
    },
    introdb: { url: "https://api.introdb.test", timeoutMs: 500 },
    vpn: {
      statusUrl: "http://vpn-status.test:8098",
      timeoutMs: 500,
    },
  };
}

function importEvent(overrides: Partial<ImportEvent> = {}): ImportEvent {
  return {
    service: "sonarr",
    id: 132,
    date: new Date().toISOString(),
    seriesId: 2,
    title: "Parks and Recreation",
    ...overrides,
  };
}

function watcherFor(
  imports: ImportEvent[],
  overrides: {
    refresh?: () => Promise<void>;
    resolve?: (pending: ImportEvent[]) => Promise<ImportEvent[]>;
    getTorrents?: () => Promise<QbittorrentTorrent[]>;
    resolveDirect?: (torrent: QbittorrentTorrent) => Promise<boolean>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    resolveTimeoutMs?: number;
    directRefreshMs?: number;
    directRetryWindowMs?: number;
    config?: AppConfig;
  } = {},
) {
  const refresh = vi.fn(overrides.refresh ?? (async () => undefined));
  const resolve = vi.fn(overrides.resolve ?? (async () => []));
  const resolveDirect = vi.fn(overrides.resolveDirect ?? (async () => false));
  const watcher = createLibraryScanWatcher(overrides.config ?? makeConfig(), {
    getImports: async () => imports,
    getTorrents: overrides.getTorrents ?? (async () => []),
    refresh,
    resolve,
    resolveDirect,
    now: overrides.now,
    sleep: overrides.sleep,
    resolveTimeoutMs: overrides.resolveTimeoutMs,
    directRefreshMs: overrides.directRefreshMs,
    directRetryWindowMs: overrides.directRetryWindowMs,
  });
  return { watcher, refresh, resolve, resolveDirect };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("library scan watcher", () => {
  it("scans once per import, however often the same history row is returned", async () => {
    const imports = [importEvent()];
    const { watcher, refresh } = watcherFor(imports);

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("scans when a new history row appears after the first poll", async () => {
    let imports: ImportEvent[] = [importEvent({ id: 1, seriesId: 2 })];
    const refresh = vi.fn(async () => undefined);
    const watcher = createLibraryScanWatcher(makeConfig(), {
      getImports: async () => imports,
      getTorrents: async () => [],
      refresh,
      resolve: async () => [],
    });

    await watcher.pollOnce();
    imports = [
      importEvent({ id: 1, seriesId: 2 }),
      importEvent({ id: 2, seriesId: 3 }),
    ];
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces a season pack's import rows into one scan", async () => {
    const imports = [
      importEvent({ id: 1, seriesId: 2 }),
      importEvent({ id: 2, seriesId: 2 }),
      importEvent({ id: 3, seriesId: 2 }),
      importEvent({ service: "radarr", id: 9, seriesId: undefined, movieId: 4 }),
    ];
    let clock = 0;
    let resolveCalls = 0;
    const { watcher, refresh } = watcherFor(imports, {
      resolve: async (pending) => {
        resolveCalls += 1;
        return pending;
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      resolveTimeoutMs: 2_000,
    });

    await watcher.pollOnce();
    // One scan, then one retry because the imports never resolved.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(resolveCalls).toBeGreaterThan(1);
  });

  it("does not rescan when Jellyfin resolves the import on the first check", async () => {
    const resolve = vi.fn(async () => []);
    const { watcher, refresh } = watcherFor([importEvent()], { resolve });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rescans once when the item is still missing, then gives up", async () => {
    let clock = 0;
    const resolve = vi.fn(async () => [importEvent()]);
    const { watcher, refresh } = watcherFor([importEvent()], {
      resolve,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      resolveTimeoutMs: 4_000,
    });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(clock).toBeGreaterThanOrEqual(8_000);
    expect(resolve.mock.calls.length).toBeGreaterThan(2);
  });

  it("keeps scanning when the resolution check itself fails", async () => {
    const { watcher, refresh } = watcherFor([importEvent()], {
      resolve: async () => {
        throw new Error("jellyfin is down");
      },
    });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing when Jellyfin or both arrs are unconfigured", async () => {
    const getImports = vi.fn(async () => [importEvent()]);

    for (const config of [
      makeConfig({ jellyfinKey: false }),
      makeConfig({ sonarrKey: false, radarrKey: false, qbittorrentKey: false }),
    ]) {
      const watcher = createLibraryScanWatcher(config, {
        getImports,
        getTorrents: async () => [],
        refresh: async () => undefined,
        resolve: async () => [],
      });
      await watcher.pollOnce();
      watcher.start();
      watcher.stop();
    }

    expect(getImports).not.toHaveBeenCalled();
  });

  it("requests a scan for a finished churn-direct torrent", async () => {
    const nowMs = 1_000_000_000_000;
    const torrent = {
      hash: "direct-hash",
      name: "Parks.and.Recreation.S01.1080p",
      progress: 1,
      completion_on: nowMs / 1_000 - 5,
      tags: "churn-direct",
    };
    const { watcher, refresh } = watcherFor([], {
      now: () => nowMs,
      getTorrents: async () => [torrent],
    });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The refresh throttle keeps the same torrent from scanning every poll.
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retries a direct download until Jellyfin exposes it", async () => {
    let clock = 1_000_000_000_000;
    let visible = false;
    const torrent = {
      hash: "direct-hash",
      name: "Parks.and.Recreation.S02.1080p",
      progress: 1,
      completion_on: clock / 1_000 - 5,
      tags: "churn-direct",
    };
    const { watcher, refresh, resolveDirect } = watcherFor([], {
      now: () => clock,
      getTorrents: async () => [torrent],
      resolveDirect: async () => visible,
      directRefreshMs: 15_000,
    });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    // Not due yet: verify, but do not scan again.
    clock += 14_000;
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    clock += 1_000;
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(2);

    visible = true;
    clock += 15_000;
    await watcher.pollOnce();
    expect(resolveDirect).toHaveBeenLastCalledWith(torrent);
    expect(refresh).toHaveBeenCalledTimes(2);

    // Resolved downloads are forgotten, so later polls do not keep checking.
    const calls = resolveDirect.mock.calls.length;
    clock += 15_000;
    await watcher.pollOnce();
    expect(resolveDirect).toHaveBeenCalledTimes(calls);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a direct download after the retry window", async () => {
    let clock = 1_000_000_000_000;
    const torrent = {
      hash: "direct-hash",
      name: "Parks.and.Recreation.S02.1080p",
      progress: 1,
      completion_on: clock / 1_000 - 5,
      tags: "churn-direct",
    };
    const { watcher, refresh } = watcherFor([], {
      now: () => clock,
      getTorrents: async () => [torrent],
      resolveDirect: async () => false,
      directRefreshMs: 15_000,
      directRetryWindowMs: 50_000,
    });

    for (let elapsed = 0; elapsed <= 40_000; elapsed += 10_000) {
      await watcher.pollOnce();
      clock += 10_000;
    }

    // Refreshes at 0, 30 and 40 seconds. At 50 seconds the window closes.
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("ignores incomplete, non-direct, and old direct torrents", async () => {
    const nowMs = 1_000_000_000_000;
    const { watcher, refresh } = watcherFor([], {
      now: () => nowMs,
      getTorrents: async () => [
        {
          hash: "still-downloading",
          progress: 0.5,
          completion_on: 0,
          tags: "churn-direct",
        },
        {
          hash: "arr-managed",
          progress: 1,
          completion_on: nowMs / 1_000 - 5,
          tags: "sonarr",
        },
        {
          hash: "old-direct",
          progress: 1,
          completion_on: nowMs / 1_000 - 3_600,
          tags: "churn-direct",
        },
      ],
    });

    await watcher.pollOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recognises a Jellyfin series with episodes for the torrent season", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("IncludeItemTypes=Series")) {
          return jsonResponse({
            Items: [
              {
                Id: "series-1",
                Name: "Parks and Recreation",
                Type: "Series",
                Path: "/data/media/tv/Parks and Recreation",
              },
            ],
          });
        }
        if (url.includes("IncludeItemTypes=Movie")) {
          return jsonResponse({ Items: [] });
        }
        if (url.includes("/Shows/series-1/Episodes")) {
          return jsonResponse({
            Items: [
              { Id: "episode-1", ParentIndexNumber: 2, IndexNumber: 1 },
              { Id: "episode-2", ParentIndexNumber: 2, IndexNumber: 2 },
            ],
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const config = makeConfig();
    await expect(
      isDirectDownloadIndexed(config, {
        name: "Parks.and.Recreation.S02.1080p",
        content_path: "/data/media/tv/Parks and Recreation/Season 2",
        progress: 1,
        tags: "churn-direct",
      }),
    ).resolves.toBe(true);
  });

  it("does not count a series until the torrent's season has episodes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("IncludeItemTypes=Series")) {
          return jsonResponse({
            Items: [
              {
                Id: "series-1",
                Name: "Parks and Recreation",
                Type: "Series",
                Path: "/data/media/tv/Parks and Recreation",
              },
            ],
          });
        }
        if (url.includes("IncludeItemTypes=Movie")) {
          return jsonResponse({ Items: [] });
        }
        if (url.includes("/Shows/series-1/Episodes")) {
          return jsonResponse({
            Items: [{ Id: "episode-1", ParentIndexNumber: 1, IndexNumber: 1 }],
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    await expect(
      isDirectDownloadIndexed(makeConfig(), {
        name: "Parks.and.Recreation.S02.1080p",
        content_path: "/data/media/tv/Parks and Recreation/Season 2",
        progress: 1,
        tags: "churn-direct",
      }),
    ).resolves.toBe(false);
  });

  it("recognises a Jellyfin movie whose file is inside the download path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("IncludeItemTypes=Series")) {
          return jsonResponse({ Items: [] });
        }
        if (url.includes("IncludeItemTypes=Movie")) {
          return jsonResponse({
            Items: [
              {
                Id: "movie-1",
                Name: "Example Movie",
                Type: "Movie",
                Path: "/data/media/movies/Example Movie (2022)/Example.Movie.2022.mkv",
              },
            ],
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    await expect(
      isDirectDownloadIndexed(makeConfig(), {
        name: "Example.Movie.2022.1080p",
        content_path: "/data/media/movies/Example Movie (2022)",
        progress: 1,
        tags: "churn-direct",
      }),
    ).resolves.toBe(true);
  });

  it("stops polling after stop()", async () => {
    vi.useFakeTimers();
    const getImports = vi.fn(async () => [] as ImportEvent[]);
    const watcher = createLibraryScanWatcher(makeConfig(), {
      intervalMs: 1_000,
      getImports,
      getTorrents: async () => [],
      refresh: async () => undefined,
      resolve: async () => [],
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getImports).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getImports).toHaveBeenCalledTimes(2);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getImports).toHaveBeenCalledTimes(2);
  });
});
