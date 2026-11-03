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
