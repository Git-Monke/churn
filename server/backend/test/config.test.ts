import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  jellyfinPublicUrlForRequest,
  loadConfig,
  readApiKeyFromConfigXml,
  readProwlarrApiKey,
  readQbittorrentApiKey,
  serviceUrlForRequest,
} from "../src/config.js";

function tempServerDir(): string {
  return mkdtempSync(path.join(tmpdir(), "churn-config-"));
}

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "churn-root-"));
}

function writeQbittorrentConfig(root: string, contents: string): void {
  const dir = path.join(root, "torrent", "config", "qbittorrent", "qBittorrent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "qBittorrent.conf"), contents);
}

function writeProwlarrConfig(root: string, key: string): void {
  const dir = path.join(root, "torrent", "config", "prowlarr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.xml"), `<Config>\n  <ApiKey>${key}</ApiKey>\n</Config>\n`);
}

function writeConfigXml(serverDir: string, app: "sonarr" | "radarr", key: string): void {
  const dir = path.join(serverDir, "config", app);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "config.xml"),
    `<Config>\n  <ApiKey>${key}</ApiKey>\n</Config>\n`,
  );
}

describe("config loading", () => {
  it("uses localhost defaults and reads arr keys from config.xml", () => {
    const serverDir = tempServerDir();
    writeConfigXml(serverDir, "sonarr", "sonarr-key");
    writeConfigXml(serverDir, "radarr", "radarr-key");

    const config = loadConfig({
      serverDir,
      env: {},
      readDotEnv: false,
      detectLan: () => undefined,
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.requestTimeoutMs).toBe(5_000);
    expect(config.searchTimeoutMs).toBe(20_000);
    expect(config.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(config.cookieSecure).toBe("auto");
    expect(config.services.jellyfin.url).toBe("http://127.0.0.1:8096");
    expect(config.jellyfinPublicUrl).toBe("http://127.0.0.1:8096");
    expect(config.jellyfinPublicUrlExplicit).toBe(false);
    expect(config.lanAddress).toBeUndefined();
    expect(config.services.jellyfin.apiKey).toBeUndefined();
    expect(config.services.sonarr.url).toBe("http://127.0.0.1:8989");
    expect(config.services.sonarr.apiKey).toBe("sonarr-key");
    expect(config.services.radarr.apiKey).toBe("radarr-key");
    expect(config.prowlarr).toEqual({ url: "http://127.0.0.1:9696" });
    expect(config.introdb).toEqual({
      url: "https://api.introdb.app",
      timeoutMs: 5_000,
    });
    expect(config.vpn).toEqual({
      statusUrl: "http://127.0.0.1:8098",
      timeoutMs: 25_000,
    });
  });

  it("reads the Prowlarr key from the torrent stack config", () => {
    const root = tempRoot();
    const serverDir = path.join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    writeProwlarrConfig(root, "prowlarr-key");

    expect(readProwlarrApiKey(serverDir)).toBe("prowlarr-key");
    expect(loadConfig({ serverDir, env: {}, readDotEnv: false }).prowlarr).toEqual({
      url: "http://127.0.0.1:9696",
      apiKey: "prowlarr-key",
    });
  });

  it("defaults the browser-facing video URL to the LAN address", () => {
    const serverDir = tempServerDir();

    const config = loadConfig({
      serverDir,
      env: {},
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    // The backend still talks to Jellyfin over loopback; only the URL handed
    // to the browser moves to the LAN address.
    expect(config.services.jellyfin.url).toBe("http://127.0.0.1:8096");
    expect(config.lanAddress).toBe("192.168.0.97");
    expect(config.jellyfinPublicUrl).toBe("http://192.168.0.97:8096");
    expect(config.jellyfinPublicUrlExplicit).toBe(false);
  });

  it("follows the request host when Jellyfin is only reachable through Churn", () => {
    const serverDir = tempServerDir();
    const config = loadConfig({
      serverDir,
      env: {},
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    expect(
      jellyfinPublicUrlForRequest(config, { host: "100.117.4.8:5173" }),
    ).toBe("http://100.117.4.8:8096");
    expect(
      jellyfinPublicUrlForRequest(config, {
        host: "127.0.0.1:4000",
        "x-forwarded-host": "fedora.tail457b41.ts.net",
      }),
    ).toBe("http://fedora.tail457b41.ts.net:8096");
    expect(
      jellyfinPublicUrlForRequest(config, {
        forwarded: 'for=100.64.0.2;proto=http;host="[fd7a:115c:a1e0::ca31:409]:4000"',
      }),
    ).toBe("http://[fd7a:115c:a1e0::ca31:409]:8096");
  });

  it("falls back to the LAN address when the request has no usable host", () => {
    const serverDir = tempServerDir();
    const config = loadConfig({
      serverDir,
      env: {},
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    expect(jellyfinPublicUrlForRequest(config, {})).toBe("http://192.168.0.97:8096");
    expect(
      jellyfinPublicUrlForRequest(config, { host: "evil.test/path" }),
    ).toBe("http://192.168.0.97:8096");
  });

  it("keeps an explicit or already-routable Jellyfin URL for playback", () => {
    const explicit = loadConfig({
      serverDir: tempServerDir(),
      env: { JELLYFIN_PUBLIC_URL: "https://media.example.test/jellyfin" },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });
    expect(explicit.jellyfinPublicUrlExplicit).toBe(true);
    expect(
      jellyfinPublicUrlForRequest(explicit, { host: "100.117.4.8:4000" }),
    ).toBe("https://media.example.test/jellyfin");

    const routable = loadConfig({
      serverDir: tempServerDir(),
      env: { JELLYFIN_URL: "http://media.example.test:8096" },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });
    expect(
      jellyfinPublicUrlForRequest(routable, { host: "100.117.4.8:4000" }),
    ).toBe("http://media.example.test:8096");
  });

  it("uses the request host for every service, keeping each port", () => {
    const config = loadConfig({
      serverDir: tempServerDir(),
      env: {},
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    expect(serviceUrlForRequest(config, "jellyfin", { host: "100.90.93.111:4000" })).toBe(
      "http://100.90.93.111:8096",
    );
    expect(serviceUrlForRequest(config, "sonarr", { host: "100.90.93.111:4000" })).toBe(
      "http://100.90.93.111:8989",
    );
    expect(
      serviceUrlForRequest(config, "radarr", {
        host: "127.0.0.1:4000",
        "x-forwarded-host": "fedora.tail457b41.ts.net",
      }),
    ).toBe("http://fedora.tail457b41.ts.net:7878");
    // The internal addresses used for probes never change.
    expect(config.services.sonarr.url).toBe("http://127.0.0.1:8989");
    expect(config.services.radarr.url).toBe("http://127.0.0.1:7878");
  });

  it("honours explicit public URL overrides for the arrs", () => {
    const config = loadConfig({
      serverDir: tempServerDir(),
      env: {
        SONARR_PUBLIC_URL: "https://sonarr.example.test/",
        RADARR_PUBLIC_URL: "https://radarr.example.test",
      },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    expect(serviceUrlForRequest(config, "sonarr", { host: "100.90.93.111:4000" })).toBe(
      "https://sonarr.example.test",
    );
    expect(serviceUrlForRequest(config, "radarr", {})).toBe(
      "https://radarr.example.test",
    );
  });

  it("keeps the scheme, port and base path when substituting the LAN address", () => {
    const serverDir = tempServerDir();

    const config = loadConfig({
      serverDir,
      env: { JELLYFIN_URL: "https://localhost:443/jellyfin/" },
      readDotEnv: false,
      detectLan: () => "10.1.2.3",
    });

    expect(config.jellyfinPublicUrl).toBe("https://10.1.2.3/jellyfin");
  });

  it("substitutes the LAN address for a container hostname", () => {
    const serverDir = tempServerDir();

    const config = loadConfig({
      serverDir,
      env: { JELLYFIN_URL: "http://jellyfin:8096" },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });

    expect(config.services.jellyfin.url).toBe("http://jellyfin:8096");
    expect(config.jellyfinPublicUrl).toBe("http://192.168.0.97:8096");
  });

  it("leaves explicit and already-routable Jellyfin URLs alone", () => {
    const serverDir = tempServerDir();

    const explicit = loadConfig({
      serverDir,
      env: {
        JELLYFIN_URL: "http://127.0.0.1:8096",
        JELLYFIN_PUBLIC_URL: "https://media.example.test/jellyfin",
      },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });
    expect(explicit.jellyfinPublicUrl).toBe("https://media.example.test/jellyfin");

    const routable = loadConfig({
      serverDir,
      env: { JELLYFIN_URL: "http://media.example.test:8096" },
      readDotEnv: false,
      detectLan: () => "192.168.0.97",
    });
    expect(routable.jellyfinPublicUrl).toBe("http://media.example.test:8096");
  });

  it("reads the qBittorrent key from env or the seeded config file", () => {
    const root = tempRoot();
    const serverDir = path.join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    writeQbittorrentConfig(
      root,
      ["[WebUI]", "APIKey=file-key", "Address=*", "ServerDomains=*"].join("\n"),
    );

    const fromFile = loadConfig({ serverDir, env: {}, readDotEnv: false });
    expect(fromFile.qbittorrent).toEqual({
      url: "http://127.0.0.1:8080",
      apiKey: "file-key",
    });

    const fromEnv = loadConfig({
      serverDir,
      env: {
        QBITTORRENT_URL: "http://qbittorrent:8081/",
        QBITTORRENT_API_KEY: "env-key",
      },
      readDotEnv: false,
    });
    expect(fromEnv.qbittorrent).toEqual({
      url: "http://qbittorrent:8081",
      apiKey: "env-key",
    });
  });

  it("reads legacy qBittorrent keys and ignores missing config", () => {
    const root = tempRoot();
    const serverDir = path.join(root, "server");
    mkdirSync(serverDir, { recursive: true });
    writeQbittorrentConfig(
      root,
      ["[Preferences]", "WebUI\\APIKey=legacy-key", "[WebUI]", "Address=*"].join("\n"),
    );

    expect(readQbittorrentApiKey(serverDir)).toBe("legacy-key");
    expect(loadConfig({ serverDir, env: {}, readDotEnv: false }).qbittorrent.apiKey).toBe(
      "legacy-key",
    );

    const emptyRoot = tempRoot();
    const emptyServer = path.join(emptyRoot, "server");
    mkdirSync(emptyServer, { recursive: true });
    expect(readQbittorrentApiKey(emptyServer)).toBeUndefined();
    expect(loadConfig({ serverDir: emptyServer, env: {}, readDotEnv: false }).qbittorrent).toEqual({
      url: "http://127.0.0.1:8080",
    });
  });

  it("lets environment variables override URLs and keys", () => {
    const serverDir = tempServerDir();
    writeConfigXml(serverDir, "sonarr", "file-key");

    const config = loadConfig({
      serverDir,
      env: {
        HOST: "0.0.0.0",
        PORT: "5000",
        JELLYFIN_URL: "http://jellyfin:8096/",
        JELLYFIN_PUBLIC_URL: "https://media.example.test/jellyfin/",
        JELLYFIN_API_KEY: "jellyfin-key",
        SONARR_URL: "http://sonarr:8989",
        SONARR_API_KEY: "env-key",
        CHURN_SESSION_TTL_MS: "3600000",
        CHURN_STATE_DIR: "/tmp/churn-custom-state",
        CHURN_COOKIE_SECURE: "true",
        PROWLARR_URL: "http://prowlarr:9696/",
        PROWLARR_API_KEY: "prowlarr-env-key",
        INTRODB_URL: "https://introdb.example.test/",
        INTRODB_TIMEOUT_MS: "3000",
        VPN_STATUS_URL: "http://vpn-status:8098/",
        VPN_STATUS_TIMEOUT_MS: "30000",
        SEARCH_TIMEOUT_MS: "15000",
        RELEASE_TIMEOUT_MS: "150000",
      },
      readDotEnv: false,
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(5000);
    expect(config.services.jellyfin.url).toBe("http://jellyfin:8096");
    expect(config.jellyfinPublicUrl).toBe("https://media.example.test/jellyfin");
    expect(config.jellyfinPublicUrlExplicit).toBe(true);
    expect(config.services.jellyfin.apiKey).toBe("jellyfin-key");
    expect(config.services.sonarr.url).toBe("http://sonarr:8989");
    expect(config.services.sonarr.apiKey).toBe("env-key");
    expect(config.searchTimeoutMs).toBe(15_000);
    expect(config.releaseTimeoutMs).toBe(150_000);
    expect(config.sessionTtlMs).toBe(3_600_000);
    expect(config.stateDir).toBe("/tmp/churn-custom-state");
    expect(config.cookieSecure).toBe(true);
    expect(config.prowlarr).toEqual({
      url: "http://prowlarr:9696",
      apiKey: "prowlarr-env-key",
    });
    expect(config.introdb).toEqual({
      url: "https://introdb.example.test",
      timeoutMs: 3_000,
    });
    expect(config.vpn).toEqual({
      statusUrl: "http://vpn-status:8098",
      timeoutMs: 30_000,
    });
  });

  it("loads server/.env but lets process environment win", () => {
    const serverDir = tempServerDir();
    writeFileSync(
      path.join(serverDir, ".env"),
      "PORT=4100\nJELLYFIN_API_KEY=from-file\nSONARR_URL=http://from-file:8989\n",
    );

    const config = loadConfig({
      serverDir,
      env: { SONARR_URL: "http://from-env:8989" },
    });

    expect(config.port).toBe(4100);
    expect(config.services.jellyfin.apiKey).toBe("from-file");
    expect(config.services.sonarr.url).toBe("http://from-env:8989");
  });

  it("ignores missing and malformed config.xml files", () => {
    const serverDir = tempServerDir();
    const dir = path.join(serverDir, "config", "sonarr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.xml"), "<Config></Config>");

    expect(readApiKeyFromConfigXml(serverDir, "sonarr")).toBeUndefined();
    expect(readApiKeyFromConfigXml(serverDir, "radarr")).toBeUndefined();
  });

  it("rejects invalid URLs and ports", () => {
    const serverDir = tempServerDir();
    expect(() =>
      loadConfig({ serverDir, env: { JELLYFIN_URL: "ftp://jellyfin" }, readDotEnv: false }),
    ).toThrow(/http or https/);
    expect(() => loadConfig({ serverDir, env: { PORT: "99999" }, readDotEnv: false })).toThrow(
      /invalid PORT/,
    );
    expect(() =>
      loadConfig({
        serverDir,
        env: { VPN_STATUS_TIMEOUT_MS: "soon" },
        readDotEnv: false,
      }),
    ).toThrow(/VPN_STATUS_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { VPN_STATUS_TIMEOUT_MS: "10" },
        readDotEnv: false,
      }),
    ).toThrow(/VPN_STATUS_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { SEARCH_TIMEOUT_MS: "soon" },
        readDotEnv: false,
      }),
    ).toThrow(/SEARCH_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { SEARCH_TIMEOUT_MS: "500" },
        readDotEnv: false,
      }),
    ).toThrow(/SEARCH_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { RELEASE_TIMEOUT_MS: "soon" },
        readDotEnv: false,
      }),
    ).toThrow(/RELEASE_TIMEOUT_MS/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { RELEASE_TIMEOUT_MS: "1000" },
        readDotEnv: false,
      }),
    ).toThrow(/RELEASE_TIMEOUT_MS/);
  });

  it("clamps the session TTL and parses the cookie secure setting", () => {
    const serverDir = tempServerDir();
    expect(
      loadConfig({
        serverDir,
        env: { CHURN_SESSION_TTL_MS: "1" },
        readDotEnv: false,
      }).sessionTtlMs,
    ).toBe(5 * 60 * 1000);
    expect(
      loadConfig({
        serverDir,
        env: { CHURN_SESSION_TTL_MS: "999999999999" },
        readDotEnv: false,
      }).sessionTtlMs,
    ).toBe(30 * 24 * 60 * 60 * 1000);
    expect(
      loadConfig({
        serverDir,
        env: { CHURN_COOKIE_SECURE: "false" },
        readDotEnv: false,
      }).cookieSecure,
    ).toBe(false);
    expect(
      loadConfig({
        serverDir,
        env: { CHURN_COOKIE_SECURE: "auto" },
        readDotEnv: false,
      }).cookieSecure,
    ).toBe("auto");
    expect(() =>
      loadConfig({
        serverDir,
        env: { CHURN_COOKIE_SECURE: "sometimes" },
        readDotEnv: false,
      }),
    ).toThrow(/CHURN_COOKIE_SECURE/);
    expect(() =>
      loadConfig({
        serverDir,
        env: { CHURN_SESSION_TTL_MS: "soon" },
        readDotEnv: false,
      }),
    ).toThrow(/CHURN_SESSION_TTL_MS/);
  });
});
