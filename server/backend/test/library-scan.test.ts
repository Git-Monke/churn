import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  createLibraryScanWatcher,
  isTorrentDownloadComplete,
} from "../src/library-scan.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";

function makeConfig(overrides: { qbittorrentKey?: boolean; jellyfinKey?: boolean } = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-test",
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
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
      apiKey: overrides.qbittorrentKey === false ? undefined : "qbt-key",
    },
    vpn: {
      statusUrl: "http://vpn-status.test:8098",
      timeoutMs: 500,
    },
  };
}

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "abcdef0123456789",
    size: 2_000,
    amount_left: 0,
    progress: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isTorrentDownloadComplete", () => {
  it("uses progress when available and falls back to remaining bytes", () => {
    expect(isTorrentDownloadComplete({ progress: 0.99 })).toBe(false);
    expect(isTorrentDownloadComplete({ progress: 1 })).toBe(true);
    expect(
      isTorrentDownloadComplete({ amount_left: 0, size: 100, progress: undefined }),
    ).toBe(true);
    expect(
      isTorrentDownloadComplete({ amount_left: 0, size: 0, progress: undefined }),
    ).toBe(false);
  });
});

describe("library scan watcher", () => {
  it("scans a completed torrent first seen recently, then does not repeat", async () => {
    const now = Date.now();
    const torrents = [{ ...torrentNow(now) }];
    const refresh = vi.fn(async () => undefined);
    const watcher = createLibraryScanWatcher(
      { ...makeConfig(), qbittorrent: { url: "http://qbittorrent.test:8080", apiKey: "key" } },
      {
        now: () => now,
        getTorrents: async () => torrents,
        refresh,
      },
    );

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a completed torrent first seen outside the recent window", async () => {
    const now = Date.now();
    const refresh = vi.fn(async () => undefined);
    const watcher = createLibraryScanWatcher(configWithKeys(), {
      now: () => now,
      getTorrents: async () => [torrent({ completion_on: Math.floor(now / 1_000) - 11 * 60 })],
      refresh,
    });

    await watcher.pollOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("scans on an incomplete-to-complete transition", async () => {
    let now = Date.now();
    let torrents = [torrent({ progress: 0.4, amount_left: 600, completion_on: 0 })];
    const refresh = vi.fn(async () => undefined);
    const watcher = createLibraryScanWatcher(configWithKeys(), {
      now: () => now,
      getTorrents: async () => torrents,
      refresh,
    });

    await watcher.pollOnce();
    expect(refresh).not.toHaveBeenCalled();

    now += 1_000;
    torrents = [torrentNow(now)];
    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple completions in one poll into one refresh", async () => {
    const now = Date.now();
    const refresh = vi.fn(async () => undefined);
    const watcher = createLibraryScanWatcher(configWithKeys(), {
      now: () => now,
      getTorrents: async () => [
        torrent({ hash: "aaa", completion_on: Math.floor(now / 1_000) - 1 }),
        torrent({ hash: "bbb", completion_on: Math.floor(now / 1_000) - 1 }),
      ],
      refresh,
    });

    await watcher.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing when qBittorrent or Jellyfin is unconfigured", async () => {
    const getTorrents = vi.fn(async () => [torrent()]);
    const refresh = vi.fn(async () => undefined);

    for (const config of [
      makeConfig({ qbittorrentKey: false }),
      makeConfig({ jellyfinKey: false }),
    ]) {
      const watcher = createLibraryScanWatcher(config, {
        getTorrents,
        refresh,
      });
      await watcher.pollOnce();
      watcher.start();
      watcher.stop();
    }

    expect(getTorrents).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops polling after stop()", async () => {
    vi.useFakeTimers();
    const getTorrents = vi.fn(async () => []);
    const watcher = createLibraryScanWatcher(configWithKeys(), {
      intervalMs: 1_000,
      getTorrents,
      refresh: async () => undefined,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getTorrents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getTorrents).toHaveBeenCalledTimes(2);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getTorrents).toHaveBeenCalledTimes(2);
  });
});

function configWithKeys(): AppConfig {
  return makeConfig();
}

function torrentNow(now: number): QbittorrentTorrent {
  return torrent({ completion_on: Math.floor(now / 1_000) - 2 });
}
