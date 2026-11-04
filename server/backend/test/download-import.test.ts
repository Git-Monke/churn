import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { recoverCompletedShowDownloads } from "../src/download-import.js";
import type { ShowEpisode } from "../src/types.js";
import type { QbittorrentTorrent } from "../src/upstream/qbittorrent.js";

function config(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-download-import-test",
    frontendDist: "/tmp/churn-download-import-test/frontend",
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 60_000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
    services: {
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://jellyfin.test:8096" },
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
    qbittorrent: { url: "http://qbittorrent.test:8080" },
    prowlarr: { url: "http://prowlarr.test:9696" },
    vpn: { statusUrl: "http://vpn-status.test:8098", timeoutMs: 500 },
  };
}

function episode(): ShowEpisode {
  return {
    key: "s01e01",
    seasonNumber: 1,
    episodeNumber: 1,
    title: "Episode 1",
    availability: "missing",
  };
}

function torrent(overrides: Partial<QbittorrentTorrent> = {}): QbittorrentTorrent {
  return {
    hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
    name: "Example.Show.S01.1080p",
    progress: 1,
    state: "uploading",
    content_path: "/data/media/tv/Example Show/Season 1",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completed download recovery", () => {
  it("does not ask Sonarr to import a churn-direct torrent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const recovering = await recoverCompletedShowDownloads(
      config(),
      42,
      "Example Show",
      [episode()],
      [torrent({ tags: "churn-direct" })],
    );

    expect(recovering.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still asks Sonarr to scan older untracked downloads", async () => {
    let command: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/api/v3/command") && init?.method === "POST") {
        command = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const recovering = await recoverCompletedShowDownloads(
      config(),
      42,
      "Example Show",
      [episode()],
      [torrent()],
    );

    expect([...recovering]).toEqual(["s01e01"]);
    expect(command).toMatchObject({
      name: "DownloadedEpisodesScan",
      path: "/data/media/tv/Example Show/Season 1",
      importMode: "auto",
    });
  });
});

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init),
    ),
  );
}
