import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createLibraryScanWatcher, type ImportEvent } from "../src/library-scan.js";

function makeConfig(
  overrides: { sonarrKey?: boolean; radarrKey?: boolean; jellyfinKey?: boolean } = {},
): AppConfig {
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
      apiKey: "qbt-key",
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
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    resolveTimeoutMs?: number;
    config?: AppConfig;
  } = {},
) {
  const refresh = vi.fn(overrides.refresh ?? (async () => undefined));
  const resolve = vi.fn(overrides.resolve ?? (async () => []));
  const watcher = createLibraryScanWatcher(overrides.config ?? makeConfig(), {
    getImports: async () => imports,
    refresh,
    resolve,
    now: overrides.now,
    sleep: overrides.sleep,
    resolveTimeoutMs: overrides.resolveTimeoutMs,
  });
  return { watcher, refresh, resolve };
}

afterEach(() => {
  vi.useRealTimers();
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
      makeConfig({ sonarrKey: false, radarrKey: false }),
    ]) {
      const watcher = createLibraryScanWatcher(config, {
        getImports,
        refresh: async () => undefined,
        resolve: async () => [],
      });
      await watcher.pollOnce();
      watcher.start();
      watcher.stop();
    }

    expect(getImports).not.toHaveBeenCalled();
  });

  it("stops polling after stop()", async () => {
    vi.useFakeTimers();
    const getImports = vi.fn(async () => [] as ImportEvent[]);
    const watcher = createLibraryScanWatcher(makeConfig(), {
      intervalMs: 1_000,
      getImports,
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
