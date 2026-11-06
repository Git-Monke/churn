import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createMediaCache } from "../src/media-cache.js";
import { createReleaseSearchService } from "../src/release-search.js";

/**
 * Every indexer finishes before the snapshot hits the disk. A poller that sees
 * `state: "ready"` must be able to read that snapshot, so hold the write open
 * and check the state in between.
 */
const gate = vi.hoisted(() => {
  const state: { open: boolean; release?: () => void; waiting: Promise<void> } = {
    open: true,
    waiting: Promise.resolve(),
  };
  return state;
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      if (!gate.open) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return actual.writeFile(...args);
    },
  };
});

let root: string;

function config(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: root,
    frontendDist: path.join(root, "frontend"),
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 60_000,
    stateDir: path.join(root, ".churn-state"),
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
    services: {
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://jellyfin.test:8096" },
      sonarr: { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989", apiKey: "sonarr-key" },
      radarr: { id: "radarr", name: "Radarr", url: "http://radarr.test:7878", apiKey: "radarr-key" },
    },
    qbittorrent: { url: "http://qbittorrent.test:8080" },
    prowlarr: { url: "http://prowlarr.test:9696", apiKey: "prowlarr-key" },
    introdb: { url: "https://api.introdb.test", timeoutMs: 500 },
    vpn: { statusUrl: "http://vpn-status.test:8098", timeoutMs: 500 },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/indexer")) {
        return json([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v3/indexer")) {
        return json([{ id: 11, name: "EZTV (Prowlarr)" }]);
      }
      if (url.includes("/api/v3/parse")) {
        return json({
          parsedEpisodeInfo: {
            seriesTitleInfo: { titleWithoutYear: "Example Show" },
            seasonNumber: 1,
            episodeNumbers: [],
            fullSeason: true,
            quality: { quality: { resolution: 1080 } },
          },
        });
      }
      if (url.includes("/api/v1/search")) {
        return json([
          {
            guid: "persist-me",
            title: "Example.Show.S01.1080p",
            size: 2_000_000_000,
            seeders: 40,
            leechers: 2,
            indexerId: 1,
            indexer: "EZTV",
            protocol: "torrent",
            infoHash: "hash-persist-me",
            downloadUrl: "https://prowlarr.test/1/download?link=persist-me",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "churn-release-persist-"));
});

afterEach(async () => {
  gate.open = true;
  gate.release?.();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("release snapshot persistence", () => {
  it("reports ready only once the snapshot is written", async () => {
    installFetch();
    const media = createMediaCache({ cacheDir: path.join(root, "media") });
    await media.putSeries({
      version: 1,
      kind: "series",
      id: 42,
      title: "Example Show",
      year: 2024,
      seasons: [1],
      cachedAt: "2026-01-01T00:00:00Z",
    });
    const cacheDir = path.join(root, "prowlarr");
    const service = createReleaseSearchService(config(), media, { cacheDir });
    const snapshot = path.join(cacheDir, "series-42", "s1.json");

    gate.open = false;
    const first = await service.getSeriesSeason(42, 1);
    expect(first.state).toBe("searching");
    expect(existsSync(snapshot)).toBe(false);

    // Wait until every indexer has finished and its releases are mapped: from
    // here on only the snapshot write is left, and it is stuck on the gate.
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 200) {
        throw new Error("indexer search did not finish");
      }
      const view = await service.getSeriesSeason(42, 1);
      if (view.releaseCount === 1) {
        expect(view.state).toBe("searching");
        expect(existsSync(snapshot)).toBe(false);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // A settled search whose snapshot is still being written is not ready.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const view = await service.getSeriesSeason(42, 1);
      expect(view.releaseCount).toBe(1);
      expect(view.state).toBe("searching");
      expect(existsSync(snapshot)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    gate.open = true;
    gate.release?.();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const view = await service.getSeriesSeason(42, 1);
      if (view.state === "ready") {
        expect(existsSync(snapshot)).toBe(true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("search never became ready");
  });
});
