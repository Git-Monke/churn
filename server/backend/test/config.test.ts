import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, readApiKeyFromConfigXml } from "../src/config.js";

function tempServerDir(): string {
  return mkdtempSync(path.join(tmpdir(), "churn-config-"));
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

    const config = loadConfig({ serverDir, env: {}, readDotEnv: false });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(config.cookieSecure).toBe("auto");
    expect(config.services.jellyfin.url).toBe("http://127.0.0.1:8096");
    expect(config.jellyfinPublicUrl).toBe("http://127.0.0.1:8096");
    expect(config.services.jellyfin.apiKey).toBeUndefined();
    expect(config.services.sonarr.url).toBe("http://127.0.0.1:8989");
    expect(config.services.sonarr.apiKey).toBe("sonarr-key");
    expect(config.services.radarr.apiKey).toBe("radarr-key");
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
        CHURN_COOKIE_SECURE: "true",
      },
      readDotEnv: false,
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(5000);
    expect(config.services.jellyfin.url).toBe("http://jellyfin:8096");
    expect(config.jellyfinPublicUrl).toBe("https://media.example.test/jellyfin");
    expect(config.services.jellyfin.apiKey).toBe("jellyfin-key");
    expect(config.services.sonarr.url).toBe("http://sonarr:8989");
    expect(config.services.sonarr.apiKey).toBe("env-key");
    expect(config.sessionTtlMs).toBe(3_600_000);
    expect(config.cookieSecure).toBe(true);
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
