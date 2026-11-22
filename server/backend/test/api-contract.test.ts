import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { API_ROUTES, UNDESCRIBED_ROUTES } from "../src/api-contract.js";
import { buildServer } from "../src/server.js";
import { buildOpenApi, OPENAPI_PATH, serialize } from "../scripts/openapi.js";
import { createContractChecker } from "./support/api-contract-check.js";
import type { AppConfig } from "../src/config.js";

describe("the API contract", () => {
  it("is up to date: openapi.json matches the route table and the types", () => {
    const committed = readFileSync(OPENAPI_PATH, "utf8");
    expect(
      committed === serialize(buildOpenApi()),
      "server/openapi.json is stale. Run `npm run api:generate` in server/ and commit the result.",
    ).toBe(true);
  }, 30_000);

  it("describes every route the server registers, or lists it as not described yet", async () => {
    const registered: string[] = [];
    const config = testConfig();
    const app = await buildServer(config, {
      onRoute: (route) => {
        for (const method of [route.method].flat()) {
          if (method !== "HEAD" && route.url.startsWith("/api/")) registered.push(`${method} ${route.url}`);
        }
      },
    });
    await app.close();

    const known = new Set([...API_ROUTES, ...UNDESCRIBED_ROUTES].map((route) => `${route.method} ${route.path}`));
    const served = [...new Set(registered)].sort();
    const missing = served.filter((route) => !known.has(route));
    expect(missing, "Add these routes to API_ROUTES (or UNDESCRIBED_ROUTES) in src/api-contract.ts").toEqual([]);
    const gone = [...known].filter((route) => !served.includes(route));
    expect(gone, "These routes are in src/api-contract.ts but no longer served").toEqual([]);
  });

  it("lets anyone call the routes it marks public, on both paths", async () => {
    const app = await buildServer(testConfig());
    for (const route of API_ROUTES.filter((entry) => entry.auth === "none" && entry.method === "GET")) {
      for (const url of [route.path, route.path.replace(/^\/api\//, "/api/v1/")]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, `${url} should not need a sign-in`).not.toBe(401);
      }
    }
    const signedOut = await app.inject({ method: "GET", url: "/api/v1/library" });
    expect(signedOut.statusCode).toBe(401);
    await app.close();
  });

  it("catches a response that does not match its type", () => {
    const checker = createContractChecker();
    checker.check({
      method: "GET",
      route: "/api/health",
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      payload: JSON.stringify({ status: "ok" }),
    });
    checker.check({
      method: "GET",
      route: "/api/library",
      statusCode: 200,
      contentType: "application/json",
      payload: JSON.stringify({ source: "jellyfin", state: "ok", items: [{ id: 1 }], total: 1, extra: true }),
    });
    checker.check({
      method: "GET",
      route: "/api/library",
      statusCode: 500,
      contentType: "application/json",
      payload: JSON.stringify({ message: "not the envelope" }),
    });
    expect(checker.checked).toBe(3);
    expect(() => checker.assertClean()).toThrow(/GET \/api\/library 200[\s\S]*GET \/api\/library 500/);
    expect(() => checker.assertClean()).not.toThrow();
  });
});

/** A config whose state lives in a fresh temporary directory per call. */
function testConfig(): AppConfig {
  const serverDir = mkdtempSync(path.join(tmpdir(), "churn-contract-"));
  return {
    host: "127.0.0.1",
    port: 0,
    serverDir,
    frontendDist: "/nonexistent",
    requestTimeoutMs: 100,
    releaseTimeoutMs: 100,
    searchTimeoutMs: 100,
    sessionTtlMs: 60_000,
    stateDir: path.join(serverDir, "state"),
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
    services: {
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://jellyfin.test:8096" },
      sonarr: { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989" },
      radarr: { id: "radarr", name: "Radarr", url: "http://radarr.test:7878" },
    },
    qbittorrent: { url: "http://qbittorrent.test:8080" },
    prowlarr: { url: "http://prowlarr.test:9696" },
    introdb: { url: "https://api.introdb.test", timeoutMs: 100 },
    vpn: { statusUrl: "http://vpn-status.test:8098", timeoutMs: 100 },
  } as unknown as AppConfig;
}
