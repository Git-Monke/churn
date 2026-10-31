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
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
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

const profiles = [
  { id: 1, name: "Any" },
  { id: 4, name: "HD-1080p" },
  { id: 6, name: "HD - 720p/1080p" },
];

const rootFolders = [
  { id: 1, path: "/data/media/tv", accessible: true, freeSpace: 123 },
  { id: 2, path: "/data/media/movies", accessible: true },
];

const seriesLookup = {
  title: "Severance",
  year: 2022,
  tvdbId: 371980,
  tmdbId: 95396,
  network: "Apple TV",
  ratings: { value: 8.6 },
  seasons: [
    { seasonNumber: 0, monitored: false },
    { seasonNumber: 1, monitored: true },
  ],
  images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg" }],
};

const movieLookup = {
  title: "Dune",
  year: 2021,
  tmdbId: 438631,
  imdbId: "tt1160419",
  ratings: { imdb: { value: 8 } },
  images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg" }],
};

function readBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("request options", () => {
  it("returns profiles, root folders and preferred defaults", async () => {
    installFetch((url) => {
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/requests/options" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body.services.sonarr).toMatchObject({
      state: "ok",
      defaults: {
        qualityProfileId: 6,
        rootFolderPath: "/data/media/tv",
        monitor: "all",
        searchOnAdd: true,
      },
    });
    expect(body.services.radarr.defaults.monitor).toBeUndefined();
    expect(body.services.radarr.rootFolders).toEqual([
      { path: "/data/media/tv", accessible: true, freeSpace: 123 },
      { path: "/data/media/movies", accessible: true, freeSpace: undefined },
    ]);
    await app.close();
  });

  it("degrades cleanly when one app has no API key", async () => {
    installFetch((url) => {
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildServer(
      makeConfig({
        sonarr: { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989", apiKey: undefined },
      }),
    );
    const response = await app.inject({ method: "GET", url: "/api/requests/options" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services.sonarr.state).toBe("unconfigured");
    expect(body.services.radarr.state).toBe("ok");
    await app.close();
  });
});

describe("search", () => {
  it("merges Sonarr and Radarr results and marks library matches", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test")) {
        if (url.includes("/series/lookup")) {
          return jsonResponse([seriesLookup, { title: "Bad", tvdbId: undefined }]);
        }
        if (url.endsWith("/api/v3/series")) return jsonResponse([{ tvdbId: 371980 }]);
      }
      if (url.includes("radarr.test")) {
        if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
        if (url.endsWith("/api/v3/movie")) return jsonResponse([]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=dune" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.query).toBe("dune");
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ key: "series:371980", inLibrary: true });
    expect(body.results[1]).toMatchObject({
      key: "movie:438631",
      inLibrary: false,
      imageUrl: "/api/search/images/radarr?path=%2FMediaCoverProxy%2Fdef%2Fposter.jpg",
    });
    expect(body.services).toEqual([
      { id: "sonarr", state: "ok", count: 1, detail: undefined },
      { id: "radarr", state: "ok", count: 1, detail: undefined },
    ]);
    await app.close();
  });

  it("keeps the other app's results when one lookup fails", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test")) {
        if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
        return jsonResponse([]);
      }
      throw new Error("connection refused");
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=severance" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.services[0].state).toBe("ok");
    expect(body.services[1].state).toBe("unreachable");
    await app.close();
  });

  it("returns inLibrary null when the library list fails", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test")) {
        if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
        throw new Error("library unavailable");
      }
      return jsonResponse([]);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=severance" });
    const body = response.json();

    expect(body.results[0].inLibrary).toBeNull();
    expect(body.services[0].state).toBe("ok");
    expect(body.services[0].detail).toContain("Could not check");
    await app.close();
  });

  it("validates the query", async () => {
    const app = await buildServer(makeConfig());
    expect((await app.inject({ method: "GET", url: "/api/search?q=a" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/search" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/search?q=${"x".repeat(121)}` })).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe("search images", () => {
  it("proxies an allowlisted arr media cover", async () => {
    const mock = installFetch((url) => {
      expect(url).toBe(
        "http://sonarr.test:8989/MediaCoverProxy/abc/poster.jpg",
      );
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?path=%2FMediaCoverProxy%2Fabc%2Fposter.jpg",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toContain("max-age=86400");
    expect(response.rawPayload).toEqual(Buffer.from([9, 8, 7]));
    expect(mock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects unknown services and non-allowlisted paths", async () => {
    const app = await buildServer(makeConfig());
    const unknown = await app.inject({
      method: "GET",
      url: "/api/search/images/jellyfin?path=%2FMediaCoverProxy%2Fabc%2Fposter.jpg",
    });
    expect(unknown.statusCode).toBe(404);

    const badPath = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?path=https%3A%2F%2Fevil.test%2Fposter.jpg",
    });
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json().error.code).toBe("invalid_path");

    const traversal = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?path=%2FMediaCoverProxy%2F..%2Fposter.jpg",
    });
    expect(traversal.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for a missing image", async () => {
    installFetch(() => new Response(null, { status: 404 }));
    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?path=%2FMediaCoverProxy%2Fabc%2Fposter.jpg",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("create requests", () => {
  it("adds a movie with resolved defaults", async () => {
    let posted: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...movieLookup, id: 7 });
        }
        return jsonResponse([]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ status: "added", service: "radarr", title: "Dune", id: 7 });
    expect(posted).toMatchObject({
      title: "Dune",
      tmdbId: 438631,
      qualityProfileId: 6,
      rootFolderPath: "/data/media/tv",
      monitored: true,
      minimumAvailability: "released",
      addOptions: { searchForMovie: true },
    });
    expect(posted).not.toHaveProperty("id");
    await app.close();
  });

  it("adds a series with an overridden monitoring scope", async () => {
    let posted: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
      if (url.endsWith("/api/v3/series")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...seriesLookup, id: 11 });
        }
        return jsonResponse([]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        kind: "series",
        tvdbId: 371980,
        options: {
          qualityProfileId: 4,
          rootFolderPath: "/data/media/tv",
          monitor: "firstSeason",
          searchOnAdd: false,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(posted).toMatchObject({
      qualityProfileId: 4,
      rootFolderPath: "/data/media/tv",
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: true },
      ],
      addOptions: { monitor: "firstSeason", searchForMissingEpisodes: false },
    });
    await app.close();
  });

  it("is idempotent when the title is already in the library", async () => {
    const mock = installFetch((url, init) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") throw new Error("must not add a duplicate");
        return jsonResponse([{ ...movieLookup, id: 9 }]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "already_exists",
      service: "radarr",
      title: "Dune",
      id: 9,
    });
    expect(mock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/v3/movie"),
      expect.objectContaining({ method: "POST" }),
    );
    await app.close();
  });

  it("rejects invalid bodies, ids and unavailable options", async () => {
    installFetch((url) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) return jsonResponse([]);
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const badKind = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "book" },
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error.code).toBe("invalid_kind");

    const badId = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 0 },
    });
    expect(badId.statusCode).toBe(400);

    const badProfile = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631, options: { qualityProfileId: 999 } },
    });
    expect(badProfile.statusCode).toBe(400);
    expect(badProfile.json().error.code).toBe("invalid_quality_profile");

    const badFolder = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631, options: { rootFolderPath: "/nope" } },
    });
    expect(badFolder.statusCode).toBe(400);
    expect(badFolder.json().error.code).toBe("invalid_root_folder");
    await app.close();
  });

  it("surfaces arr validation messages", async () => {
    installFetch((url, init) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          return jsonResponse([{ propertyName: "RootFolderPath", errorMessage: "Folder is not writable" }], 400);
        }
        return jsonResponse([]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("Folder is not writable");
    await app.close();
  });
});

