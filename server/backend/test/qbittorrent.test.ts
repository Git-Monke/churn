import { afterEach, describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../src/errors.js";
import { createQbittorrentClient } from "../src/upstream/qbittorrent.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("qBittorrent client", () => {
  it("reads the torrent list with a Bearer key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://qbittorrent.test:8080/api/v2/torrents/info");
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        authorization: "Bearer qbt_test-key",
      });
      return new Response(JSON.stringify([{ hash: "abc", progress: 0.5 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
      500,
    );

    await expect(client.getTorrents()).resolves.toEqual([{ hash: "abc", progress: 0.5 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a duplicate torrent without deleting its files", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://qbittorrent.test:8080/api/v2/torrents/delete");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer qbt_test-key",
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(String(init?.body)).toBe("hashes=44dbb26758b4ed17be93003f86c03461afbe2d8c&deleteFiles=false");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
      500,
    );

    await expect(
      client.removeTorrent("urn:btih:44DBB26758B4ED17BE93003F86C03461AFBE2D8C"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adds a torrent with the direct-download layout", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://qbittorrent.test:8080/api/v2/torrents/add");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer qbt_test-key",
        "content-type": "application/x-www-form-urlencoded",
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("urls")).toBe("magnet:?xt=urn:btih:abc123");
      expect(body.get("savepath")).toBe("/data/media/tv/Example Show (2024)/Season 1");
      expect(body.get("category")).toBe("tv");
      expect(body.get("tags")).toBe("churn-direct");
      expect(body.get("contentLayout")).toBe("NoSubfolder");
      expect(body.get("autoTMM")).toBe("false");
      expect(body.get("paused")).toBe("false");
      return new Response("Ok.", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
      500,
    );

    await expect(
      client.addTorrent({
        url: "magnet:?xt=urn:btih:abc123",
        savePath: "/data/media/tv/Example Show (2024)/Season 1",
        category: "tv",
        tags: ["churn-direct"],
        contentLayout: "NoSubfolder",
      }),
    ).resolves.toEqual({ added: 1, pending: 0, failed: 0, torrentIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the qBittorrent 5.2 JSON add response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success_count: 1,
            failure_count: 0,
            pending_count: 0,
            added_torrent_ids: ["abc123"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
      500,
    );

    await expect(
      client.addTorrent({
        url: "https://prowlarr.test/1/download?link=abc",
        savePath: "/data/media/movies/Example Movie (2022)",
        category: "movies",
        contentLayout: "NoSubfolder",
      }),
    ).resolves.toEqual({ added: 1, pending: 0, failed: 0, torrentIds: ["abc123"] });
  });

  it("reports a rejected add response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Fails.", { status: 200 })),
    );

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_test-key" },
      500,
    );

    await expect(
      client.addTorrent({ url: "magnet:?xt=urn:btih:abc", savePath: "/data/media/tv" }),
    ).rejects.toMatchObject({
      service: "qbittorrent",
      kind: "http",
      message: "qBittorrent rejected that torrent",
    });
  });

  it("fails as unauthorized without a key and does not call upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = createQbittorrentClient({ url: "http://qbittorrent.test:8080" }, 500);

    await expect(client.getTorrents()).rejects.toMatchObject({
      service: "qbittorrent",
      kind: "unauthorized",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a rejected key to an unauthorized upstream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Forbidden", { status: 403 })),
    );

    const client = createQbittorrentClient(
      { url: "http://qbittorrent.test:8080", apiKey: "qbt_bad" },
      500,
    );

    await expect(client.getTorrents()).rejects.toBeInstanceOf(UpstreamError);
    await expect(client.getTorrents()).rejects.toMatchObject({ kind: "unauthorized" });
  });
});
