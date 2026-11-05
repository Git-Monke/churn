import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    stateDir: path.join(serverDir, ".churn-state"),
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
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
    prowlarr: {
      url: "http://prowlarr.test:9696",
      apiKey: "prowlarr-key",
    },
    introdb: { url: "https://api.introdb.test", timeoutMs: 500 },
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

function arrParseResponse(url: string, title: string): Response {
  const resolution = title.includes("2160p")
    ? 2160
    : title.includes("1080p")
      ? 1080
      : title.includes("720p")
        ? 720
        : title.includes("480p")
          ? 480
          : undefined;
  const quality = resolution ? { quality: { resolution } } : undefined;
  if (url.includes("radarr.test") || title.startsWith("Dune.")) {
    return jsonResponse({
      parsedMovieInfo: {
        movieTitles: ["Dune"],
        primaryMovieTitle: "Dune",
        year: 2021,
        ...(quality ? { quality } : {}),
      },
    });
  }

  const seasonMatch = title.match(/S(\d{1,3})/i);
  const episodes = [...title.matchAll(/E(\d{1,3})/gi)].map((match) =>
    Number.parseInt(match[1] ?? "", 10),
  );
  const multiSeason = /S\d{1,3}\s*-\s*(?:S)?\d{1,3}/i.test(title);
  return jsonResponse({
    parsedEpisodeInfo: {
      seriesTitleInfo: {
        titleWithoutYear: title.startsWith("Other.Show") ? "Other Show" : "Example Show",
      },
      seasonNumber: seasonMatch ? Number.parseInt(seasonMatch[1] ?? "", 10) : undefined,
      episodeNumbers: episodes,
      fullSeason: episodes.length === 0,
      isMultiSeason: multiSeason,
      releaseType: episodes.length === 0 ? "seasonPack" : "singleEpisode",
      ...(quality ? { quality } : {}),
    },
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

  it("reports browser-facing URLs for loopback services", async () => {
    installFetch((url) => {
      if (url.includes("127.0.0.1:8096")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: false });
      }
      return jsonResponse({ appName: "Sonarr", version: "4.0.20" });
    });

    const config = makeConfig({
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://127.0.0.1:8096" },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://127.0.0.1:8989",
        apiKey: "sonarr-key",
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://127.0.0.1:7878",
        apiKey: "radarr-key",
      },
    });
    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "100.90.93.111:4000" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().services.map((service: { url: string }) => service.url)).toEqual([
      "http://100.90.93.111:8096",
      "http://100.90.93.111:8989",
      "http://100.90.93.111:7878",
    ]);
    await app.close();
  });
});

