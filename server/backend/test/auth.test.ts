import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  createLoginThrottle,
  createMemorySessionStore,
  hashSessionId,
  sessionCookieOptions,
  shouldUseSecureCookie,
  type AuthUser,
} from "../src/auth.js";

const user: AuthUser = {
  id: "user-1",
  name: "admin",
  isAdmin: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir: "/tmp/churn-auth-test",
    frontendDist: "/tmp/churn-auth-test/frontend/dist",
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
        apiKey: "api-key",
      },
      sonarr: {
        id: "sonarr",
        name: "Sonarr",
        url: "http://sonarr.test:8989",
        apiKey: "sonarr-key",
      },
      radarr: {
        id: "radarr",
        name: "Radarr",
        url: "http://radarr.test:7878",
        apiKey: "radarr-key",
      },
    },
    qbittorrent: {
      url: "http://qbittorrent.test:8080",
    },
    prowlarr: {
      url: "http://prowlarr.test:9696",
      apiKey: "prowlarr-key",
    },
    vpn: {
      statusUrl: "http://vpn-status.test:8098",
      timeoutMs: 500,
    },
    ...overrides,
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

function installRawFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

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

async function login(
  app: Awaited<ReturnType<typeof buildServer>>,
  payload = { username: "admin", password: "secret" },
): Promise<{ response: Awaited<ReturnType<typeof app.inject>>; cookie?: string }> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload });
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    response,
    cookie: cookieHeader?.split(";")[0],
  };
}

function injectWithCookie(
  app: Awaited<ReturnType<typeof buildServer>>,
  cookie: string,
  options: Record<string, unknown>,
) {
  return app.inject({
    ...options,
    headers: {
      ...((options.headers as Record<string, string> | undefined) ?? {}),
      cookie,
    },
  });
}

describe("memory session store", () => {
  it("stores a hashed id and looks sessions up by the raw cookie value", () => {
    let now = 1_000;
    const store = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now,
      sweepIntervalMs: 0,
    });

    const created = store.create(user, "jellyfin-token");
    expect(created.record.idHash).toBe(hashSessionId(created.cookieValue));
    expect(created.record.idHash).not.toBe(created.cookieValue);
    expect(created.record.accessToken).toBe("jellyfin-token");
    expect(store.size()).toBe(1);

    expect(store.get(created.cookieValue)).toMatchObject({
      user,
      accessToken: "jellyfin-token",
    });
    expect(store.get("wrong-cookie")).toBeUndefined();
    store.close();
  });

  it("slides the idle TTL on access and expires idle sessions", () => {
    let now = 1_000;
    const store = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now,
      sweepIntervalMs: 0,
    });
    const { cookieValue } = store.create(user, "token");

    now += 50_000;
    expect(store.get(cookieValue)).toBeDefined();

    now += 50_000;
    expect(store.get(cookieValue)).toBeDefined();

    now += 60_001;
    expect(store.get(cookieValue)).toBeUndefined();
    expect(store.size()).toBe(0);
    store.close();
  });

  it("destroys one session or every session for a user", () => {
    const store = createMemorySessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
    const first = store.create(user, "one");
    const second = store.create(user, "two");
    const other = store.create({ id: "user-2", name: "guest", isAdmin: false }, "three");

    expect(store.destroy(first.cookieValue)?.accessToken).toBe("one");
    expect(store.get(first.cookieValue)).toBeUndefined();
    expect(store.destroy("missing")).toBeUndefined();

    expect(store.destroyAllForUser(user.id)).toBe(1);
    expect(store.get(second.cookieValue)).toBeUndefined();
    expect(store.get(other.cookieValue)).toBeDefined();
    store.close();
  });
});

describe("session cookies", () => {
  function request(protocol: string, forwarded?: string): FastifyRequest {
    return {
      protocol,
      headers: forwarded ? { "x-forwarded-proto": forwarded } : {},
    } as FastifyRequest;
  }

  it("derives secure cookies from the request when set to auto", () => {
    expect(shouldUseSecureCookie(request("http"), "auto")).toBe(false);
    expect(shouldUseSecureCookie(request("https"), "auto")).toBe(true);
    expect(shouldUseSecureCookie(request("http", "https"), "auto")).toBe(true);
    expect(shouldUseSecureCookie(request("http"), true)).toBe(true);
    expect(shouldUseSecureCookie(request("https"), false)).toBe(false);
  });

  it("uses HttpOnly, SameSite=Lax and a path-scoped cookie", () => {
    expect(sessionCookieOptions(request("http"), "auto")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
      secure: false,
    });
  });
});

