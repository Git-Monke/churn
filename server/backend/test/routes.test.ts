import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

let testServerCounter = 0;

function makeConfig(overrides: Partial<AppConfig["services"]> = {}): AppConfig {
  const serverDir = `/tmp/churn-test-${process.pid}-${++testServerCounter}`;
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir,
    frontendDist: "/tmp/churn-test/frontend/dist",
    requestTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
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
    qbittorrent: {
      url: "http://qbittorrent.test:8080",
    },
    vpn: {
      statusUrl: "http://vpn-status.test:8098",
      timeoutMs: 500,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const testAuthResult = {
  AccessToken: "test-user-token",
  User: { Id: "test-user", Name: "tester", Policy: { IsAdministrator: true } },
};

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/Users/AuthenticateByName")) {
      return jsonResponse(testAuthResult);
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function login(app: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "tester", password: "test-password" },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error("login did not set a session cookie");
  }
  const cookie = cookieHeader.split(";")[0] ?? cookieHeader;
  const fetchMock = globalThis.fetch as unknown as { mockClear?: () => void };
  fetchMock.mockClear?.();
  return cookie;
}

/** Build an app, sign in once, and attach the session cookie to every inject. */
async function buildAuthedServer(config: AppConfig): Promise<Awaited<ReturnType<typeof buildServer>>> {
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/Users/AuthenticateByName")) {
          return jsonResponse(testAuthResult);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }
  const app = await buildServer(config);
  const cookie = await login(app);

  const originalInject = app.inject.bind(app) as unknown as (
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
  app.inject = ((opts: string | Record<string, unknown>) => {
    const options: Record<string, unknown> =
      typeof opts === "string" ? { method: "GET", url: opts } : { ...opts };
    const headers = {
      ...((options.headers as Record<string, string> | undefined) ?? {}),
      cookie,
    };
    return originalInject({ ...options, headers });
  }) as unknown as typeof app.inject;

  return app;
}

function flattenCachedReleases(body: {
  groups?: Array<{ releases: Array<{ title: string }> }>;
}): Array<Record<string, unknown>> {
  return (body.groups ?? []).flatMap((group) => group.releases as Array<Record<string, unknown>>);
}

async function waitForCachedReleases(
  app: Awaited<ReturnType<typeof buildServer>>,
  url: string,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url });
    const body = response.json() as Record<string, any>;
    if (body.state === "ready" || body.state === "error") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`release cache did not become ready for ${url}`);
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

function vpnAgentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkedAt: "2026-01-01T12:00:00.000Z",
    durationMs: 1840,
    secure: true,
    checks: {
      mullvadExit: true,
      killSwitch: true,
      dns: true,
      ipv6: true,
      firewallException: true,
    },
    mullvad: {
      ip: "185.65.134.10",
      country: "Netherlands",
      city: "Amsterdam",
      organization: "Mullvad VPN",
      mullvad_exit_ip: true,
      mullvad_exit_ip_hostname: "nl-ams-wg-001",
      mullvad_server_type: "wireguard",
    },
    dns: { nameservers: ["127.0.0.1"] },
    firewall: { directEgressBlocked: true, exception: "192.168.1.10/32" },
    ipv6: { disabled: true },
    coverage: [
      { id: "qbittorrent", reachable: true },
      { id: "prowlarr", reachable: true },
      { id: "flaresolverr", reachable: false },
    ],
    ...overrides,
  };
}

describe("vpn", () => {
  it("requires a dashboard session", async () => {
    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/vpn" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
    await app.close();
  });

  it("returns the exit identity, checks and coverage", async () => {
    installFetch((url) => {
      expect(url).toBe("http://vpn-status.test:8098/status");
      return jsonResponse(vpnAgentPayload());
    });

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/vpn" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      secure: true,
      exit: {
        ip: "185.65.134.10",
        country: "Netherlands",
        city: "Amsterdam",
        hostname: "nl-ams-wg-001",
        organization: "Mullvad VPN",
        serverType: "wireguard",
        mullvadExit: true,
      },
      dnsNameservers: ["127.0.0.1"],
      firewallException: "192.168.1.10/32",
    });
    expect(body.checks).toHaveLength(5);
    expect(body.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
    expect(body.coverage).toEqual([
      { id: "qbittorrent", name: "qBittorrent", reachable: true },
      { id: "prowlarr", name: "Prowlarr", reachable: true },
      { id: "flaresolverr", name: "FlareSolverr", reachable: false },
    ]);
    await app.close();
  });

  it("reports a leak without failing the request", async () => {
    installFetch(() =>
      jsonResponse(
        vpnAgentPayload({
          secure: false,
          checks: {
            mullvadExit: false,
            killSwitch: false,
            dns: true,
            ipv6: true,
            firewallException: true,
          },
          firewall: { directEgressBlocked: false, exception: "192.168.1.10/32" },
        }),
      ),
    );

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/vpn" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.secure).toBe(false);
    expect(body.checks).toContainEqual(
      expect.objectContaining({ id: "kill_switch", passed: false }),
    );
    expect(body.checks).toContainEqual(
      expect.objectContaining({ id: "mullvad_exit", passed: false }),
    );
    await app.close();
  });

  it("rejects a malformed agent response", async () => {
    installFetch(() => jsonResponse({ checkedAt: "2026-01-01T12:00:00.000Z" }));

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/vpn" });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("invalid_response");
    await app.close();
  });

  it("returns an upstream error when the agent is unreachable", async () => {
    installFetch(() => {
      throw new Error("connection refused");
    });

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/vpn" });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("upstream_error");
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

    const app = await buildAuthedServer(appConfig);
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

    const app = await buildAuthedServer(appConfig);
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

    const app = await buildAuthedServer(appConfig);
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

    const app = await buildAuthedServer(appConfig);
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

    const app = await buildAuthedServer(makeConfig());
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
      if (url.endsWith("/Users/test-user/Views")) {
        return jsonResponse({
          Items: [
            { Id: "movies-view", Name: "Movies", CollectionType: "movies" },
            { Id: "shows-view", Name: "Shows", CollectionType: "tvshows" },
          ],
        });
      }
      if (url.includes("/Users/test-user/Items?")) {
        expect(url).toMatch(/[?&]ParentId=(movies-view|shows-view)(&|$)/);
        return jsonResponse({
          Items: [
            {
              Id: "movie-1",
              Name: "Example Movie",
              Type: "Movie",
              ProductionYear: 2020,
              ProviderIds: { Tmdb: "12345", Tvdb: "6789", Imdb: "tt12345" },
              ImageTags: { Primary: "poster-tag" },
            },
            { Id: "bad", Name: "Ignored", Type: "Audio" },
          ],
          TotalRecordCount: 2,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library" });
    const body = response.json();

    expect(body.state).toBe("ok");
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: "movie-1",
      name: "Example Movie",
      type: "Movie",
      year: 2020,
      tmdbId: 12345,
      tvdbId: 6789,
      imdbId: "tt12345",
      imageUrl: "/api/library/images/movie-1?tag=poster-tag",
    });
    await app.close();
  });

  it("excludes orphaned Jellyfin records that are no longer in a library view", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "jellyfin-key",
      },
    });
    const requestedUrls: string[] = [];

    installFetch((url) => {
      requestedUrls.push(url);
      if (url.endsWith("/System/Info/Public")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: true });
      }
      if (url.endsWith("/Users/test-user/Views")) {
        return jsonResponse({
          Items: [{ Id: "movies-view", Name: "Movies", CollectionType: "movies" }],
        });
      }
      if (url.includes("/Users/test-user/Items?")) {
        // A phantom record from a removed /data path is not part of this view.
        return jsonResponse({
          Items: [{ Id: "real-movie", Name: "Real Movie", Type: "Movie" }],
        });
      }
      if (url.includes("/Items?Recursive=true")) {
        return jsonResponse({
          Items: [
            { Id: "real-movie", Name: "Real Movie", Type: "Movie" },
            { Id: "phantom", Name: "Downloading Episode", Type: "Movie" },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library" });
    const body = response.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["real-movie"]);
    expect(
      requestedUrls
        .filter((url) => url.includes("/Items?"))
        .every((url) => url.includes("ParentId=")),
    ).toBe(true);
    await app.close();
  });

  it("expires the session when Jellyfin rejects the user token", async () => {
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

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_expired");
    const next = await app.inject({ method: "GET", url: "/api/status" });
    expect(next.statusCode).toBe(401);
    expect(next.json().error.code).toBe("unauthenticated");
    await app.close();
  });
});