describe("stats", () => {
  it("requires a dashboard session", async () => {
    const app = await buildServer(appConfig);
    const response = await app.inject({ method: "GET", url: "/api/stats" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
    await app.close();
  });

  it("returns all-time transfer totals and disk usage", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v2/sync/maindata")) {
        return jsonResponse({
          server_state: { alltime_dl: 300, alltime_ul: 100, free_space_on_disk: 500 },
        });
      }
      if (url.endsWith("/api/v3/diskspace")) {
        return jsonResponse([{ path: "/data", freeSpace: 600, totalSpace: 2_000 }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ path: "/data/media/tv", accessible: true }]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/stats" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toMatchObject({
      qbittorrent: { totalDownloadedBytes: 300, totalUploadedBytes: 100 },
      disk: { totalBytes: 2_000, freeBytes: 500, usedBytes: 1_500, usedPercent: 75 },
      errors: [],
    });
    await app.close();
  });

  it("keeps the disk section when qBittorrent is unreachable", async () => {
    installFetch((url) => {
      if (url.includes("qbittorrent.test")) {
        throw new Error("connection refused");
      }
      if (url.endsWith("/api/v3/diskspace")) {
        return jsonResponse([{ path: "/data", freeSpace: 600, totalSpace: 2_000 }]);
      }
      if (url.endsWith("/api/v3/rootfolder")) {
        return jsonResponse([{ path: "/data/media/tv", accessible: true }]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/stats" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.disk).toEqual({
      totalBytes: 2_000,
      freeBytes: 600,
      usedBytes: 1_400,
      usedPercent: 70,
    });
    expect(body.qbittorrent).toBeUndefined();
    expect(body.errors).toEqual([
      { source: "qbittorrent", message: "qbittorrent is unreachable" },
    ]);
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

  it("caches title metadata without starting indexer searches", async () => {
    const requestedUrls: string[] = [];
    installFetch((url) => {
      requestedUrls.push(url);
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
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([{ id: 8, title: "Needed Movie", tmdbId: 5678 }]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    expect(response.statusCode).toBe(200);

    expect(requestedUrls.some((url) => url.includes("/api/v3/release"))).toBe(false);
    expect(sentToProwlarr(requestedUrls)).toBe(false);
    await app.close();
  });
});


describe("remove Jellyfin title", () => {
  it("deletes a Jellyfin-only movie and its files", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/jellyfin-movie?")) {
        calls.push({ url, method: init?.method });
        return jsonResponse({
          Id: "jellyfin-movie",
          Name: "Jellyfin Only",
          Type: "Movie",
          ProductionYear: 2024,
          ProviderIds: {},
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        calls.push({ url, method: init?.method });
        return jsonResponse([]);
      }
      if (
        url.includes("jellyfin.test") &&
        url.endsWith("/Items/jellyfin-movie") &&
        init?.method === "DELETE"
      ) {
        calls.push({ url, method: init.method });
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
      url: "/api/library/jellyfin/jellyfin-movie",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "cancelled",
      service: "jellyfin",
      kind: "movie",
      id: "jellyfin-movie",
    });
    const itemLookup = calls.find((call) => call.url.includes("/Items/jellyfin-movie?"));
    expect(itemLookup?.url).toContain("userId=test-user");
    expect(calls.find((call) => call.url.endsWith("/api/v3/movie"))?.method).not.toBe(
      "DELETE",
    );
    expect(
      calls.find((call) => call.url.endsWith("/Items/jellyfin-movie"))?.method,
    ).toBe("DELETE");
    await app.close();
  });


  it("does not delete from Jellyfin when the arr catalog cannot be checked", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/jellyfin-movie?")) {
        return jsonResponse({
          Id: "jellyfin-movie",
          Name: "Jellyfin Only",
          Type: "Movie",
          ProductionYear: 2024,
          ProviderIds: {},
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse({ message: "Radarr unavailable" }, 500);
      }
      if (
        url.includes("jellyfin.test") &&
        url.endsWith("/Items/jellyfin-movie") &&
        init?.method === "DELETE"
      ) {
        calls.push({ url, method: init.method });
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
      url: "/api/library/jellyfin/jellyfin-movie",
    });

    expect(response.statusCode).toBe(502);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("uses the arr delete when a Jellyfin item matches by title and year", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    installFetch((url, init) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/jellyfin-movie?")) {
        return jsonResponse({
          Id: "jellyfin-movie",
          Name: "Example Movie",
          Type: "Movie",
          ProductionYear: 2020,
          ProviderIds: {},
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([
          {
            id: 7,
            title: "Example Movie",
            year: 2020,
            tmdbId: 999,
            hasFile: true,
            sizeOnDisk: 1000,
          },
        ]);
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
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
      url: "/api/library/jellyfin/jellyfin-movie",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      service: "radarr",
      kind: "movie",
      id: 7,
    });
    const movieDelete = calls.find(
      (call) => call.url.includes("/api/v3/movie/7") && call.method === "DELETE",
    );
    expect(movieDelete?.url).toContain("deleteFiles=true");
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/Items/jellyfin-movie") && call.method === "DELETE",
      ),
    ).toBe(false);
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
    const movieDelete = calls.find(
      (call) => call.url.includes("/api/v3/movie/7") && call.method === "DELETE",
    );
    expect(movieDelete?.url).toContain("deleteFiles=true");
    expect(
      calls.some(
        (call) => call.url.includes("/Library/Refresh") && call.method === "POST",
      ),
    ).toBe(true);
    await app.close();
  });

  it("removes the added-by tag when a title is cancelled", async () => {
    const config = makeConfig();
    mkdirSync(config.stateDir, { recursive: true });
    const attributionPath = path.join(config.stateDir, "media-attribution.json");
    writeFileSync(
      attributionPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: "movie:tmdb:438631",
            addedBy: { id: "user-1", name: "Ada" },
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    installFetch((url, init) => {
      if (url.includes("radarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/movie/7")) {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        return jsonResponse({
          id: 7,
          title: "Dune",
          year: 2021,
          tmdbId: 438631,
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Library/Refresh")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/radarr/7",
    });
    expect(response.statusCode).toBe(200);

    const persisted = JSON.parse(readFileSync(attributionPath, "utf8")) as {
      entries: unknown[];
    };
    expect(persisted.entries).toEqual([]);
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
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain("deleteFiles=true");
    await app.close();
  });

  it("removes persisted release-search snapshots when a series is deleted", async () => {
    const config = makeConfig();
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42") && init?.method !== "PUT" && init?.method !== "DELETE") {
        return jsonResponse({
          id: 42,
          title: "Example Show",
          seasons: [{ seasonNumber: 1, monitored: false }],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV (Prowlarr)" }]);
      }
      if (url.includes("prowlarr.test") && url.endsWith("/api/v1/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v3/parse")) {
        return arrParseResponse(url, new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("prowlarr.test") && url.includes("/api/v1/search")) {
        return jsonResponse([
          {
            guid: "cache-me",
            title: "Example.Show.S01.1080p",
            size: 2_000,
            indexerId: 1,
            indexer: "EZTV",
            protocol: "torrent",
            seeders: 80,
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/series/42?") && init?.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    await waitForCachedReleases(app, "/api/library/shows/sonarr/42/releases?season=1");
    const cacheFile = path.join(
      config.serverDir,
      "cache",
      "releases",
      "prowlarr",
      "series-42",
      "s1.json",
    );
    expect(existsSync(cacheFile)).toBe(true);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/sonarr/42",
    });
    expect(response.statusCode).toBe(200);
    expect(existsSync(cacheFile)).toBe(false);
    await app.close();
  });

  it("removes matching qBittorrent torrents after deleting a title", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/series/42")) {
        if (init?.method === "DELETE") {
          calls.push({ url, method: init.method });
          return new Response(null, { status: 200 });
        }
        return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "show-hash",
            name: "Example.Show.S01.1080p",
            category: "tv",
            progress: 1,
            size: 1000,
            state: "stalledUP",
          },
          {
            hash: "unrelated-hash",
            name: "Other.Show.S01.1080p",
            category: "tv",
            progress: 1,
            size: 1000,
            state: "stalledUP",
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/delete") {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/requested/sonarr/42",
    });

    expect(response.statusCode).toBe(200);
    expect(calls.find((call) => call.url.includes("/api/v3/series/42"))?.method).toBe(
      "DELETE",
    );
    const qbittorrentDelete = calls.find((call) =>
      call.url.endsWith("/api/v2/torrents/delete"),
    );
    expect(qbittorrentDelete?.body).toContain("hashes=show-hash");
    expect(qbittorrentDelete?.body).toContain("deleteFiles=true");
    expect(qbittorrentDelete?.body).not.toContain("unrelated-hash");
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

  it("redirects loopback services to the host the browser used", async () => {
    const app = await buildAuthedServer(
      makeConfig({
        jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://127.0.0.1:8096" },
        sonarr: {
          id: "sonarr",
          name: "Sonarr",
          url: "http://127.0.0.1:8989",
          apiKey: "sonarr-key",
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/services/sonarr/open",
      headers: { host: "100.90.93.111:4000" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://100.90.93.111:8989");
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
  path: "/data/media/movies/Dune (2021)",
  tmdbId: 438631,
  imdbId: "tt1160419",
  ratings: { imdb: { value: 8 } },
  images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/def-poster.jpg" }],
};

function readBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function sentToProwlarr(urls: string[]): boolean {
  return urls.some((url) => url.includes("prowlarr.test"));
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
      if (url.includes("jellyfin.test") && url.includes("/Users/test-user/Views")) {
        return jsonResponse({ Items: [] });
      }
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

  it("marks Jellyfin titles as available without using arr file state", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test") && url.includes("/Users/test-user/Views")) {
        return jsonResponse({ Items: [{ Id: "tv" }, { Id: "movies" }] });
      }
      if (url.includes("jellyfin.test") && url.includes("/Users/test-user/Items?")) {
        if (url.includes("ParentId=tv")) {
          return jsonResponse({
            Items: [
              {
                Id: "jf-series",
                Name: "Severance",
                Type: "Series",
                ProviderIds: { Tvdb: "371980" },
              },
            ],
          });
        }
        return jsonResponse({
          Items: [
            {
              Id: "jf-movie",
              Name: "Dune",
              Type: "Movie",
              ProviderIds: { Tmdb: "438631" },
            },
          ],
        });
      }
      if (url.includes("sonarr.test")) {
        if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
        if (url.endsWith("/api/v3/series")) {
          return jsonResponse([
            {
              tvdbId: 371980,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 9,
                percentOfEpisodes: 0,
              },
            },
          ]);
        }
      }
      if (url.includes("radarr.test")) {
        if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
        if (url.endsWith("/api/v3/movie")) {
          return jsonResponse([{ tmdbId: 438631, hasFile: false }]);
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
  it("adds a movie unmonitored, caches metadata and starts a background search", async () => {
    let posted: Record<string, unknown> | undefined;
    let command: Record<string, unknown> | undefined;
    let grabbed: Record<string, unknown> | undefined;
    const requestedUrls: string[] = [];
    installFetch((url, init) => {
      requestedUrls.push(url);
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...movieLookup, id: 7 });
        }
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
    expect(requestedUrls.some((url) => url.includes("/api/v3/release"))).toBe(false);
    await app.close();
  });

  it("records the signed-in user as the title's adder", async () => {
    let added = false;
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([]);
      }
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") {
          added = true;
          return jsonResponse({ ...movieLookup, id: 7 });
        }
        return jsonResponse(added ? [{ ...movieLookup, id: 7 }] : []);
      }
      if (url.endsWith("/api/v3/release") && init?.method === "POST") {
        return jsonResponse({ id: 1 });
      }
      if (url.endsWith("/api/v3/command") && init?.method === "POST") {
        return jsonResponse({ id: 1 });
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    const addedResponse = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    expect(addedResponse.statusCode).toBe(200);

    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    const body = response.json();
    expect(body.items[0]).toMatchObject({
      key: "movie:438631",
      addedBy: { id: "test-user", name: "tester" },
    });
    await app.close();
  });

  it("does not claim an existing title that was already in the library", async () => {
    const config = makeConfig();
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(
      path.join(config.stateDir, "media-attribution.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: "movie:tmdb:438631",
            addedBy: { id: "original-user", name: "Original" },
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([]);
      }
      if (url.includes("/movie/lookup")) return jsonResponse([movieLookup]);
      if (url.endsWith("/api/v3/movie")) {
        if (init?.method === "POST") throw new Error("must not add a duplicate");
        return jsonResponse([{ ...movieLookup, id: 9 }]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const added = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    expect(added.json()).toMatchObject({ status: "already_exists" });

    const response = await app.inject({ method: "GET", url: "/api/library/requested" });
    expect(response.json().items[0]).toMatchObject({
      key: "movie:438631",
      addedBy: { id: "original-user", name: "Original" },
    });
    await app.close();
  });

  it("sends the selected Prowlarr movie torrent straight to qBittorrent", async () => {
    let qbittorrentAdd: URLSearchParams | undefined;
    const radarrReleaseSearches: string[] = [];
    let radarrGrab: Record<string, unknown> | undefined;
    let radarrUpdate: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/add") {
        qbittorrentAdd = new URLSearchParams(String(init?.body));
        return new Response("Ok.", { status: 200 });
      }
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
        radarrUpdate = readBody(init);
        return jsonResponse(radarrUpdate);
      }
      if (url.includes("/api/v3/release?movieId=7")) {
        radarrReleaseSearches.push(url);
        return jsonResponse([]);
      }
      if (url.endsWith("/api/v3/release") && init?.method === "POST") {
        radarrGrab = readBody(init);
        return jsonResponse({ id: 1 });
      }
      if (url.endsWith("/api/v1/indexer")) {
        return jsonResponse([{ id: 2, name: "YTS", enable: true }]);
      }
      if (url.includes("/api/v3/parse")) {
        return arrParseResponse(url, new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("/api/v1/search")) {
        return jsonResponse([
          {
            guid: "dune-1080",
            title: "Dune.2021.1080p.BluRay.x264",
            size: 2_000_000_000,
            seeders: 84,
            leechers: 2,
            indexerId: 2,
            indexer: "YTS",
            protocol: "torrent",
            infoHash: "dune-info-hash",
            downloadUrl: "https://prowlarr.test/2/download?link=dune",
          },
        ]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      throw new Error(`unexpected URL ${url}`);
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { kind: "movie", tmdbId: 438631 },
    });
    const list = await waitForCachedReleases(app, "/api/library/movies/7/releases");
    const release = flattenCachedReleases(list)[0] as { id: string; title: string };
    expect(release.title).toBe("Dune.2021.1080p.BluRay.x264");
    expect(list.progress).toMatchObject({ finished: 1, total: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/movies/7/releases/grab",
      payload: { releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "grabbed", title: release.title });
    expect(qbittorrentAdd?.get("urls")).toBe(
      "https://prowlarr.test/2/download?link=dune",
    );
    expect(qbittorrentAdd?.get("savepath")).toBe("/data/media/movies/Dune (2021)");
    expect(qbittorrentAdd?.get("category")).toBe("movies");
    expect(qbittorrentAdd?.get("tags")).toBe("churn-direct,churn-movie-7");
    expect(qbittorrentAdd?.get("contentLayout")).toBe("NoSubfolder");
    expect(radarrReleaseSearches).toHaveLength(0);
    expect(radarrGrab).toBeUndefined();
    expect(radarrUpdate).toBeUndefined();
    await app.close();
  });

  it("adds a series unmonitored, caches metadata and starts a background search", async () => {
    let posted: Record<string, unknown> | undefined;
    let grabbed: Record<string, unknown> | undefined;
    const requestedUrls: string[] = [];
    installFetch((url, init) => {
      requestedUrls.push(url);
      if (url.includes("/series/lookup")) return jsonResponse([seriesLookup]);
      if (url.endsWith("/api/v3/series")) {
        if (init?.method === "POST") {
          posted = readBody(init);
          return jsonResponse({ ...seriesLookup, id: 11 });
        }
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
    expect(grabbed).toBeUndefined();
    expect(requestedUrls.some((url) => url.includes("/api/v3/release"))).toBe(false);
    await app.close();
  });

  it("prefetches every regular season after a series is added", async () => {
    const searches: string[] = [];
    const multiSeasonLookup = {
      ...seriesLookup,
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: false },
        { seasonNumber: 2, monitored: false },
        { seasonNumber: 3, monitored: false },
      ],
    };
    installFetch((url, init) => {
      if (url.includes("/series/lookup")) return jsonResponse([multiSeasonLookup]);
      if (url.endsWith("/api/v3/series")) {
        if (init?.method === "POST") {
          // Sonarr can return the added series without its seasons; the lookup
          // entry still has them, and every season must be warmed.
          return jsonResponse({ ...multiSeasonLookup, id: 12, seasons: [] });
        }
        return jsonResponse([]);
      }
      if (url.includes("/qualityprofile")) return jsonResponse(profiles);
      if (url.includes("/rootfolder")) return jsonResponse(rootFolders);
      if (url.endsWith("/api/v1/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v1/search")) {
        searches.push(new URL(url).searchParams.get("query") ?? "");
        return jsonResponse([]);
      }
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

    for (let attempt = 0;
      attempt < 100 && new Set(searches).size < 3;
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Other tests can leave a background warm running; only assert that every
    // regular season was requested, not that no duplicate request occurred.
    expect([...new Set(searches)]).toEqual([
      "Severance S01",
      "Severance S02",
      "Severance S03",
    ]);
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
  it("aggregates active qBittorrent downloads using the local catalog", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    installFetch((url, init) => {
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
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([
          {
            id: 7,
            title: "Example Movie",
            year: 2022,
            tmdbId: 9876,
            images: [{ coverType: "poster", url: "/MediaCoverProxy/def/poster.jpg", remoteUrl: "https://image.tmdb.org/t/p/original/def-poster.jpg" }],
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        expect(init?.headers).toMatchObject({ authorization: "Bearer qbt-test-key" });
        return jsonResponse([
          {
            hash: "show-hash",
            name: "Example.Show.S01.1080p",
            category: "tv",
            progress: 0.75,
            size: 1000,
            amount_left: 250,
            dlspeed: 100,
            eta: 60,
            state: "downloading",
          },
          {
            hash: "movie-hash",
            name: "Example.Movie.2022.1080p",
            category: "movies",
            progress: 0.1,
            size: 2000,
            amount_left: 1800,
            state: "queuedDL",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services).toMatchObject([
      { id: "qbittorrent", state: "ok", count: 2 },
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
          downloadClients: ["qBittorrent"],
          protocols: ["torrent"],
        }),
        expect.objectContaining({
          key: "movie:9876",
          service: "radarr",
          kind: "movie",
          title: "Example Movie",
          status: "queued",
          progress: 10,
        }),
      ]),
    );
    await app.close();
  });

  it("reports qBittorrent failures without hiding the response", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([]);
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([]);
      }
      if (url.includes("qbittorrent.test")) {
        throw new Error("connection refused");
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.services[0]).toMatchObject({
      id: "qbittorrent",
      state: "unreachable",
    });
    expect(body.items).toEqual([]);
    await app.close();
  });

  it("reports an unconfigured download client without calling upstream", async () => {
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
    expect(body.services[0]).toMatchObject({
      id: "qbittorrent",
      state: "unconfigured",
    });
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
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "episode-hash",
            name: "Example.Show.S01E02.1080p",
            category: "tv",
            progress: 0.8,
            size: 1000,
            amount_left: 200,
            dlspeed: 100,
            eta: 30,
            state: "downloading",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const config = jellyfinConfig;
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
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

  it("hides finished direct downloads from live downloads once Jellyfin has the episodes", async () => {
    installFetch((url) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/series-1?")) {
        return jsonResponse({
          Id: "series-1",
          Name: "Parks and Recreation",
          Type: "Series",
          ProductionYear: 2009,
          ProviderIds: { Tvdb: "85998" },
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-1/Seasons")) {
        return jsonResponse({
          Items: [{ Id: "season-2", Name: "Season 2", IndexNumber: 2 }],
        });
      }
      if (url.includes("jellyfin.test") && url.includes("/Shows/series-1/Episodes")) {
        return jsonResponse({
          Items: [
            { Id: "episode-1", Name: "Pawnee Zoo", ParentIndexNumber: 2, IndexNumber: 1 },
            { Id: "episode-2", Name: "The Stakeout", ParentIndexNumber: 2, IndexNumber: 2 },
          ],
        });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series")) {
        return jsonResponse([
          {
            id: 42,
            title: "Parks and Recreation",
            year: 2009,
            tvdbId: 85998,
            images: [],
          },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "direct-season-hash",
            name: "Parks.and.Recreation.S02.1080p",
            category: "tv",
            tags: "churn-direct",
            progress: 1,
            size: 10_000,
            amount_left: 0,
            state: "uploading",
            completion_on: Math.floor(Date.now() / 1_000) - 5,
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const config = jellyfinConfig;
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);

    const detail = await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/series-1",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().episodes).toMatchObject([
      { key: "s02e01", availability: "jellyfin" },
      { key: "s02e02", availability: "jellyfin" },
    ]);
    expect(detail.json().episodes[0].download).toBeUndefined();

    const live = await app.inject({
      method: "GET",
      url: "/api/library/shows/jellyfin/series-1/downloads",
    });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ ready: true, downloads: {} });
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

  it("serves fast per-episode downloads once the show detail has cached identities", async () => {
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
            amount_left: 5_800,
            dlspeed: 1_200_000,
            eta: 120,
            num_seeds: 12,
            num_complete: 48,
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const cold = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42/downloads",
    });
    expect(cold.json()).toMatchObject({ ready: false, downloads: {} });

    const detail = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42",
    });
    expect(detail.statusCode).toBe(200);

    const live = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/42/downloads",
    });
    const body = live.json();

    expect(live.statusCode).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.downloads).toMatchObject({
      s01e01: {
        status: "downloading",
        progress: 42,
        sizeBytes: 10_000,
        sizeLeftBytes: 5_800,
        downloadSpeedBytes: 1_200_000,
        connectedSeeders: 12,
        swarmSeeders: 48,
      },
      s01e02: { progress: 42 },
    });
    await app.close();
  });

  it("asks Sonarr to scan a completed qBittorrent download it lost", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-key";
    const commands: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/43")) {
        return jsonResponse({
          id: 43,
          title: "Example Show",
          year: 2024,
          tvdbId: 5678,
          images: [],
        });
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=43")) {
        return jsonResponse([
          {
            id: 601,
            seriesId: 43,
            seasonNumber: 1,
            episodeNumber: 1,
            title: "First",
            airDateUtc: "2024-01-01T00:00:00Z",
            hasFile: false,
          },
          {
            id: 602,
            seriesId: 43,
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
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/command")) {
        commands.push(readBody(init));
        return jsonResponse({ id: 99 });
      }
      if (url.endsWith("/api/v2/torrents/info")) {
        return jsonResponse([
          {
            hash: "44dbb26758b4ed17be93003f86c03461afbe2d8c",
            name: "Example.Show.S01.1080p.BluRay.x265-KONTRAST",
            progress: 1,
            state: "stalledUP",
            size: 10_000,
            content_path: "/data/Example.Show.S01.1080p.BluRay.x265-KONTRAST",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/shows/sonarr/43",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(commands).toEqual([
      {
        name: "DownloadedEpisodesScan",
        path: "/data/Example.Show.S01.1080p.BluRay.x265-KONTRAST",
        importMode: "auto",
      },
    ]);
    for (const episode of body.episodes) {
      expect(episode.download).toMatchObject({
        status: "importing",
        progress: 100,
        untracked: true,
        statusMessages: [expect.stringContaining("asked Sonarr to import it")],
      });
    }

    // Polling the page while Sonarr imports must not queue the scan again.
    await app.inject({ method: "GET", url: "/api/library/shows/sonarr/43" });
    expect(commands).toHaveLength(1);
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
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "season-hash",
            name: "Example.Show.S01.1080p",
            category: "tv",
            progress: 0.5,
            size: 1000,
            amount_left: 500,
            state: "downloading",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
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

  it("surfaces a failed Prowlarr search instead of retrying on every poll", async () => {
    let releaseSearches = 0;
    installFetch((url) => {
      if (url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      if (url.endsWith("/api/v3/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV (Prowlarr)" }]);
      }
      if (url.endsWith("/api/v1/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v1/search")) {
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

  it("shows an active qBittorrent download on the movie", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbittorrent-key";
    installFetch((url) => {
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "dune-hash",
            name: "Dune.2021.1080p.BluRay.x264",
            category: "movies",
            progress: 0.42,
            size: 2_000_000_000,
            dlspeed: 8_000_000,
            eta: 120,
            state: "downloading",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.download).toMatchObject({
      kind: "movie",
      title: "Dune",
      status: "downloading",
      progress: 42,
      quality: "1080p",
      queueCount: 1,
    });
    await app.close();
  });

  it("serves a fast movie download once the detail route has cached its identity", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbittorrent-key";
    installFetch((url) => {
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "dune-hash",
            name: "Dune.2021.1080p.BluRay.x264",
            category: "movies",
            progress: 0.42,
            size: 2_000_000_000,
            amount_left: 1_160_000_000,
            dlspeed: 8_000_000,
            eta: 120,
            num_seeds: 14,
            num_complete: 220,
            state: "downloading",
          },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const coldResponse = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7/download",
    });
    expect(coldResponse.json()).toMatchObject({ ready: false });

    const detail = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7",
    });
    expect(detail.statusCode).toBe(200);

    const live = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7/download",
    });
    const body = live.json();

    expect(live.statusCode).toBe(200);
    expect(body).toMatchObject({
      ready: true,
      download: {
        title: "Dune",
        status: "downloading",
        progress: 42,
        sizeBytes: 2_000_000_000,
        downloadSpeedBytes: 8_000_000,
        connectedSeeders: 14,
        swarmSeeders: 220,
      },
    });
    await app.close();
  });

  it("serves and cancels a tagged hash-named movie download", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbittorrent-key";
    let deletedBody: string | undefined;
    installFetch((url, init) => {
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "dead-hash",
            name: "0c844bcadda6d636501067091afb86d85c969bde",
            category: "movies",
            tags: "churn-direct,churn-movie-7",
            state: "metaDL",
            has_metadata: false,
            added_on: Math.floor(Date.now() / 1_000) - 10,
            progress: 0,
            size: 0,
            amount_left: 0,
            num_seeds: 0,
            num_complete: 0,
            dlspeed: 0,
            eta: 8_640_000,
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/delete") {
        deletedBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const detail = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7",
    });
    expect(detail.statusCode).toBe(200);

    const live = await app.inject({
      method: "GET",
      url: "/api/library/movies/radarr/7/download",
    });
    expect(live.json()).toMatchObject({
      ready: true,
      download: {
        movieId: 7,
        title: "Dune",
        status: "warning",
        progress: 0,
        statusMessages: [expect.stringContaining("has not received torrent metadata")],
      },
    });

    const cancelled = await app.inject({
      method: "DELETE",
      url: "/api/library/movies/radarr/7/download",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      status: "cancelled",
      downloadClientRemoved: 1,
    });
    expect(deletedBody).toContain("hashes=dead-hash");
    await app.close();
  });

  it("cancels the movie download without deleting the Radarr movie", async () => {
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbittorrent-key";
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    installFetch((url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie/7")) {
        return jsonResponse({ ...movieLookup, id: 7 });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({
          records: [
            { id: 11, movieId: 7, title: "Dune.2021.1080p", status: "downloading" },
            { id: 12, movieId: 8, title: "Other.Movie.2020.1080p", status: "downloading" },
          ],
        });
      }
      if (url.includes("radarr.test") && url.includes("/api/v3/queue/11?")) {
        return new Response(null, { status: 200 });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "dune-hash",
            name: "Dune.2021.1080p.BluRay.x264",
            category: "movies",
            progress: 0.42,
            size: 2_000_000_000,
            state: "downloading",
          },
          {
            hash: "other-hash",
            name: "Other.Movie.2020.1080p",
            category: "movies",
            progress: 0.5,
            size: 1_000_000_000,
            state: "downloading",
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/delete") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/movies/radarr/7/download",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "cancelled",
      queueRemoved: 1,
      downloadClientRemoved: 1,
    });
    expect(
      calls.find((call) => call.url.includes("/api/v3/queue/11?"))?.method,
    ).toBe("DELETE");
    expect(calls.some((call) => call.url.includes("/api/v3/queue/12"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/api/v3/movie/7") && call.method === "DELETE")).toBe(false);
    const deleteTorrent = calls.find((call) =>
      call.url.endsWith("/api/v2/torrents/delete"),
    );
    expect(deleteTorrent?.body).toContain("hashes=dune-hash");
    expect(deleteTorrent?.body).not.toContain("other-hash");
    await app.close();
  });

  it("cancels an untracked movie download from a Jellyfin-only movie", async () => {
    const config = makeConfig({
      jellyfin: {
        id: "jellyfin",
        name: "Jellyfin",
        url: "http://jellyfin.test:8096",
        apiKey: "jellyfin-key",
      },
    });
    config.qbittorrent.apiKey = "qbittorrent-key";
    let deletedBody: string | undefined;
    installFetch((url, init) => {
      if (url.includes("jellyfin.test") && url.includes("/Items/jellyfin-movie")) {
        return jsonResponse({
          Id: "jellyfin-movie",
          Name: "Dune",
          Type: "Movie",
          ProductionYear: 2021,
          ProviderIds: { Tmdb: "438631" },
        });
      }
      if (url.includes("radarr.test") && url.endsWith("/api/v3/movie")) {
        return jsonResponse([]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "dune-hash",
            name: "Dune.2021.1080p.BluRay.x264",
            category: "movies",
            tags: "churn-direct",
            progress: 0.42,
            size: 2_000_000_000,
            state: "downloading",
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/delete") {
        deletedBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/movies/jellyfin/jellyfin-movie/download",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "cancelled",
      queueRemoved: 0,
      downloadClientRemoved: 1,
    });
    expect(deletedBody).toContain("hashes=dune-hash");
    await app.close();
  });
});

describe("show releases", () => {
  const arrSeasonReleases = [
    {
      guid: "single-guid",
      indexerId: 1,
      indexer: "EZTV (Prowlarr)",
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
      downloadUrl: "https://prowlarr.test/1/download?link=single",
    },
    {
      guid: "pack-guid",
      indexerId: 2,
      indexer: "The Pirate Bay (Prowlarr)",
      title: "Example.Show.S01-03",
      size: 14_000_000_000,
      quality: { quality: { id: 0, name: "Unknown" } },
      seasonNumber: 1,
      seasonNumbers: [1],
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
      downloadUrl: "https://prowlarr.test/2/download?link=pack",
    },
  ];

  const prowlarrSeasonReleases = [
    {
      guid: "single-guid",
      title: "Example.Show.S01E01.1080p",
      size: 2_000_000_000,
      seeders: 12,
      leechers: 1,
      indexerId: 1,
      indexer: "EZTV",
      protocol: "torrent",
      infoHash: "single-hash",
      publishDate: "2026-01-01T00:00:00Z",
      ageHours: 12,
      downloadUrl: "https://prowlarr.test/1/download?link=single",
    },
    {
      guid: "pack-guid",
      title: "Example.Show.S01-03",
      size: 14_000_000_000,
      seeders: 16,
      leechers: 4,
      indexerId: 2,
      indexer: "The Pirate Bay",
      protocol: "torrent",
      infoHash: "pack-hash",
      publishDate: "2026-01-01T00:00:00Z",
      ageHours: 24,
      downloadUrl: "https://prowlarr.test/2/download?link=pack",
    },
  ];

  const series = {
    id: 42,
    title: "Example Show",
    year: 2024,
    tvdbId: 1234,
    path: "/data/media/tv/Example Show",
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
      { seasonNumber: 3, monitored: false },
    ],
  };

  function installShowReleaseFetch(
    handler: (url: string, init?: RequestInit) => Response | undefined,
  ) {
    return installFetch((url, init) => {
      const handled = handler(url, init);
      if (handled) {
        return handled;
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/add") {
        return new Response("Ok.", { status: 200 });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42") && init?.method !== "PUT" && init?.method !== "DELETE") {
        return jsonResponse(series);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/indexer")) {
        return jsonResponse([
          { id: 1, name: "EZTV (Prowlarr)" },
          { id: 2, name: "The Pirate Bay (Prowlarr)" },
        ]);
      }
      if (url.includes("prowlarr.test") && url.endsWith("/api/v1/indexer")) {
        return jsonResponse([
          { id: 1, name: "EZTV", enable: true },
          { id: 2, name: "The Pirate Bay", enable: true },
        ]);
      }
      if (url.includes("/api/v3/parse")) {
        return arrParseResponse(url, new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("prowlarr.test") && url.includes("indexerIds=1")) {
        return jsonResponse([prowlarrSeasonReleases[0]]);
      }
      if (url.includes("prowlarr.test") && url.includes("indexerIds=2")) {
        return jsonResponse([prowlarrSeasonReleases[1]]);
      }
      throw new Error(`unexpected URL ${url}`);
    });
  }

  it("lists per-indexer season releases without exposing upstream ids or URLs", async () => {
    installShowReleaseFetch(() => undefined);

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
      progress: { finished: 2, total: 2 },
    });
    expect(releases).toHaveLength(2);
    expect(body.groups.map((group: { label: string }) => group.label)).toEqual([
      "1080p",
      "Other",
    ]);
    const pack = releases.find((item) => item.title === "Example.Show.S01-03");
    expect(pack).toMatchObject({
      title: "Example.Show.S01-03",
      multiSeason: true,
      seasonLabel: "Seasons 1\u20133",
      canGrab: true,
      recommended: false,
      approved: true,
      mappedEpisodeCount: 0,
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

  it("keeps an indexer outside Sonarr grabbable directly", async () => {
    installShowReleaseFetch((url) => {
      if (url.includes("prowlarr.test") && url.endsWith("/api/v1/indexer")) {
        return jsonResponse([
          { id: 1, name: "EZTV", enable: true },
          { id: 9, name: "Unsynced", enable: true },
        ]);
      }
      if (url.includes("prowlarr.test") && url.includes("indexerIds=9")) {
        return jsonResponse([
          {
            ...prowlarrSeasonReleases[0],
            guid: "unsynced-guid",
            indexerId: 9,
            indexer: "Unsynced",
            infoHash: "unsynced-hash",
          },
        ]);
      }
      return undefined;
    });

    const app = await buildAuthedServer(makeConfig());
    const body = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const releases = flattenCachedReleases(body);
    const unsynced = releases.find((release) => release.indexer === "Unsynced");
    expect(unsynced).toMatchObject({ canGrab: true, approved: true });
    expect(unsynced?.downloadDetail).toBeUndefined();
    expect(body.releaseCount).toBe(2);
    await app.close();
  });

  it("sends a multi-season pack to the show root through qBittorrent", async () => {
    let addBody: URLSearchParams | undefined;
    installShowReleaseFetch((url, init) => {
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/add") {
        addBody = new URLSearchParams(String(init?.body));
        return new Response("Ok.", { status: 200 });
      }
      return undefined;
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    const list = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const pack = flattenCachedReleases(list).find(
      (item) => item.title === "Example.Show.S01-03",
    ) as { id: string };

    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, releaseId: pack.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "grabbed", title: "Example.Show.S01-03" });
    expect(addBody?.get("urls")).toBe("https://prowlarr.test/2/download?link=pack");
    expect(addBody?.get("savepath")).toBe("/data/media/tv/Example Show");
    expect(addBody?.get("category")).toBe("tv");
    expect(addBody?.get("tags")).toBe("churn-direct,churn-series-42");
    expect(addBody?.get("contentLayout")).toBe("NoSubfolder");
    await app.close();
  });

  it("sends a single-season release to the season folder", async () => {
    let addBody: URLSearchParams | undefined;
    installShowReleaseFetch((url, init) => {
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/add") {
        addBody = new URLSearchParams(String(init?.body));
        return new Response("Ok.", { status: 200 });
      }
      return undefined;
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    const list = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1",
    );
    const release = flattenCachedReleases(list).find(
      (item) => item.title === "Example.Show.S01E01.1080p",
    ) as { id: string };

    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(addBody?.get("urls")).toBe("https://prowlarr.test/1/download?link=single");
    expect(addBody?.get("savepath")).toBe(
      "/data/media/tv/Example Show/Season 1",
    );
    await app.close();
  });

  it("searches a single episode through per-indexer Prowlarr search", async () => {
    const requestedUrls: string[] = [];
    installShowReleaseFetch((url) => {
      requestedUrls.push(url);
      if (
        url.includes("prowlarr.test") &&
        url.includes("/api/v1/search") &&
        url.includes("indexerIds=1")
      ) {
        return jsonResponse([
          prowlarrSeasonReleases[0],
          {
            ...prowlarrSeasonReleases[0],
            guid: "episode-two-guid",
            title: "Example.Show.S01E02.1080p",
            infoHash: "episode-two-hash",
            downloadUrl: "https://prowlarr.test/1/download?link=two",
          },
        ]);
      }
      return undefined;
    });

    const app = await buildAuthedServer(makeConfig());
    const body = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1&episode=1",
    );

    expect(body).toMatchObject({
      kind: "series-season",
      targetId: 42,
      seasonNumber: 1,
      episodeNumber: 1,
      state: "ready",
      progress: { finished: 2, total: 2 },
    });
    const releases = flattenCachedReleases(body);
    expect(releases.map((release) => release.title).sort()).toEqual([
      "Example.Show.S01-03",
      "Example.Show.S01E01.1080p",
    ]);
    expect(
      releases.find((release) => release.title === "Example.Show.S01E01.1080p"),
    ).toMatchObject({ episodeLabel: "S01E01", canGrab: true });
    expect(body.progress.indexers).toEqual([
      expect.objectContaining({ id: 1, count: 1 }),
      expect.objectContaining({ id: 2, count: 1 }),
    ]);
    expect(
      requestedUrls.some(
        (url) => url.includes("/api/v3/release?") && url.includes("episodeId"),
      ),
    ).toBe(false);
    await app.close();
  });

  it("searches each season independently", async () => {
    const queried: string[] = [];
    installFetch((url) => {
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse(series);
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV (Prowlarr)" }]);
      }
      if (url.includes("prowlarr.test") && url.endsWith("/api/v1/indexer")) {
        return jsonResponse([{ id: 1, name: "EZTV", enable: true }]);
      }
      if (url.includes("/api/v3/parse")) {
        return arrParseResponse(url, new URL(url).searchParams.get("title") ?? "");
      }
      if (url.includes("prowlarr.test") && url.includes("/api/v1/search")) {
        const query = new URL(url).searchParams.get("query");
        queried.push(query ?? "");
        if (query?.includes("S02")) {
          return jsonResponse([
            {
              ...cachedProwlarrRelease("Example.Show.S02E01.1080p", 1),
              guid: "season-two",
            },
          ]);
        }
        return jsonResponse([cachedProwlarrRelease("Example.Show.S01E01.1080p", 1)]);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(makeConfig());
    await waitForCachedReleases(app, "/api/library/shows/sonarr/42/releases?season=1");
    const second = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=2",
    );

    expect(queried).toContain("Example Show S01");
    expect(queried).toContain("Example Show S02");
    expect(flattenCachedReleases(second).map((release) => release.title)).toEqual([
      "Example.Show.S02E01.1080p",
    ]);
    await app.close();
  });

  it("sends a selected episode release straight to qBittorrent", async () => {
    let addBody: URLSearchParams | undefined;
    installShowReleaseFetch((url, init) => {
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/add") {
        addBody = new URLSearchParams(String(init?.body));
        return new Response("Ok.", { status: 200 });
      }
      return undefined;
    });

    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    const app = await buildAuthedServer(config);
    const list = await waitForCachedReleases(
      app,
      "/api/library/shows/sonarr/42/releases?season=1&episode=1",
    );
    const release = flattenCachedReleases(list).find(
      (item) => item.title === "Example.Show.S01E01.1080p",
    ) as { id: string };

    const response = await app.inject({
      method: "POST",
      url: "/api/library/shows/sonarr/42/releases/grab",
      payload: { seasonNumber: 1, episodeNumber: 1, releaseId: release.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "grabbed",
      title: "Example.Show.S01E01.1080p",
    });
    expect(addBody?.get("urls")).toBe("https://prowlarr.test/1/download?link=single");
    expect(addBody?.get("savepath")).toBe("/data/media/tv/Example Show/Season 1");
    expect(addBody?.get("category")).toBe("tv");
    await app.close();
  });

  it("returns 404 for a stale release id", async () => {
    installShowReleaseFetch(() => undefined);

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

  function seasonReleasesAt(index: number) {
    return arrSeasonReleases[index] as (typeof arrSeasonReleases)[number];
  }

  function cachedProwlarrRelease(title: string, indexerId: number) {
    return {
      guid: `guid-${title}`,
      title,
      size: 1_000_000_000,
      seeders: 20,
      leechers: 2,
      indexerId,
      indexer: "EZTV",
      protocol: "torrent",
      infoHash: `hash-${title}`,
      downloadUrl: `https://prowlarr.test/${indexerId}/download?link=${encodeURIComponent(title)}`,
    };
  }

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

  it("cancels an untracked qBittorrent episode download", async () => {
    const calls: Array<{ body?: string }> = [];
    const config = makeConfig();
    config.qbittorrent.apiKey = "qbt-test-key";
    installFetch((url, init) => {
      if (url.includes("sonarr.test") && url.includes("/api/v3/episode?seriesId=42")) {
        return jsonResponse([
          { id: 501, seriesId: 42, seasonNumber: 1, episodeNumber: 1 },
        ]);
      }
      if (url.includes("sonarr.test") && url.includes("/api/v3/queue?")) {
        return jsonResponse({ records: [] });
      }
      if (url.includes("sonarr.test") && url.endsWith("/api/v3/series/42")) {
        return jsonResponse({ id: 42, title: "Example Show", tvdbId: 1234 });
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/info") {
        return jsonResponse([
          {
            hash: "episode-hash",
            name: "Example.Show.S01E01.1080p",
            category: "tv",
            progress: 0.5,
            size: 1000,
            state: "downloading",
          },
          {
            hash: "other-hash",
            name: "Example.Show.S01E02.1080p",
            category: "tv",
            progress: 0.5,
            size: 1000,
            state: "downloading",
          },
        ]);
      }
      if (url === "http://qbittorrent.test:8080/api/v2/torrents/delete") {
        calls.push({
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/library/shows/sonarr/42/episodes/1/1/download",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "cancelled",
      queueRemoved: 0,
      downloadClientRemoved: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain("hashes=episode-hash");
    expect(calls[0]?.body).toContain("deleteFiles=false");
    expect(calls[0]?.body).not.toContain("other-hash");
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

  function installEpisodeFetch(
    current: Record<string, unknown>,
    episodes: Array<Record<string, unknown>> | "fail",
  ): ReturnType<typeof vi.fn> {
    return installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse(playbackInfo);
      }
      if (/\/Items\/item-1\?/.test(url)) {
        return jsonResponse(current);
      }
      if (/\/Items\/series-1\?/.test(url)) {
        return jsonResponse({
          Id: "series-1",
          Type: "Series",
          ProviderIds: {},
        });
      }
      if (url.includes("/Shows/series-1/Episodes?")) {
        if (episodes === "fail") {
          return jsonResponse({ error: "unavailable" }, 500);
        }
        return jsonResponse({ Items: episodes });
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
    expect(body.item.segments).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-user-token");
    await app.close();
  });

  it("adds the next episode from Jellyfin's series list", async () => {
    installEpisodeFetch(
      {
        ...playbackItem,
        Type: "Episode",
        Name: "Episode Two",
        SeriesId: "series-1",
        ParentIndexNumber: 1,
        IndexNumber: 2,
      },
      [
        {
          Id: "episode-3",
          Name: "Episode Three",
          Type: "Episode",
          ParentIndexNumber: 1,
          IndexNumber: 3,
        },
        {
          Id: "episode-2",
          Name: "Episode Two",
          Type: "Episode",
          ParentIndexNumber: 1,
          IndexNumber: 2,
        },
        {
          Id: "episode-4",
          Name: "Episode Four",
          Type: "Episode",
          ParentIndexNumber: 1,
          IndexNumber: 4,
        },
      ],
    );

    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item.nextEpisode).toEqual({
      id: "episode-3",
      name: "Episode Three",
      seasonNumber: 1,
      episodeNumber: 3,
    });
    await app.close();
  });

  it("omits the next episode at the end of the series or when Jellyfin fails", async () => {
    const lastEpisode = {
      ...playbackItem,
      Type: "Episode",
      Name: "Finale",
      SeriesId: "series-1",
      ParentIndexNumber: 2,
      IndexNumber: 4,
    };
    installEpisodeFetch(lastEpisode, [
      {
        Id: "episode-1",
        Name: "Finale",
        Type: "Episode",
        ParentIndexNumber: 2,
        IndexNumber: 4,
      },
    ]);
    let app = await buildAuthedServer(makeConfig());
    let response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.nextEpisode).toBeUndefined();
    await app.close();

    installEpisodeFetch(lastEpisode, "fail");
    app = await buildAuthedServer(makeConfig());
    response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("ok");
    expect(response.json().item.nextEpisode).toBeUndefined();
    await app.close();
  });

  it("adds IntroDB segments warmed for an episode", async () => {
    const config = makeConfig();
    const cacheDir = path.join(
      config.serverDir,
      "cache",
      "releases",
      "introdb",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, "tt0903747.json"),
      JSON.stringify({
        version: 1,
        imdbId: "tt0903747",
        episodes: {
          s1e2: {
            fetchedAt: "2026-01-01T00:00:00.000Z",
            segments: {
              intro: { startSec: 2.5, endSec: 58 },
              outro: { startSec: 3_300, endSec: 3_500 },
            },
          },
        },
      }),
    );

    installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse(playbackInfo);
      }
      if (/\/Items\/item-1\?/.test(url)) {
        return jsonResponse({
          ...playbackItem,
          Type: "Episode",
          Name: "Episode Two",
          SeriesId: "series-1",
          ParentIndexNumber: 1,
          IndexNumber: 2,
        });
      }
      if (/\/Items\/series-1\?/.test(url)) {
        return jsonResponse({
          Id: "series-1",
          Type: "Series",
          ProviderIds: { Imdb: "tt0903747" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item.segments).toEqual({
      intro: { startSec: 2.5, endSec: 58 },
      outro: { startSec: 3_300, endSec: 3_500 },
    });
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

  it("follows the host the browser used to reach Churn", async () => {
    installFetch(() => {
      throw new Error("the stream route should not call upstream with both ids");
    });
    const config = makeConfig({
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://127.0.0.1:8096" },
    });
    config.jellyfinPublicUrl = "http://127.0.0.1:8096";
    config.jellyfinPublicUrlExplicit = false;

    const app = await buildAuthedServer(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/stream?mediaSourceId=source-1&playSessionId=session-1",
      headers: { host: "100.117.4.8:5173" },
    });

    expect(response.statusCode).toBe(302);
    expect(String(response.headers.location)).toMatch(
      /^http:\/\/100\.117\.4\.8:8096\/Videos\/item-1\/stream\?/,
    );
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

  it("offers quality presets and forces a transcode for a chosen tier", async () => {
    installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse({
          PlaySessionId: "session-1",
          MediaSources: [
            {
              Id: "source-1",
              Container: "mp4",
              Bitrate: 15_000_000,
              SupportsDirectPlay: true,
              MediaStreams: [
                { Type: "Video", Codec: "h264", Height: 1080 },
                { Type: "Audio", Codec: "aac", Channels: 2 },
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
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1?quality=medium",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item).toMatchObject({
      playbackMethod: "hls",
      directPlay: false,
      quality: "medium",
      streamUrl:
        "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1&quality=medium",
    });
    expect(body.item.qualities.map((option: { id: string }) => option.id)).toEqual([
      "max",
      "high",
      "medium",
      "low",
    ]);

    const manifest = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1&quality=medium",
    });
    expect(manifest.statusCode).toBe(302);
    const location = String(manifest.headers.location);
    expect(location).toContain("MaxHeight=720");
    expect(location).toContain("VideoBitrate=5000000");
    await app.close();
  });

  it("falls back to max when the source cannot offer the remembered tier", async () => {
    installFetch((url) => {
      if (url.includes("/PlaybackInfo?")) {
        return jsonResponse({
          PlaySessionId: "session-1",
          MediaSources: [
            {
              Id: "source-1",
              Container: "mp4",
              Bitrate: 1_500_000,
              SupportsDirectPlay: true,
              MediaStreams: [
                { Type: "Video", Codec: "h264", Height: 1080 },
                { Type: "Audio", Codec: "aac", Channels: 2 },
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
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1?quality=medium",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item).toMatchObject({
      quality: "max",
      directPlay: true,
      playbackMethod: "direct",
      streamUrl:
        "/api/playback/items/item-1/stream?mediaSourceId=source-1&playSessionId=session-1",
    });
    expect(body.item.qualities.map((option: { id: string }) => option.id)).toEqual([
      "max",
    ]);

    const manifest = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1/hls.m3u8?mediaSourceId=source-1&playSessionId=session-1&quality=medium",
    });
    expect(manifest.statusCode).toBe(302);
    expect(String(manifest.headers.location)).toContain("MaxHeight=1080");
    await app.close();
  });

  it("rejects an unknown quality", async () => {
    installFetch(() => {
      throw new Error("an invalid quality should not reach Jellyfin");
    });
    const app = await buildAuthedServer(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/api/playback/items/item-1?quality=ultra",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_quality");
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
        });
        const headers = init?.headers as Record<string, string>;
        expect(headers["X-Emby-Device-Id"]).toBeTruthy();
        expect(headers["X-Emby-Device-Id"]).not.toBe("churn-web");
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
