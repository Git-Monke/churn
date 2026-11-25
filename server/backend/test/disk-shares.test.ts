import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthUser, ProfileRecord } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import {
  createDiskShareService,
  diskShareLimit,
  DISK_SHARES_FILENAME,
  type DiskShareSettings,
} from "../src/disk-shares.js";
import {
  hasOwnerTag,
  mediaOwnerTag,
  ownerTagMatches,
} from "../src/direct-grab.js";
import { ApiError } from "../src/errors.js";
import { createMediaAttributionStore } from "../src/media-attribution.js";

const GIGABYTE = 1024 ** 3;
const TERABYTE = 1024 ** 4;

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeConfig(stateDir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"))): AppConfig {
  return {
    requestTimeoutMs: 500,
    stateDir,
    services: {
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
      apiKey: "qbt-key",
    },
  } as unknown as AppConfig;
}

function profile(id: string, jellyfinUserId: string): ProfileRecord {
  return {
    id,
    name: id,
    jellyfinUserId,
    initialPin: null,
    createdAt: 0,
  };
}

function actor(jellyfinUserId: string, isAdmin = false): AuthUser {
  return { id: jellyfinUserId, name: jellyfinUserId, isAdmin };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function settings(enabled: boolean, overrides: Record<string, number> = {}): DiskShareSettings {
  return { enabled, overrides };
}

describe("diskShareLimit", () => {
  it("returns no limit when the feature is off", () => {
    expect(diskShareLimit(settings(false), "user-a", TERABYTE, 4)).toBeUndefined();
  });

  it("prefers an override over the equal share", () => {
    expect(
      diskShareLimit(settings(true, { "user-a": 50 * GIGABYTE }), "user-a", TERABYTE, 4),
    ).toBe(50 * GIGABYTE);
  });

  it("floors the equal share across profiles", () => {
    expect(diskShareLimit(settings(true), "user-a", 10, 3)).toBe(3);
    expect(diskShareLimit(settings(true), "user-a", TERABYTE, 4)).toBe(TERABYTE / 4);
  });

  it("returns no limit without capacity or profiles", () => {
    expect(diskShareLimit(settings(true), "user-a", undefined, 4)).toBeUndefined();
    expect(diskShareLimit(settings(true), "user-a", 0, 4)).toBeUndefined();
    expect(diskShareLimit(settings(true), "user-a", TERABYTE, 0)).toBeUndefined();
  });
});

describe("disk share persistence", () => {
  it("persists the switch and per-person overrides", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    const profiles = [profile("p-alex", "user-a")];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));

    const first = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => profiles,
      onWarning: () => {},
    });
    await first.setEnabled(true);
    await first.setUserLimit("user-a", 50 * GIGABYTE);

    const second = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => profiles,
      onWarning: () => {},
    });
    const admin = await second.adminSummary();
    expect(admin.enabled).toBe(true);
    expect(admin.users[0]).toMatchObject({
      jellyfinUserId: "user-a",
      customLimit: true,
      limitBytes: 50 * GIGABYTE,
    });

    await second.removeOverride("user-a");
    const third = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => profiles,
      onWarning: () => {},
    });
    const afterRemoval = await third.adminSummary();
    expect(afterRemoval.users[0]?.customLimit).toBe(false);
  });

  it("falls back to disabled with a warning on a corrupt file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    writeFileSync(path.join(dir, DISK_SHARES_FILENAME), "{not json");
    const warnings: string[] = [];
    const service = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => [profile("p-alex", "user-a")],
      onWarning: (message) => warnings.push(message),
    });

    const admin = await service.adminSummary();
    expect(admin.enabled).toBe(false);
    expect(warnings.some((message) => message.includes("corrupt"))).toBe(true);
  });
});

describe("owner tags", () => {
  it("builds a stable 16-hex tag and matches owners", () => {
    const tag = mediaOwnerTag("user-alex");
    expect(tag).toBe(mediaOwnerTag("user-alex"));
    expect(tag).toMatch(/^churn-user-[0-9a-f]{16}$/);
    expect(ownerTagMatches(`churn-direct,${tag}`, "user-alex")).toBe(true);
    expect(ownerTagMatches(`churn-direct,${tag}`, "user-other")).toBe(false);
    expect(hasOwnerTag(`churn-direct,${tag}`)).toBe(true);
    expect(hasOwnerTag("churn-direct,churn-movie-7")).toBe(false);
  });
});

function usageFetch(movieSize: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v3/diskspace")) {
        return jsonResponse([
          { path: "/data", totalSpace: TERABYTE, freeSpace: TERABYTE },
        ]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ id: 1, path: "/data/media", accessible: true }]);
      }
      if (url.endsWith(":8989/api/v3/series")) {
        return jsonResponse([]);
      }
      if (url.endsWith(":7878/api/v3/movie")) {
        return jsonResponse([
          { id: 7, tmdbId: 438631, statistics: { sizeOnDisk: movieSize } },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([]);
      }
      throw new Error(`unexpected URL ${url}`);
    }),
  );
}

