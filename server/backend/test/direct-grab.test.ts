import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  grabTorrentDirect,
  mediaDownloadTag,
  parseMediaDownloadTag,
} from "../src/direct-grab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(): AppConfig {
  return {
    requestTimeoutMs: 500,
    qbittorrent: {
      url: "http://qbittorrent.test:8080",
      apiKey: "qbt-test-key",
    },
    services: {},
  } as unknown as AppConfig;
}

const release = {
  title: "Dune.2021.1080p.BluRay.x264",
  infoHash: "abc123",
  magnetUrl: "magnet:?xt=urn:btih:abc123&dn=Dune.2021.1080p.BluRay.x264",
};

describe("direct grab media tags", () => {
  it("builds and parses the movie/series media tag", () => {
    expect(mediaDownloadTag("movie", 7)).toBe("churn-movie-7");
    expect(mediaDownloadTag("series", 42)).toBe("churn-series-42");
    expect(parseMediaDownloadTag("churn-direct,churn-movie-7")).toEqual({
      kind: "movie",
      arrId: 7,
    });
    expect(parseMediaDownloadTag("churn-direct")).toBeUndefined();
    expect(parseMediaDownloadTag("churn-movie-0")).toBeUndefined();
  });

  it("tags a new direct download with its media link", async () => {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v2/torrents/info")) {
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/v2/torrents/add")) {
          bodies.push(new URLSearchParams(String(init?.body)));
          return new Response("Ok.", { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const result = await grabTorrentDirect(config(), release, {
      kind: "movie",
      arrId: 7,
      title: "Dune",
      year: 2021,
      libraryPath: "/data/media/movies/Dune (2021)",
    });

    expect(result.alreadyDownloading).toBe(false);
    expect(bodies[0]?.get("tags")).toBe("churn-direct,churn-movie-7");
  });

  it("backfills the media tag on an existing torrent", async () => {
    const tagBodies: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v2/torrents/info")) {
          return new Response(
            JSON.stringify([
              {
                hash: "abc123",
                name: "abc123",
                tags: "churn-direct",
                state: "metaDL",
                has_metadata: false,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v2/torrents/addTags")) {
          tagBodies.push(new URLSearchParams(String(init?.body)));
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const result = await grabTorrentDirect(config(), release, {
      kind: "movie",
      arrId: 7,
      title: "Dune",
      year: 2021,
      libraryPath: "/data/media/movies/Dune (2021)",
    });

    expect(result.alreadyDownloading).toBe(true);
    expect(tagBodies[0]?.get("hashes")).toBe("abc123");
    expect(tagBodies[0]?.get("tags")).toBe("churn-movie-7");
  });
});