describe("requested library", () => {
  it("returns titles tracked by Sonarr and Radarr without requiring Jellyfin", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([
          {
            id: 42,
            title: "Example Show",
            year: 2024,
            tvdbId: 1234,
            tmdbId: 4321,
            network: "Example TV",
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              percentOfEpisodes: 100,
            },
            images: [
              {
                coverType: "poster",
                remoteUrl: "https://image.tmdb.org/t/p/original/show.jpg",
              },
            ],
          },
        ]);
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([
          {
            id: 7,
            title: "Example Movie",
            year: 2020,
            tmdbId: 5678,
            hasFile: true,
            images: [
              {
                coverType: "poster",
                remoteUrl: "https://image.tmdb.org/t/p/original/movie.jpg",
              },
            ],
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.total).toBe(2);
    expect(body.services).toEqual([
      { id: "sonarr", state: "ok", count: 1 },
      { id: "radarr", state: "ok", count: 1 },
    ]);
    expect(body.items[0]).toMatchObject({
      key: "series:1234",
      service: "sonarr",
      kind: "series",
      arrId: 42,
      title: "Example Show",
      year: 2024,
      tvdbId: 1234,
      tmdbId: 4321,
      available: true,
      imageUrl:
        "/api/search/images/sonarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fshow.jpg",
    });
    expect(body.items[1]).toMatchObject({
      key: "movie:5678",
      service: "radarr",
      kind: "movie",
      arrId: 7,
      title: "Example Movie",
      year: 2020,
      tmdbId: 5678,
      available: true,
      imageUrl:
        "/api/search/images/radarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fmovie.jpg",
    });
    await app.close();
  });

  it("keeps the reachable arr when the other one is unavailable", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test")) {
        return jsonResponse({}, 401);
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([
          { id: 7, title: "Example Movie", year: 2020, tmdbId: 5678, hasFile: true },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[0]).toMatchObject({ id: "sonarr", state: "unauthorized" });
    expect(body.services[1]).toMatchObject({ id: "radarr", state: "ok", count: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ key: "movie:5678", service: "radarr" });
    await app.close();
  });

  it("prefetches release options for requested titles in the background", async () => {
    const searched: string[] = [];
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([
          {
            id: 43,
            title: "Needed Show",
            seasons: [
              { seasonNumber: 0, monitored: false },
              { seasonNumber: 1, monitored: false },
              { seasonNumber: 2, monitored: false },
            ],
            statistics: { episodeFileCount: 0, totalEpisodeCount: 2 },
          },
        ]);
      }
      if (
        url.includes("sonarr.test") &&
        url.includes("/api/v3/release?seriesId=43&seasonNumber=")
      ) {
        const season = new URL(url).searchParams.get("seasonNumber");
        searched.push(`season-${season}`);
        return jsonResponse([]);
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([{ id: 8, title: "Needed Movie", tmdbId: 5678 }]);
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/release?movieId=8")) {
        searched.push("movie");
        return jsonResponse([]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    expect(response.statusCode).toBe(200);

    for (
      let attempt = 0;
      attempt < 100 &&
      !["movie", "season-1", "season-2"].every((item) => searched.includes(item));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(searched.sort()).toEqual(["movie", "season-1", "season-2"]);
    await app.close();
  });
});

describe("cancel requested title", () => {
  it("removes matching queue records, deletes the movie, and refreshes Jellyfin", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("radarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({
          records: [
            {
              id: 11,
              movieId: 7,
              title: "Kung Fu Panda 2",
              status: "downloading",
              trackedDownloadState: "downloading",
            },
            { id: 12, movieId: 8, title: "Other movie" },
          ],
        });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue/11")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 200 });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/movie/7")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 200 });
      }
      if (url.includes("jellyfin.test") && url.includes("/Library/Refresh")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(
      makeConfig({
        jellyfin: {
          id: "jellyfin",
          name: "Jellyfin",
          url: "http://jellyfin.test:8096",
          apiKey: "jellyfin-key",
        },
      }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/radarr/7",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "cancelled",
      service: "radarr",
      kind: "movie",
      id: 7,
      queueRemoved: 1,
    });
    const queueDelete = calls.find((call) => call.url.includes("/api/v3/queue/11"));
    expect(queueDelete?.method).toBe("DELETE");
    expect(queueDelete?.url).toContain("removeFromClient=true");
    expect(queueDelete?.url).toContain("skipRedownload=true");
    expect(calls.some((call) => call.url.includes("/api/v3/queue/12"))).toBe(false);
    const movieDelete = calls.find((call) => call.url.includes("/api/v3/movie/7"));
    expect(movieDelete?.method).toBe("DELETE");
    expect(movieDelete?.url).toContain("deleteFiles=true");
    expect(
      calls.some(
        (call) => call.url.includes("/Library/Refresh") && call.method === "POST",
      ),
    ).toBe(true);
    await app.close();
  });

  it("deletes a series and tolerates queue records already removed", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({
          records: [
            { id: 21, seriesId: 42, title: "Example Show S01E01" },
            { id: 22, seriesId: 42, title: "Example Show S01E02" },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue/21")) {
        return new Response(null, { status: 200 });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue/22")) {
        return jsonResponse({ message: "Not found" }, 404);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/series/42")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/sonarr/42",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      service: "sonarr",
      kind: "series",
      id: 42,
      queueRemoved: 2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("deleteFiles=true");
    await app.close();
  });

  it("removes cached release files when a series is deleted", async () => {
    const config = makeConfig();
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        return jsonResponse([
          {
            guid: "cache-me",
            indexerId: 1,
            indexer: "EZTV",
            title: "Example.Show.S01.1080p",
            size: 2_000,
            quality: { quality: { id: 7, name: "WEBDL-1080p" } },
            seasonNumber: 1,
            approved: true,
            rejected: false,
            downloadAllowed: true,
            rejections: [],
            protocol: "torrent",
            seeders: 80,
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/series/42")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    await waitForCachedReleases(app, "/api/library/shows/sonarr/42/releases?season=1");
    const cacheFile = path.join(config.serverDir, "cache", "releases", "series-42", "s1.json");
    expect(existsSync(cacheFile)).toBe(true);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/sonarr/42",
    });
    expect(response.statusCode).toBe(200);
    expect(existsSync(cacheFile)).toBe(false);
    await app.close();
  });

  it("rejects unknown services and invalid ids", async () => {
    const app = await buildAuthedServer(makeConfig());
    const badService = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/foo/1",
    });
    expect(badService.statusCode).toBe(400);
    expect(badService.json().error.code).toBe("invalid_service");

    const badId = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/radarr/not-a-number",
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe("invalid_id");
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

    const app = await buildAuthedServer(config);
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
    const app = await buildAuthedServer(makeConfig());
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

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/library/images/movie-1" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("service links and unknown routes", () => {
  it("redirects known services and rejects unknown ids", async () => {
    const app = await buildAuthedServer(makeConfig());
    const known = await app.inject({ method: "GET", url: "/api/services/sonarr/open" });
    expect(known.statusCode).toBe(302);
    expect(known.headers.location).toBe("http://sonarr.test:8989");

    const unknown = await app.inject({ method: "GET", url: "/api/services/nope/open" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("unknown_service");
    await app.close();
  });

  it("returns a JSON envelope for unknown API routes", async () => {
    const app = await buildAuthedServer(makeConfig());
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
  images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.jpg" }],
};

const movieLookup = {
  title: "Dune",
  year: 2021,
  tmdbId: 438631,
  imdbId: "tt1160419",
  ratings: { imdb: { value: 8 } },
  images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/def-poster.jpg" }],
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

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/requests/options" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body.services.sonarr).toMatchObject({
      state: "ok",
      defaults: {
        qualityProfileId: 6,
        rootFolderPath: "/data/media/tv",
      },
    });
    expect(body.services.radarr.defaults.monitor).toBeUndefined();
    expect(body.services.radarr.rootFolders).toEqual([
      { path: "/data/media/tv", accessible: true, freeSpace: 123 },
      { path: "/data/media/movies", accessible: true, freeSpace: undefined },
    ]);
    await app.close();
  });

  it("waits past the quick status timeout for slow Sonarr options", async () => {
    installFetch(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/requests/options" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services.sonarr.state).toBe("ok");
    expect(body.services.radarr.state).toBe("ok");
    await app.close();
  });

  it("degrades cleanly when one app has no API key", async () => {
    installFetch((url) => {
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildAuthedServer(
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

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=dune" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.query).toBe("dune");
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      key: "series:371980",
      inLibrary: true,
      available: false,
    });
    expect(body.results[1]).toMatchObject({
      key: "movie:438631",
      inLibrary: false,
      available: false,
      imageUrl: "/api/search/images/radarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fdef-poster.jpg",
    });
    expect(body.services).toEqual([
      { id: "sonarr", state: "ok", count: 1, detail: undefined },
      { id: "radarr", state: "ok", count: 1, detail: undefined },
    ]);
    await app.close();
  });

  it("marks downloaded arr titles as available", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test")) {
        if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
        if (url.endsWith("/api/v3/series")) {
          return jsonResponse([
            {
              tvdbId: 371980,
              statistics: {
                episodeFileCount: 9,
                totalEpisodeCount: 9,
                percentOfEpisodes: 100,
              },
            },
          ]);
        }
      }
      if (url.includes("radarr.test")) {
        if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
        if (url.endsWith("/api/v3/movie")) {
          return jsonResponse([{ tmdbId: 438631, hasFile: true }]);
        }
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=dune" });
    const body = response.json();

    expect(body.results[0]).toMatchObject({
      key: "series:371980",
      inLibrary: true,
      available: true,
    });
    expect(body.results[1]).toMatchObject({
      key: "movie:438631",
      inLibrary: true,
      available: true,
    });
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

    const app = await buildAuthedServer(makeConfig());
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

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=severance" });
    const body = response.json();

    expect(body.results[0].inLibrary).toBeNull();
    expect(body.services[0].state).toBe("ok");
    expect(body.services[0].detail).toContain("Could not check");
    await app.close();
  });

  it("waits past the quick status timeout for a slow Sonarr lookup", async () => {
    installFetch(async (url) => {
      if (url.includes("sonarr.test")) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
        if (url.endsWith("/api/v3/series")) return jsonResponse([]);
      }
      if (url.includes("radarr.test")) {
        if (url.includes("/movie/lookup")) return jsonResponse([]);
        if (url.endsWith("/api/v3/movie")) return jsonResponse([]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/search?q=severance" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[0]).toMatchObject({ id: "sonarr", state: "ok", count: 1 });
    expect(body.results).toHaveLength(1);
    await app.close();
  });

  it("validates the query", async () => {
    const app = await buildAuthedServer(makeConfig());
    expect((await app.inject({ method: "GET", url: "/api/search?q=a" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/search" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/search?q=${"x".repeat(121)}` })).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe("search images", () => {
  it("proxies an allowlisted artwork URL", async () => {
    const mock = installFetch((url) => {
      expect(url).toBe("https://image.tmdb.org/t/p/original/abc-poster.jpg");
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc-poster.jpg",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toContain("max-age=86400");
    expect(response.rawPayload).toEqual(Buffer.from([9, 8, 7]));
    expect(mock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects unknown services and non-allowlisted URLs", async () => {
    const app = await buildAuthedServer(makeConfig());
    const unknown = await app.inject({
      method: "GET",
      url: "/api/search/images/jellyfin?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc-poster.jpg",
    });
    expect(unknown.statusCode).toBe(404);

    for (const url of [
      "https://evil.test/poster.jpg",
      "http://image.tmdb.org/t/p/original/poster.jpg",
      "https://127.0.0.1/poster.jpg",
      "/MediaCoverProxy/abc/poster.jpg",
    ]) {
      const bad = await app.inject({
        method: "GET",
        url: `/api/search/images/sonarr?url=${encodeURIComponent(url)}`,
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe("invalid_url");
    }
    await app.close();
  });

  it("returns 404 for a missing image", async () => {
    installFetch(() => new Response(null, { status: 404 }));
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/search/images/sonarr?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc-poster.jpg",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("create requests", () => {
  it("adds a movie unmonitored and warms the release cache without searching", async () => {
    let posted: Record<string, unknown> | undefined;
    let command: Record<string, unknown> | undefined;
    let grabbed: Record<string, unknown> | undefined;
    let releaseSearches = 0;
    installFetch((url, init) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...movieLookup, id: 7 });
        }
        return jsonResponse([]);
      }
      if (url.includes("/api/v3/release?movieId=7")) {
        releaseSearches += 1;
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/release") && init?.method === "POST") {
        grabbed = readBody(init);
        return jsonResponse({ id: 1 });
      }
      if (url.endsWith("/api/v3/command") && init?.method === "POST") {
        command = readBody(init);
        return jsonResponse({ id: 1 });
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "added",
      service: "radarr",
      title: "Dune",
      id: 7,
      searching: true,
    });
    expect(body).not.toHaveProperty("downloads");
    expect(posted).toMatchObject({
      title: "Dune",
      tmdbId: 438631,
      qualityProfileId: 6,
      rootFolderPath: "/data/media/tv",
      monitored: false,
      minimumAvailability: "released",
      addOptions: { searchForMovie: false },
    });
    expect(posted).not.toHaveProperty("id");
    expect(command).toBeUndefined();
    expect(grabbed).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releaseSearches).toBeGreaterThan(0);
    expect(command).toBeUndefined();
    expect(grabbed).toBeUndefined();
    await app.close();
  });

  it("does not run a second indexer search when grabbing a cached movie release", async () => {
    const movieRelease = {
      guid: "dune-1080",
      indexerId: 2,
      indexer: "YTS",
      title: "Dune.2021.1080p.BluRay.x264",
      size: 2_000_000_000,
      quality: { quality: { id: 7, name: "Bluray-1080p" } },
      approved: false,
      rejected: true,
      downloadAllowed: false,
      rejections: ["Quality Bluray-1080p is not wanted in profile"],
      protocol: "torrent",
      seeders: 84,
    };
    let releaseSearches = 0;
    let updated: Record<string, unknown> | undefined;
    let grabbed: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          return jsonResponse({ ...movieLookup, id: 7 });
        }
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/movie/7") && (!init?.method || init.method === "GET")) {
        return jsonResponse({ ...movieLookup, id: 7, monitored: false });
      }
      if (url.endsWith("/api/v3/movie/7") && init?.method === "PUT") {
        updated = readBody(init);
        return jsonResponse(updated);
      }
      if (url.includes("/api/v3/release?movieId=7")) {
        releaseSearches += 1;
        return jsonResponse([movieRelease]);
      }
      if (url.endsWith("/api/v3/release") && init?.method === "POST") {
        grabbed = readBody(init);
        return jsonResponse({ id: 1 });
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    const list = await waitForCachedReleases(app, "/api/library/movies/7/releases");
    const release = flattenCachedReleases(list)[0] as { id: string; title: string };
    expect(release.title).toBe("Dune.2021.1080p.BluRay.x264");
    const searchesBeforeGrab = releaseSearches;

    const response = await app.inject({
      method: "POST",
      url: "/api/library/movies/7/releases/grab",
      payload: { releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "grabbed", title: release.title });
    expect(releaseSearches).toBe(searchesBeforeGrab);
    expect(updated).toMatchObject({ id: 7, monitored: true });
    expect(grabbed).toMatchObject({
      guid: "dune-1080",
      indexerId: 2,
      movieId: 7,
      shouldOverride: true,
      quality: { quality: { id: 7, name: "Bluray-1080p" } },
    });
    await app.close();
  });

  it("adds a series unmonitored and warms every regular season in order", async () => {
    let posted: Record<string, unknown> | undefined;
    let grabbed: Record<string, unknown> | undefined;
    const searched: number[] = [];
    installFetch((url, init) => {
      if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
      if (url.endsWith("/api/v3/series")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...seriesLookup, id: 11 });
        }
        return jsonResponse([]);
      }
      if (url.includes("/api/v3/release?seriesId=11&seasonNumber=")) {
        const season = Number(new URL(url).searchParams.get("seasonNumber"));
        searched.push(season);
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/release") && init?.method === "POST") {
        grabbed = readBody(init);
        return jsonResponse({ id: 1 });
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        kind: "series",
        tvdbId: 371980,
        options: {
          qualityProfileId: 4,
          rootFolderPath: "/data/media/tv",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "added",
      service: "sonarr",
      searching: true,
    });
    expect(posted).toMatchObject({
      qualityProfileId: 4,
      rootFolderPath: "/data/media/tv",
      monitored: false,
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: false },
      ],
      addOptions: { monitor: "none", searchForMissingEpisodes: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(searched).toEqual([1]);
    expect(grabbed).toBeUndefined();
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

    const app = await buildAuthedServer(makeConfig());
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

    const app = await buildAuthedServer(makeConfig());
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

    const app = await buildAuthedServer(makeConfig());
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


describe("activity", () => {
  it("aggregates active Sonarr and Radarr downloads", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 101,
              title: "Example.Show.S01.1080p",
              status: "downloading",
              trackedDownloadStatus: "ok",
              trackedDownloadState: "downloading",
              size: 1000,
              sizeleft: 250,
              seriesId: 42,
              seasonNumber: 1,
              downloadClient: "qBittorrent",
              protocol: "torrent",
              quality: { quality: { name: "HD-1080p" } },
            },
            {
              id: 102,
              status: "completed",
              trackedDownloadState: "imported",
              seriesId: 42,
            },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse({
          id: 42,
          title: "Example Show",
          year: 2024,
          tvdbId: 1234,
          network: "Example TV",
          images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.jpg" }],
        });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 201,
              title: "Example.Movie.2022.1080p",
              status: "queued",
              trackedDownloadState: "downloading",
              size: 0,
              sizeleft: 0,
              movieId: 7,
              downloadClient: "SABnzbd",
              protocol: "usenet",
            },
          ],
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({
          id: 7,
          title: "Example Movie",
          year: 2022,
          tmdbId: 9876,
          images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/def-poster.jpg" }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services).toMatchObject([
      { id: "sonarr", state: "ok", count: 1 },
      { id: "radarr", state: "ok", count: 1 },
    ]);
    expect(body.total).toBe(2);
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "series:1234",
          service: "sonarr",
          kind: "series",
          title: "Example Show",
          progress: 75,
          queueCount: 1,
          seasons: [1],
        }),
        expect.objectContaining({
          key: "movie:9876",
          service: "radarr",
          kind: "movie",
          title: "Example Movie",
          status: "queued",
          progress: 0,
        }),
      ]),
    );
    await app.close();
  });

  it("keeps the other service when one queue is unreachable", async () => {
    installFetch((url) => {
      if (url.includes("radarr.test")) {
        throw new Error("connection refused");
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({ records: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[0]).toMatchObject({ id: "sonarr", state: "ok", count: 0 });
    expect(body.services[1]).toMatchObject({ id: "radarr", state: "unreachable" });
    expect(body.items).toEqual([]);
    await app.close();
  });

  it("reports unconfigured queues without calling upstream", async () => {
    const mock = installFetch(() => {
      throw new Error("fetch should not be called");
    });

    const app = await buildAuthedServer(
      makeConfig({
        sonarr: { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989", apiKey: undefined },
        radarr: { id: "radarr", name: "Radarr", url: "http://radarr.test:7878", apiKey: undefined },
      }),
    );
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[0]).toMatchObject({ id: "sonarr", state: "unconfigured" });
    expect(body.services[1]).toMatchObject({ id: "radarr", state: "unconfigured" });
    expect(mock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("show detail", () => {
  const jellyfinConfig = makeConfig({
    jellyfin: {
      id: "jellyfin",
      name: "Jellyfin",
      url: "http://jellyfin.test:8096",
      apiKey: "jellyfin-key",
    },
  });

  it("unions Jellyfin episodes with Sonarr downloads", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/series-1?")) {
        return jsonResponse({
          Id: "series-1",
          Name: "Example Show",
          Type: "Series",
          ProductionYear: 2024,
          ProviderIds: { Tvdb: "1234" },
          ImageTags: { Primary: "poster-tag" },
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-1/Seasons")) {
        return jsonResponse({
          Items: [{ Id: "season-1", Name: "Season 1", IndexNumber: 1 }],
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-1/Episodes")) {
        return jsonResponse({
          Items: [
            {
              Id: "episode-1",
              Name: "Pilot",
              ParentIndexNumber: 1,
              IndexNumber: 1,
            },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([
          {
            id: 42,
            title: "Example Show",
            year: 2024,
            tvdbId: 1234,
            network: "Example TV",
            images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.jpg" }],
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          {
            id: 501,
            seriesId: 42,
            seasonNumber: 1,
            episodeNumber: 2,
            title: "Second",
            airDateUtc: "2024-01-02T00:00:00Z",
            hasFile: false,
            monitored: true,
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 10,
              status: "downloading",
              trackedDownloadState: "downloading",
              size: 1000,
              sizeleft: 200,
              seriesId: 42,
              episodeId: 501,
              seasonNumber: 1,
              downloadClient: "qBittorrent",
              protocol: "torrent",
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(jellyfinConfig);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/series-1",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      source: "jellyfin",
      state: "ok",
      series: { title: "Example Show", tvdbId: 1234 },
      sonarrId: 42,
      defaultSeason: 1,
    });
    expect(body.episodes).toHaveLength(2);
    expect(body.episodes[0]).toMatchObject({
      key: "s01e01",
      availability: "jellyfin",
      title: "Pilot",
    });
    expect(body.episodes[1]).toMatchObject({
      key: "s01e02",
      availability: "missing",
      download: { status: "downloading", progress: 80 },
    });
    await app.close();
  });

  it("returns 404 for a missing Jellyfin show", async () => {
    installFetch(() => jsonResponse({ error: "not found" }, 400));

    const app = await buildAuthedServer(jellyfinConfig);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/missing-show",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("show_not_found");
    await app.close();
  });

  it("requests a Jellyfin scan when a series has no indexed episodes", async () => {
    const fetchMock = installFetch((url) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/series-empty?")) {
        return jsonResponse({
          Id: "series-empty",
          Name: "Empty Show",
          Type: "Series",
          ProductionYear: 2024,
          ProviderIds: {},
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-empty/Seasons")) {
        return jsonResponse({ Items: [] });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-empty/Episodes")) {
        return jsonResponse({ Items: [] });
      }
      if (url.includes("jellyfin.test") && url.includes("/Library/Refresh")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(jellyfinConfig);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/series-empty",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "jellyfin",
      state: "ok",
      scanning: true,
      seasons: [],
      episodes: [],
    });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/Library/Refresh")),
    ).toBe(true);

    // The page polls while the scan runs; do not start another scan each time.
    await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/series-empty",
    });
    const refreshes = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/Library/Refresh"),
    );
    expect(refreshes).toHaveLength(1);
    await app.close();
  });

  it("shows a qBittorrent download Sonarr never queued", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-key";
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse({
          id: 42,
          title: "Example Show",
          year: 2024,
          tvdbId: 1234,
          images: [],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          {
            id: 501,
            seriesId: 42,
            seasonNumber: 1,
            episodeNumber: 1,
            title: "First",
            airDateUtc: "2024-01-01T00:00:00Z",
            hasFile: false,
          },
          {
            id: 502,
            seriesId: 42,
            seasonNumber: 1,
            episodeNumber: 2,
            title: "Second",
            airDateUtc: "2024-01-02T00:00:00Z",
            hasFile: false,
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({ records: [] });
      }
      if (url.endsWith("/api/v2/torrents/info")) {
        return jsonResponse([
          {
            hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
            name: "Example.Show.S01.1080p.BluRay.x265-KONTRAST",
            progress: 0.42,
            state: "downloading",
            size: 10_000,
            eta: 120,
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.episodes).toHaveLength(2);
    for (const episode of body.episodes) {
      expect(episode.download).toMatchObject({
        status: "downloading",
        progress: 42,
        downloadClient: "qBittorrent",
        protocol: "torrent",
        untracked: true,
        quality: "1080p",
        timeLeft: "00:02:00",
      });
    }
    expect(body.seasons[0]).toMatchObject({ downloadingCount: 2 });
    await app.close();
  });

  it("builds a Sonarr-only show with season-pack downloads", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse({
          id: 42,
          title: "Example Show",
          year: 2024,
          tvdbId: 1234,
          images: [{ coverType: "poster", url: "/MediaCoverProxy/abc/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/abc-poster.jpg" }],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          {
            id: 501,
            seriesId: 42,
            seasonNumber: 1,
            episodeNumber: 1,
            title: "First",
            airDateUtc: "2024-01-01T00:00:00Z",
            hasFile: false,
          },
          {
            id: 502,
            seriesId: 42,
            seasonNumber: 1,
            episodeNumber: 2,
            title: "Second",
            airDateUtc: "2024-01-02T00:00:00Z",
            hasFile: false,
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue")) {
        return jsonResponse({
          records: [
            {
              id: 10,
              status: "queued",
              trackedDownloadState: "downloading",
              size: 1000,
              sizeleft: 500,
              seriesId: 42,
              seasonNumber: 1,
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      source: "sonarr",
      state: "ok",
      series: { title: "Example Show" },
      sonarrId: 42,
      defaultSeason: 1,
    });
    expect(body.episodes).toHaveLength(2);
    expect(body.episodes.every((episode: { download?: { seasonPack?: boolean } }) =>
      episode.download?.seasonPack === true,
    )).toBe(true);
    await app.close();
  });
});

describe("movie detail", () => {
  it("matches a Jellyfin movie to Radarr by TMDB id", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/jellyfin-movie")) {
        return jsonResponse({
          Id: "jellyfin-movie",
          Name: "Dune",
          Type: "Movie",
          ProductionYear: 2021,
          CommunityRating: 8.1,
          ProviderIds: { Tmdb: "438631" },
          ImageTags: { Primary: "tag-1" },
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([{ ...movieLookup, id: 7 }]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(
      makeConfig({
        jellyfin: {
          id: "jellyfin",
          name: "Jellyfin",
          url: "http://jellyfin.test:8096",
          apiKey: "jellyfin-key",
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/library/movies/jellyfin/jellyfin-movie",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      source: "jellyfin",
      state: "ok",
      jellyfinId: "jellyfin-movie",
      radarrId: 7,
      movie: {
        title: "Dune",
        year: 2021,
        tmdbId: 438631,
      },
    });
    expect(body.movie.imageUrl).toContain("/api/library/images/jellyfin-movie");
    await app.close();
  });

  it("surfaces a failed movie search instead of retrying on every poll", async () => {
    let releaseSearches = 0;
    installFetch((url) => {
      if (url.includes("radarr.test") && url.includes("/api/v3/release?movieId=7")) {
        releaseSearches += 1;
        return jsonResponse({ message: "indexer down" }, 500);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const failed = await waitForCachedReleases(app, "/api/library/movies/7/releases");
    expect(failed.state).toBe("error");
    expect(failed.detail).toContain("indexer down");
    expect(releaseSearches).toBe(1);

    await app.inject({ method: "GET", url: "/api/library/movies/7/releases" });
    await app.inject({ method: "GET", url: "/api/library/movies/7/releases" });
    expect(releaseSearches).toBe(1);
    await app.close();
  });

  it("returns a Radarr-backed movie by id", async () => {
    installFetch((url) => {
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      source: "radarr",
      state: "ok",
      radarrId: 7,
      movie: { title: "Dune", year: 2021, tmdbId: 438631 },
    });
    await app.close();
  });
});

describe("show releases", () => {
  const seasonReleases = [
    {
      guid: "magnet:?xt=urn:btih:single",
      indexerId: 1,
      indexer: "EZTV",
      title: "Example.Show.S01E01.1080p",
      size: 2_000_000_000,
      quality: { quality: { id: 3, name: "WEBDL-1080p" } },
      seasonNumber: 1,
      approved: true,
      rejected: false,
      downloadAllowed: true,
      rejections: [],
      mappedEpisodeInfo: [{ id: 501, seasonNumber: 1, episodeNumber: 1 }],
      languages: [{ id: 1, name: "English" }],
      protocol: "torrent",
      seeders: 12,
    },
    {
      guid: "magnet:?xt=urn:btih:pack",
      indexerId: 2,
      indexer: "The Pirate Bay",
      title: "Example.Show.S01-03",
      size: 14_000_000_000,
      quality: { quality: { id: 0, name: "Unknown" } },
      seasonNumber: 1,
      approved: false,
      rejected: true,
      downloadAllowed: true,
      rejections: ["Multi-season releases are not supported", "Unknown is not wanted in profile"],
      mappedEpisodeInfo: [
        { id: 501, seasonNumber: 1, episodeNumber: 1 },
        { id: 502, seasonNumber: 1, episodeNumber: 2 },
      ],
      languages: [{ id: 1, name: "English" }],
      protocol: "torrent",
      seeders: 16,
    },
  ];

  it("lists cached season releases without exposing upstream ids or URLs", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        return jsonResponse(seasonReleases);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const body = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const releases = flattenCachedReleases(body);

    expect(body).toMatchObject({
      kind: "series-season",
      service: "sonarr",
      targetId: 42,
      seasonNumber: 1,
      state: "ready",
    });
    expect(releases).toHaveLength(2);
    expect(body.groups.map((group: { label: string }) => group.label)).toEqual([
      "1080p",
      "Other",
    ]);
    const pack = releases.find(
      (item) => item.title === "Example.Show.S01-03",
    );
    expect(pack).toMatchObject({
      title: "Example.Show.S01-03",
      multiSeason: true,
      seasonLabel: "Seasons 1\u20133",
      canGrab: true,
      recommended: false,
      mappedEpisodeCount: 2,
    });
    const single = releases.find(
      (item) => item.title === "Example.Show.S01E01.1080p",
    );
    expect(single).toMatchObject({
      title: "Example.Show.S01E01.1080p",
      approved: true,
      canGrab: true,
      sizeBytes: 2_000_000_000,
      tier: 2,
      tierLabel: "1080p",
    });
    expect(single?.id).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(body)).not.toContain("magnet:");
    expect(single).not.toHaveProperty("guid");
    expect(single).not.toHaveProperty("indexerId");
    await app.close();
  });

  it("grabs an overridden multi-season pack using mapped episode ids without re-searching", async () => {
    let posted: Record<string, unknown> | undefined;
    let releaseSearches = 0;
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        releaseSearches += 1;
        return jsonResponse(seasonReleases);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/release") && init?.method === "POST") {
        posted = readBody(init);
        return jsonResponse({ ...seasonReleases[1], id: 1 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const list = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const pack = flattenCachedReleases(list).find(
      (item) => item.title === "Example.Show.S01-03",
    ) as { id: string };
    const searchesBeforeGrab = releaseSearches;

    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, releaseId: pack.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "grabbed", title: "Example.Show.S01-03" });
    expect(releaseSearches).toBe(searchesBeforeGrab);
    expect(posted).toMatchObject({
      guid: "magnet:?xt=urn:btih:pack",
      indexerId: 2,
      seriesId: 42,
      shouldOverride: true,
      episodeIds: [501, 502],
      quality: { quality: { id: 0, name: "Unknown" } },
      languages: [{ id: 1, name: "English" }],
    });
    await app.close();
  });

  it("monitors every season before manually grabbing a cached multi-season pack", async () => {
    const pack = {
      ...seasonReleases[1],
      fullSeason: true,
      seasonNumbers: [1],
      title: "Example.Show.S01-03",
    };
    let updated: Record<string, unknown> | undefined;
    let posted: Record<string, unknown> | undefined;
    const calls: string[] = [];
    installFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        return jsonResponse([pack]);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          id: 42,
          title: "Example Show",
          seasons: [
            { seasonNumber: 1, monitored: true },
            { seasonNumber: 2, monitored: false },
            { seasonNumber: 3, monitored: false },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42") && init?.method === "PUT") {
        updated = readBody(init);
        return jsonResponse(updated);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/release") && init?.method === "POST") {
        posted = readBody(init);
        return jsonResponse({ id: 1 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const list = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const release = flattenCachedReleases(list).find(
      (item) => item.title === "Example.Show.S01-03",
    ) as { id: string };
    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(updated).toMatchObject({
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
        { seasonNumber: 3, monitored: true },
      ],
    });
    expect(posted).toMatchObject({ guid: pack.guid, seriesId: 42 });
    const updateIndex = calls.findIndex((call) => call.startsWith("PUT "));
    const grabIndex = calls.findIndex(
      (call) => call.includes("/api/v3/release") && call.startsWith("POST "),
    );
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(grabIndex).toBeGreaterThan(updateIndex);
    await app.close();
  });

  it("searches a single episode by episode id", async () => {
    const requestedUrls: string[] = [];
    installFetch((url) => {
      requestedUrls.push(url);
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          { id: 501, seasonNumber: 1, episodeNumber: 1 },
          { id: 502, seasonNumber: 1, episodeNumber: 2 },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&episodeId=501")) {
        return jsonResponse([
          seasonReleases[0],
          {
            ...seasonReleases[0],
            guid: "magnet:?xt=urn:btih:other",
            title: "Example.Show.S01E02.1080p",
            episodeNumbers: [2],
            mappedEpisodeInfo: [{ id: 502, seasonNumber: 1, episodeNumber: 2 }],
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42/releases?season=1&episode=1",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ seriesId: 42, seasonNumber: 1, episodeNumber: 1 });
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({
      title: "Example.Show.S01E01.1080p",
      episodeLabel: "S01E01",
      canGrab: true,
    });
    expect(requestedUrls.some((url) => url.includes("episodeId=501"))).toBe(true);
    await app.close();
  });

  it("merges packs found under a sibling season into the requested season", async () => {
    const searched: number[] = [];
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        searched.push(1);
        return jsonResponse(seasonReleases);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=2")) {
        searched.push(2);
        return jsonResponse([
          {
            ...seasonReleases[0],
            guid: "magnet:?xt=urn:btih:other-season",
            title: "Example.Show.S02.1080p",
            seasonNumber: 2,
            mappedEpisodeInfo: [{ id: 601, seasonNumber: 2, episodeNumber: 1 }],
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const first = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    expect(first.releaseCount).toBe(2);
    const body = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=2",
    );
    const releases = flattenCachedReleases(body);

    expect(searched.sort()).toEqual([1, 2]);
    expect(releases.map((release) => release.title)).toEqual([
      "Example.Show.S02.1080p",
      "Example.Show.S01-03",
    ]);
    expect(releases[1]).toMatchObject({
      title: "Example.Show.S01-03",
      searchSeasonNumber: 1,
      seasonLabel: "Seasons 1\u20133",
    });
    await app.close();
  });

  it("grabs a single episode release using the episode lookup", async () => {
    const episodeRelease = {
      ...seasonReleases[0],
      approved: false,
      rejected: true,
      downloadAllowed: false,
      rejections: ["Not enough seeders: 0. Minimum seeders: 1"],
    };
    let posted: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/episode?seriesId=42")) {
        return jsonResponse([{ id: 501, seasonNumber: 1, episodeNumber: 1 }]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&episodeId=501")) {
        return jsonResponse([episodeRelease]);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/release") && init?.method === "POST") {
        posted = readBody(init);
        return jsonResponse({ id: 1 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const list = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42/releases?season=1&episode=1",
    });
    const release = list.json().releases[0];
    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, episodeNumber: 1, releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(posted).toMatchObject({
      guid: "magnet:?xt=urn:btih:single",
      indexerId: 1,
      seriesId: 42,
      shouldOverride: true,
      episodeIds: [501],
    });
    await app.close();
  });

  it("returns 404 for a stale release id after searching the cache's fallback", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        return jsonResponse([seasonReleases[0]]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    await waitForCachedReleases(app, "/api/library/shows/sonarr/42/releases?season=1");

    const stale = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, releaseId: "0".repeat(24) },
    });
    expect(stale.statusCode).toBe(404);
    expect(stale.json().error.code).toBe("release_not_found");
    await app.close();
  });

  it("hides a cached release Sonarr cannot map", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/release?seriesId=42&seasonNumber=1")) {
        return jsonResponse([
          {
            ...seasonReleases[1],
            mappedEpisodeInfo: [],
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const body = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );

    expect(body.releaseCount).toBe(0);
    expect(body.groups).toEqual([]);
    await app.close();
  });

  it("removes only the queue record for the requested episode", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          { id: 501, seriesId: 42, seasonNumber: 1, episodeNumber: 1 },
          { id: 502, seriesId: 42, seasonNumber: 1, episodeNumber: 2 },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({
          records: [
            {
              id: 10,
              seriesId: 42,
              episodeId: 501,
              seasonNumber: 1,
              status: "downloading",
              trackedDownloadState: "downloading",
            },
            {
              id: 11,
              seriesId: 42,
              episodeId: 502,
              seasonNumber: 1,
              status: "downloading",
              trackedDownloadState: "downloading",
            },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue/10")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/shows/sonarr/42/episodes/1/1/download",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "cancelled",
      service: "sonarr",
      seriesId: 42,
      seasonNumber: 1,
      episodeNumber: 1,
      queueRemoved: 1,
      seasonPack: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("removeFromClient=true");
    expect(calls[0]?.url).toContain("blocklist=true");
    expect(calls[0]?.url).toContain("skipRedownload=true");
    expect(calls.some((call) => call.url.includes("/api/v3/queue/11"))).toBe(false);
    await app.close();
  });

  it("cancels a season pack that covers the episode", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([{ id: 601, seriesId: 42, seasonNumber: 2, episodeNumber: 1 }]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({
          records: [
            {
              id: 20,
              seriesId: 42,
              seasonNumber: 2,
              title: "Example.Show.S02.1080p",
              status: "downloading",
              trackedDownloadState: "downloading",
            },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue/20")) {
        calls.push({ url, method: init?.method });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/shows/sonarr/42/episodes/2/1/download",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      queueRemoved: 1,
      seasonPack: true,
    });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("returns 404 when the episode has no active download", async () => {
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([{ id: 501, seriesId: 42, seasonNumber: 1, episodeNumber: 1 }]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/shows/sonarr/42/episodes/1/1/download",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("download_not_found");
    await app.close();
  });
});

describe("playback", () => {
  const playbackItem = {
    Id: "item-1",
    Name: "Example Movie",
    Type: "Movie",
    ProductionYear: 2020,
    RunTimeTicks: 7_200_000_000,
    Overview: "A film.",
    ImageTags: { Primary: "tag-1" },
    UserData: { PlaybackPositionTicks: 120_000_000, Played: false },
  };

  const playbackInfo = {
    PlaySessionId: "session-1",
    MediaSources: [{ Id: "source-1", SupportsDirectPlay: true }],
  };

  function installPlaybackFetch(): ReturnType<typeof vi.fn> {
    return installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse(playbackInfo);
      }
      if (/\/Items\/item-1\?/.test(url)) {
        return jsonResponse(playbackItem);
      }
      throw new Error(`unexpected URL ${url}`);
    });
  }

  it("returns playable metadata with a same-origin stream URL", async () => {
    installPlaybackFetch();
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.state).toBe("ok");
    expect(body.item).toMatchObject({
      id: "item-1",
      type: "Movie",
      name: "Example Movie",
      year: 2020,
      runtimeTicks: 7_200_000_000,
      positionTicks: 120_000_000,
      played: false,
      imageUrl: "/api/library/images/item-1?tag=tag-1",
      streamUrl:
        "/api/playback/items/item-1/stream?mediaSourceId=source-1&playSessionId=session-1",
      mediaSourceId: "source-1",
      playSessionId: "session-1",
      directPlay: true,
      playbackMethod: "direct",
    });
    expect(JSON.stringify(body)).not.toContain("test-user-token");
    await app.close();
  });

  it("redirects the media element to Jellyfin without exposing the token in the API body", async () => {
    installFetch(() => {
      throw new Error("the stream route should not call upstream with both ids");
    });
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/stream?mediaSourceId=source-1&playSessionId=session-1",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const location = String(response.headers.location);
    expect(location).toContain(
      "http://jellyfin.test:8096/Videos/item-1/stream?",
    );
    expect(location).toContain("static=true");
    expect(location).toContain("mediaSourceId=source-1");
    expect(location).toContain("playSessionId=session-1");
    expect(location).toContain("api_key=test-user-token");
    await app.close();
  });

  it("uses HLS for sources the browser cannot decode directly", async () => {
    installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse({
          PlaySessionId: "session-1",
          MediaSources: [
            {
              Id: "source-1",
              Container: "mkv",
              Bitrate: 8_785_944,
              SupportsDirectPlay: true,
              MediaStreams: [
                { Type: "Video", Codec: "hevc", Height: 822 },
                { Type: "Audio", Codec: "ac3", Channels: 6 },
              ],
            },
          ],
        });
      }
      if (/\/Items\/item-1\?/.test(url)) {
        return jsonResponse(playbackItem);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const metadata = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });
    expect(metadata.json().item).toMatchObject({
      playbackMethod: "hls",
      directPlay: false,
      streamUrl:
        "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1",
    });

    const manifest = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1",
    });
    expect(manifest.statusCode).toBe(302);
    const location = String(manifest.headers.location);
    expect(location).toContain("http://jellyfin.test:8096/Videos/item-1/master.m3u8?");
    expect(location).toContain("VideoCodec=h264");
    expect(location).toContain("AudioCodec=aac");
    expect(location).toContain("MaxHeight=822");
    expect(location).toContain("MediaSourceId=source-1");
    expect(location).toContain("PlaySessionId=session-1");
    expect(location).toContain("api_key=test-user-token");
    await app.close();
  });

  it("fills missing stream ids from PlaybackInfo", async () => {
    installPlaybackFetch();
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/stream",
    });

    expect(response.statusCode).toBe(302);
    const location = String(response.headers.location);
    expect(location).toContain("mediaSourceId=source-1");
    expect(location).toContain("playSessionId=session-1");
    await app.close();
  });

  it("posts start, progress and stop reports with the session token", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    installFetch((url, init) => {
      if (url.includes("/Sessions/Playing")) {
        expect(init?.headers).toMatchObject({
          "X-Emby-Token": "test-user-token",
          "X-Emby-Device-Id": "churn-web",
        });
        posted.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildAuthedServer(makeConfig());
    const payload = {
      positionTicks: 500,
      mediaSourceId: "source-1",
      playSessionId: "session-1",
      isPaused: false,
    };

    for (const kind of ["start", "progress", "stop"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/playback/items/item-1/${kind}`,
        payload,
      });
      expect(response.statusCode).toBe(204);
    }

    expect(posted.map((entry) => entry.url)).toEqual([
      "http://jellyfin.test:8096/Sessions/Playing",
      "http://jellyfin.test:8096/Sessions/Playing/Progress",
      "http://jellyfin.test:8096/Sessions/Playing/Stopped",
    ]);
    expect(posted[0]?.body).toMatchObject({
      ItemId: "item-1",
      MediaSourceId: "source-1",
      PlaySessionId: "session-1",
      PositionTicks: 500,
      PlayMethod: "DirectPlay",
      CanSeek: true,
    });
    expect(posted[2]?.body).toMatchObject({ Failed: false, PositionTicks: 500 });
    await app.close();
  });

  it("expires the session when Jellyfin rejects playback reporting", async () => {
    installFetch((url) => {
      if (url.includes("/Sessions/Playing")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/playback/items/item-1/start",
      payload: { positionTicks: 0 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_expired");

    const after = await app.inject({ method: "GET", url: "/api/library" });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("unauthenticated");
    await app.close();
  });

  it("maps Jellyfin failures and rejects invalid input", async () => {
    installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        throw new Error("connection refused");
      }
      if (/\/Items\/item-1\?/.test(url)) {
        return jsonResponse(playbackItem);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildAuthedServer(makeConfig());

    const unreachable = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json()).toMatchObject({ state: "unreachable" });

    const invalidId = await app.inject({
      method: "GET",
      url: "/api/playback/items/bad%20id",
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json().error.code).toBe("invalid_item_id");

    const invalidTicks = await app.inject({
      method: "POST",
      url: "/api/playback/items/item-1/progress",
      payload: { positionTicks: -1 },
    });
    expect(invalidTicks.statusCode).toBe(400);
    expect(invalidTicks.json().error.code).toBe("invalid_playback_report");

    const invalidSession = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/stream?playSessionId=bad%20id",
    });
    expect(invalidSession.statusCode).toBe(400);
    expect(invalidSession.json().error.code).toBe("invalid_query");
    await app.close();
  });
});