describe("login throttle", () => {
  it("blocks after repeated failures and resets on success", () => {
    let now = 0;
    const throttle = createLoginThrottle({
      maxFailures: 2,
      windowMs: 60_000,
      now: () => now,
    });
    const key = "127.0.0.1|admin";

    expect(throttle.check(key)).toEqual({ allowed: true });
    throttle.recordFailure("other-key");
    throttle.recordFailure(key);
    expect(throttle.check(key)).toMatchObject({ allowed: true });
    throttle.recordFailure(key);

    expect(throttle.check(key)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    throttle.reset(key);
    expect(throttle.check(key)).toEqual({ allowed: true });
  });

  it("forgets failures after the window", () => {
    let now = 0;
    const throttle = createLoginThrottle({
      maxFailures: 1,
      windowMs: 1_000,
      now: () => now,
    });
    throttle.recordFailure("key");
    expect(throttle.check("key").allowed).toBe(false);
    now = 1_001;
    expect(throttle.check("key").allowed).toBe(true);
  });
});

describe("auth routes", () => {
  it("logs in, sets a hardened cookie and reports the session", async () => {
    installFetch(() => {
      throw new Error("unexpected upstream call");
    });
    const app = await buildServer(makeConfig());

    const { response, cookie } = await login(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: true,
      user: { id: "test-user", name: "tester", isAdmin: true },
    });
    const setCookie = response.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain("churn_session=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(cookieHeader).toContain("Path=/");
    expect(cookieHeader).toContain("Max-Age=604800");
    expect(cookieHeader).not.toContain("Secure");

    const session = await injectWithCookie(app, cookie as string, {
      method: "GET",
      url: "/api/auth/session",
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: true,
      user: { id: "test-user", name: "tester", isAdmin: true },
    });
    await app.close();
  });

  it("returns a generic 401 for invalid credentials without a cookie", async () => {
    installRawFetch(() => jsonResponse({}, 401));
    const app = await buildServer(makeConfig());

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credentials");
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("reports an unreachable Jellyfin", async () => {
    installRawFetch(() => {
      throw new Error("connection refused");
    });
    const app = await buildServer(makeConfig());

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "secret" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("jellyfin_unreachable");
    await app.close();
  });

  it("requires a session for protected API routes", async () => {
    const app = await buildServer(makeConfig());
    const response = await app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
    await app.close();
  });

  it("rejects a cross-origin login attempt", async () => {
    installFetch(() => jsonResponse(testAuthResult));
    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:4000", origin: "https://evil.test" },
      payload: { username: "admin", password: "secret" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("cross_origin_request");
    await app.close();
  });

  it("accepts the public origin from a reverse proxy", async () => {
    installFetch(() => jsonResponse(testAuthResult));
    const app = await buildServer(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:5173",
        "x-forwarded-host": "127.0.0.1:5173",
        "sec-fetch-site": "same-origin",
      },
      payload: { username: "admin", password: "secret" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("logs out, clears the cookie and revokes the session", async () => {
    const fetchMock = installFetch((url) => {
      if (url.endsWith("/Sessions/Logout")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildServer(makeConfig());
    const { cookie } = await login(app);

    const logout = await injectWithCookie(app, cookie as string, {
      method: "POST",
      url: "/api/auth/logout",
    });
    expect(logout.statusCode).toBe(204);
    const setCookie = logout.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain("churn_session=");
    expect(cookieHeader).toContain("Expires=");
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/Sessions/Logout")),
    ).toBe(true);

    const session = await injectWithCookie(app, cookie as string, {
      method: "GET",
      url: "/api/auth/session",
    });
    expect(session.json()).toEqual({ authenticated: false });
    await app.close();
  });

  it("expires idle sessions", async () => {
    installFetch(() => jsonResponse(testAuthResult));
    const app = await buildServer(makeConfig({ sessionTtlMs: 1_000 }));
    const { cookie } = await login(app);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await injectWithCookie(app, cookie as string, {
      method: "GET",
      url: "/api/status",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthenticated");
    await app.close();
  });

  it("throttles repeated failed logins", async () => {
    installRawFetch(() => jsonResponse({}, 401));
    const app = await buildServer(makeConfig());
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong" },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_attempts");
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("uses the session user token for Jellyfin library calls", async () => {
    const seenTokens: string[] = [];
    installFetch((url, init) => {
      if (url.endsWith("/System/Info/Public")) {
        return jsonResponse({ Version: "10.11.11", StartupWizardCompleted: true });
      }
      if (url.endsWith("/Users/test-user/Views")) {
        return jsonResponse({ Items: [{ Id: "movies-view", CollectionType: "movies" }] });
      }
      if (url.includes("/Users/test-user/Items?")) {
        seenTokens.push(
          String((init?.headers as Record<string, string> | undefined)?.["X-Emby-Token"]),
        );
        return jsonResponse({ Items: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildServer(makeConfig());
    const { cookie } = await login(app);

    const response = await injectWithCookie(app, cookie as string, {
      method: "GET",
      url: "/api/library",
    });
    expect(response.statusCode).toBe(200);
    expect(seenTokens).toEqual(["test-user-token"]);
    await app.close();
  });
});