describe("disk share service", () => {
  it("asks the arr to scan a finished download the library does not know yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    const commands: unknown[] = [];
    const torrents = [
      {
        hash: "hash-1",
        name: "Dune",
        progress: 1,
        size: 8 * GIGABYTE,
        tags: "churn-direct,churn-movie-7,churn-user-x",
        state: "stalledUP",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v3/diskspace")) {
          return jsonResponse([
            { path: "/data", totalSpace: TERABYTE, freeSpace: TERABYTE },
          ]);
        }
        if (url.endsWith("/api/v3/rootfolder")) {
          return jsonResponse([{ id: 1, path: "/data/media", accessible: true }]);
        }
        if (url.endsWith(":8989/api/v3/series")) {
          return jsonResponse([]);
        }
        if (url.endsWith(":7878/api/v3/movie")) {
          return jsonResponse([
            { id: 7, tmdbId: 438631, hasFile: false, statistics: { sizeOnDisk: 0 } },
          ]);
        }
        if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
          return jsonResponse(torrents);
        }
        if (url.endsWith(":7878/api/v3/command") && init?.method === "POST") {
          commands.push(JSON.parse(String(init.body)));
          return jsonResponse({ id: 1, status: "started" }, 201);
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const service = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => [profile("p-alex", "user-a")],
      onWarning: () => {},
    });
    await service.setEnabled(true);

    await service.summary(actor("user-a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.summary(actor("user-a"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands).toEqual([{ name: "RescanMovie", movieId: 7 }]);
  });

  it("rejects a grab that would exceed the person's share", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    const profiles = [1, 2, 3, 4].map((index) =>
      profile(`p-${index}`, index === 1 ? "user-alex" : `user-${index}`),
    );
    const attribution = createMediaAttributionStore({ stateDir: dir });
    await attribution.record(
      { kind: "movie", tmdbId: 438631 },
      { id: "user-alex", name: "Alex" },
    );
    usageFetch(40 * GIGABYTE);

    const warnings: string[] = [];
    const service = createDiskShareService({
      config: makeConfig(dir),
      attribution,
      profiles: () => profiles,
      onWarning: (message) => warnings.push(message),
    });
    await service.setEnabled(true);
    await service.setUserLimit("user-alex", 50 * GIGABYTE);

    const alex = actor("user-alex");
    await expect(service.reserve(alex, 11 * GIGABYTE)).rejects.toMatchObject({
      statusCode: 409,
      code: "disk_share_exceeded",
    } satisfies Partial<ApiError>);

    await expect(service.reserve(alex, 10 * GIGABYTE)).resolves.toBeUndefined();
    service.release("user-alex", 10 * GIGABYTE);
    await expect(service.reserve(alex, 10 * GIGABYTE)).resolves.toBeUndefined();
    service.release("user-alex", 10 * GIGABYTE);
    expect(warnings).toEqual([]);
  });

  it("never reserves for admins or while disabled", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const service = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => [profile("p-alex", "user-a")],
      onWarning: () => {},
    });

    await expect(
      service.reserve(actor("admin-id", true), 10 * GIGABYTE),
    ).resolves.toBeUndefined();
    await expect(
      service.reserve(actor("user-a"), 10 * GIGABYTE),
    ).resolves.toBeUndefined();
    const summary = await service.summary(actor("user-a"));
    expect(summary.enabled).toBe(false);
    expect(summary.limitBytes).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails open and reports unavailable when qBittorrent is down", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "churn-disk-shares-"));
    const warnings: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/v3/diskspace")) {
          return jsonResponse([
            { path: "/data", totalSpace: TERABYTE, freeSpace: TERABYTE },
          ]);
        }
        if (url.endsWith("/api/v3/rootfolder")) {
          return jsonResponse([{ id: 1, path: "/data/media", accessible: true }]);
        }
        if (url.endsWith(":8989/api/v3/series")) {
          return jsonResponse([]);
        }
        if (url.endsWith(":7878/api/v3/movie")) {
          return jsonResponse([]);
        }
        if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
          return new Response("down", { status: 500 });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const service = createDiskShareService({
      config: makeConfig(dir),
      attribution: createMediaAttributionStore({ stateDir: dir }),
      profiles: () => [profile("p-alex", "user-a")],
      onWarning: (message) => warnings.push(message),
    });
    await service.setEnabled(true);

    await expect(
      service.reserve(actor("user-a"), 10 * GIGABYTE),
    ).resolves.toBeUndefined();
    const summary = await service.summary(actor("user-a"));
    expect(summary.state).toBe("unavailable");
    expect(summary.detail).toBe("Could not read qBittorrent downloads");
    expect(warnings).toHaveLength(1);
  });
});
