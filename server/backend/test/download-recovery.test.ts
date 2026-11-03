import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  grabWithDuplicateRecovery,
  looksLikeQbittorrentFailure,
  matchingTorrentHash,
} from "../src/download-recovery.js";
import { UpstreamError } from "../src/errors.js";
import type { ServarrRelease } from "../src/upstream/servarr.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function recoveryConfig(): AppConfig {
  return {
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    qbittorrent: { url: "http://qbittorrent:8080", apiKey: "qbt_test-key" },
  } as AppConfig;
}

describe("duplicate download recovery", () => {
  it("recognizes Sonarr's misleading qBittorrent connection failure", () => {
    expect(
      looksLikeQbittorrentFailure(
        new UpstreamError(
          "sonarr",
          "http",
          "sonarr returned HTTP 500: Failed to connect to qBittorrent, check your settings.",
          500,
        ),
      ),
    ).toBe(true);
    expect(
      looksLikeQbittorrentFailure(
        new UpstreamError("sonarr", "unreachable", "sonarr did not respond in time"),
      ),
    ).toBe(false);
  });

  it("prefers the release info hash over title matching", () => {
    const torrents = [
      {
        hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
        name: "Parks.and.Recreation.S01.1080p.BluRay.x265-KONTRAST",
      },
      {
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "Parks and Recreation S01 1080p BluRay x265 KONTRAST",
      },
    ];
    const release: ServarrRelease = {
      title: "Parks and Recreation S01 1080p BluRay x265 KONTRAST",
      infoHash: "urn:btih:44DBB26758B4ED17BE93003F86C03461AFBE2D8C",
    };

    expect(matchingTorrentHash(torrents, release)).toBe(
      "44dbb26758b4ed17be93003f86c03461afbe2d8c",
    );
  });

  it("falls back to a punctuation-insensitive title match", () => {
    const torrents = [
      {
        hash: "cccccccccccccccccccccccccccccccccccccccc",
        name: "Parks.and.Recreation.S01.1080p.BluRay.x265-KONTRAST",
      },
    ];
    const release: ServarrRelease = {
      title: "Parks and Recreation S01 1080p BluRay x265 KONTRAST",
      infoHash: "",
    };

    expect(matchingTorrentHash(torrents, release)).toBe(
      "cccccccccccccccccccccccccccccccccccccccc",
    );
  });

  it("removes the duplicate without deleting files, waits for removal, then retries the arr grab", async () => {
    const deleted: string[] = [];
    let removed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v2/torrents/info")) {
          if (removed) {
            return Response.json([]);
          }
          return Response.json([
            {
              hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
              name: "Parks.and.Recreation.S01.1080p.BluRay.x265-KONTRAST",
            },
          ]);
        }
        if (url.endsWith("/api/v2/torrents/delete")) {
          const body = new URLSearchParams(String(init?.body));
          deleted.push(`${body.get("hashes")}:${body.get("deleteFiles")}`);
          removed = true;
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    let attempts = 0;
    const release: ServarrRelease = {
      title: "Parks and Recreation S01 1080p BluRay x265 KONTRAST",
      infoHash: "44DBB26758B4ED17BE93003F86C03461AFBE2D8C",
    };
    await grabWithDuplicateRecovery(recoveryConfig(), release, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new UpstreamError(
          "sonarr",
          "http",
          "sonarr returned HTTP 500: Failed to connect to qBittorrent, check your settings.",
          500,
        );
      }
    });

    expect(attempts).toBe(2);
    expect(deleted).toEqual(["44dbb26758b4ed17be93003f86c03461afbe2d8c:false"]);
    // The retry must happen only after qBittorrent has dropped the old torrent.
    expect(removed).toBe(true);
  });

  it("does not retry when qBittorrent cannot be authenticated", async () => {
    const config = recoveryConfig();
    config.qbittorrent.apiKey = undefined;
    const grab = vi.fn(async () => {
      throw new UpstreamError(
        "sonarr",
        "http",
        "sonarr returned HTTP 500: Failed to connect to qBittorrent, check your settings.",
        500,
      );
    });

    await expect(
      grabWithDuplicateRecovery(
        config,
        {
          title: "Parks and Recreation S01 1080p BluRay x265 KONTRAST",
          infoHash: "44DBB26758B4ED17BE93003F86C03461AFBE2D8C",
        },
        grab,
      ),
    ).rejects.toThrow(/QBITTORRENT_API_KEY is not configured/);
    expect(grab).toHaveBeenCalledTimes(1);
  });
});
