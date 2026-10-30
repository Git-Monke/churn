import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

function makeConfig(overrides: Partial<AppConfig["services"]> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-test",
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    services: {
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        ...overrides.jellyfin,
      },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://sonarr.test:8989",
        apiKey: "sonarr-key",
        ...overrides.sonarr,
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://radarr.test:7878",
        apiKey: "radarr-key",
        ...overrides.radarr,
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const appConfig = makeConfig();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health", () => {
  it("reports backend liveness", async () => {
    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("status", () => {
  it("reports ok arrs and a setup-required Jellyfin", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test")) {
        return jsonResponse({
          Version: "10.11.11",
          StartupWizardCompleted: false,
        });
      }
      if (url.includes("sonarr.test")) {
        return jsonResponse({ appName: "Sonarr", version: "4.0.20" });
      }
      if (url.includes("radarr.test")) {
        return jsonResponse({ appName: "Radarr", version: "6.4.4" });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.services).toHaveLength(3);
    expect(body.services[0]).toMatchObject({
      id: "jellyfin",
      state: "unconfigured",
      version: "10.11.11",
    });
    expect(body.services[1]).toMatchObject({ id: "sonarr", state: "ok", version: "4.0.20" });
    expect(body.services[2]).toMatchObject({ id: "radarr", state: "ok", version: "6.4.4" });
    await app.close();
  });

  it("keeps the route healthy when one service is down", async () => {
    installFetch((url) => {
      if (url.includes("radarr.test")) {
        throw new Error("connection refused");
      }
      if (url.includes("jellyfin.test")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: false });
      }
      return jsonResponse({ appName: "Sonarr", version: "4.0.20" });
    });

    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/status" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[1].state).toBe("ok");
    expect(body.services[2].state).toBe("unreachable");
    await app.close();
  });

  it("marks an invalid arr key as unauthorized", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: false });
      }
      return jsonResponse({}, 401);
    });

    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/status" });
    const body = response.json();

    expect(body.services[1].state).toBe("unauthorized");
    expect(body.services[2].state).toBe("unauthorized");
    await app.close();
  });
});

describe("library", () => {
  it("returns setup_required when Jellyfin's wizard is incomplete", async () => {
    installFetch(() => jsonResponse({ Version: "10.11.11", StartupWizardCompleted: false }));

    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/library" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "jellyfin",
      state: "setup_required",
      items: [],
      total: 0,
    });
    await app.close();
  });

  it("returns unconfigured when the wizard is complete but no key is set", async () => {
    installFetch(() => jsonResponse({ Version: "10.11.11", StartupWizardCompleted: true }));

    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/library" });

    expect(response.json().state).toBe("unconfigured");
    await app.close();
  });

  it("maps Jellyfin items and backend image URLs", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "jellyfin-key",
      },
    });

    installFetch((url) => {
      if (url.endsWith("/System/Info/Public")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: true });
      }
      if (url.includes("/Items?")) {
        return jsonResponse({
          Items: [
            {
              Id: "movie-1",
              Name: "Example Movie",
              Type: "Movie",
              ProductionYear: 2020,
              ImageTags: { Primary: "poster-tag" },
            },
            { Id: "bad", Name: "Ignored", Type: "Audio" },
          ],
          TotalRecordCount: 2,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library" });
    const body = response.json();

    expect(body.state).toBe("ok");
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: "movie-1",
      name: "Example Movie",
      type: "Movie",
      year: 2020,
      imageUrl: "/api/library/images/movie-1?tag=poster-tag",
    });
    await app.close();
  });

  it("returns unauthorized when Jellyfin rejects the key", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "wrong",
      },
    });

    installFetch((url) => {
      if (url.endsWith("/System/Info/Public")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: true });
      }
      return jsonResponse({}, 401);
    });

    const app = await buildServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library" });

    expect(response.json().state).toBe("unauthorized");
    await app.close();
  });
});

describe("library images", () => {
  it("proxies the image with cache headers", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "jellyfin-key",
      },
    });

    const mock = installFetch((url) => {
      expect(url).toContain("/Items/movie-1/Images/Primary");
      expect(url).toContain("tag=poster-tag");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const app = await buildServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/images/movie-1?tag=poster-tag&maxWidth=400",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toContain("max-age=86400");
    expect(response.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(mock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects invalid ids and query parameters", async () => {
    const app = await buildServer(makeConfig());
    const badId = await app.inject({ method: "GET", url: "/api/library/images/bad!id" });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe("invalid_item_id");

    const badTag = await app.inject({
      method: "GET",
      url: "/api/library/images/movie-1?tag=not%20allowed",
    });
    expect(badTag.statusCode).toBe(400);
    expect(badTag.json().error.code).toBe("invalid_query");

    const badSize = await app.inject({
      method: "GET",
      url: "/api/library/images/movie-1?maxWidth=9999",
    });
    expect(badSize.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for a missing upstream image", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "jellyfin-key",
      },
    });
    installFetch(() => jsonResponse({}, 404));

    const app = await buildServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library/images/movie-1" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("service links and unknown routes", () => {
  it("redirects known services and rejects unknown ids", async () => {
    const app = await buildServer(makeConfig());
    const known = await app.inject({ method: "GET", url: "/api/services/sonarr/open" });
    expect(known.statusCode).toBe(302);
    expect(known.headers.location).toBe("http://sonarr.test:8989");

    const unknown = await app.inject({ method: "GET", url: "/api/services/nope/open" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("unknown_service");
    await app.close();
  });

  it("returns a JSON envelope for unknown API routes", async () => {
    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});
