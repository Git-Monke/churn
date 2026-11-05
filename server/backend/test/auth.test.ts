import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    releaseTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    stateDir: mkdtempSync(path.join(tmpdir(), "churn-auth-")),
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
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
    introdb: { url: "https://api.introdb.test", timeoutMs: 500 },
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

  it("gives every session a unique Jellyfin device id", () => {
    const store = createMemorySessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
    const first = store.create(user, "one");
    const second = store.create(user, "two");
    expect(first.record.deviceId).toBeTruthy();
    expect(first.record.deviceId).not.toBe("churn-web");
    expect(first.record.deviceId).not.toBe(second.record.deviceId);
    store.close();
  });

  it("persists profiles and sessions and reloads them", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "churn-state-"));
    let now = 1_000;
    const store = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now,
      stateDir,
      sweepIntervalMs: 0,
    });
    const profile = store.createProfile({
      name: "Jamie",
      jellyfinUserId: "jellyfin-1",
      initialPin: "123456",
    });
    const created = store.create(
      { id: "jellyfin-1", name: "Jamie", isAdmin: false },
      "token-1",
      { kind: "profile", profileId: profile.id },
    );

    await store.flush();
    store.close();

    const reopened = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now + 1_000,
      stateDir,
      sweepIntervalMs: 0,
    });
    expect(reopened.getProfile(profile.id)).toMatchObject({
      name: "Jamie",
      jellyfinUserId: "jellyfin-1",
      initialPin: "123456",
    });
    const session = reopened.get(created.cookieValue);
    expect(session).toMatchObject({
      accessToken: "token-1",
      deviceId: created.record.deviceId,
      kind: "profile",
      profileId: profile.id,
    });
    reopened.close();
    now += 1_000;
  });

  it("prunes expired sessions when loading state", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "churn-state-"));
    const now = 1_000;
    const first = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now,
      stateDir,
      sweepIntervalMs: 0,
    });
    const created = first.create(user, "token");
    await first.flush();
    first.close();

    const reopened = createMemorySessionStore({
      ttlMs: 60_000,
      now: () => now + 60_001,
      stateDir,
      sweepIntervalMs: 0,
    });
    expect(reopened.get(created.cookieValue)).toBeUndefined();
    reopened.close();
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

  it("authenticates each login with a unique Jellyfin device id", async () => {
    const deviceIds: string[] = [];
    installRawFetch((url, init) => {
      if (url.endsWith("/Users/AuthenticateByName")) {
        const headers = init?.headers as Record<string, string>;
        deviceIds.push(headers["X-Emby-Device-Id"] ?? "");
        return jsonResponse(testAuthResult);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildServer(makeConfig());

    await login(app);
    await login(app);
    expect(deviceIds).toHaveLength(2);
    expect(deviceIds[0]).toBeTruthy();
    expect(deviceIds[0]).not.toBe("churn-web");
    expect(deviceIds[0]).not.toBe(deviceIds[1]);
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

describe("household profiles", () => {
  interface HouseholdState {
    pin: string;
    password?: string;
    profileId?: string;
    jellyfinUserId: string;
  }

  function installHouseholdFetch(state: HouseholdState) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/Users/AuthenticateByName") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          Username: string;
          Pw: string;
        };
        if (body.Username === "admin") {
          return jsonResponse(testAuthResult);
        }
        if (body.Username === "Jacob") {
          const expected = state.password ?? state.pin;
          if (body.Pw === expected) {
            return jsonResponse({
              AccessToken: `token-${body.Pw === state.pin ? "pin" : "password"}`,
              User: {
                Id: state.jellyfinUserId,
                Name: "Jacob",
                Policy: { IsAdministrator: false },
              },
            });
          }
        }
        return jsonResponse({}, 401);
      }
      if (url.endsWith("/Users/New") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          Name: string;
          Password: string;
        };
        expect(body.Name).toBe("Jacob");
        state.pin = body.Password;
        return jsonResponse(
          {
            Id: state.jellyfinUserId,
            Name: body.Name,
            Policy: { IsAdministrator: false },
          },
          200,
        );
      }
      if (url.endsWith(`/Users/${state.jellyfinUserId}/Password`) && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          CurrentPw?: string;
          NewPw: string;
        };
        if (body.CurrentPw !== undefined) {
          expect(body.CurrentPw).toBe(state.pin);
        }
        state.password = body.NewPw;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith(`/Users/${state.jellyfinUserId}`) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/Sessions/Logout")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function createJacob(app: Awaited<ReturnType<typeof buildServer>>, cookie: string) {
    const response = await invoker(app, cookie, {
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Jacob" },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      profile: { id: string; name: string; initialPin: string | null };
      pin: string;
    };
  }

  function invoker(
    app: Awaited<ReturnType<typeof buildServer>>,
    cookie: string,
    options: Record<string, unknown>,
  ) {
    return injectWithCookie(app, cookie, options);
  }

  it("adds a person with a PIN and hides the PIN from the public list", async () => {
    const state: HouseholdState = { pin: "", jellyfinUserId: "jf-jacob" };
    installHouseholdFetch(state);
    const app = await buildServer(makeConfig());
    const { cookie } = await login(app);

    const created = await createJacob(app, cookie as string);
    state.profileId = created.profile.id;
    expect(created.pin).toMatch(/^\d{6}$/);
    expect(created.profile.initialPin).toBe(created.pin);

    const managed = await invoker(app, cookie as string, {
      method: "GET",
      url: "/api/profiles",
    });
    expect(managed.json()).toMatchObject([
      { name: "Jacob", initialPin: created.pin, passwordSet: false },
    ]);

    const publicList = await app.inject({ method: "GET", url: "/api/auth/profiles" });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json()).toEqual([
      { id: created.profile.id, name: "Jacob", passwordSet: false },
    ]);
    await app.close();
  });

  it("requires an admin session for profile management", async () => {
    installRawFetch((url) => {
      if (url.endsWith("/Users/AuthenticateByName")) {
        return jsonResponse({
          AccessToken: "guest-token",
          User: {
            Id: "guest-id",
            Name: "guest",
            Policy: { IsAdministrator: false },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const app = await buildServer(makeConfig());
    const { cookie } = await login(app, { username: "guest", password: "secret" });

    const list = await invoker(app, cookie as string, {
      method: "GET",
      url: "/api/profiles",
    });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.code).toBe("forbidden");
    await app.close();
  });

  it("requires the PIN first, then a new password, on a person's first login", async () => {
    const state: HouseholdState = { pin: "", jellyfinUserId: "jf-jacob" };
    installHouseholdFetch(state);
    const app = await buildServer(makeConfig());
    const { cookie: adminCookie } = await login(app);
    const created = await createJacob(app, adminCookie as string);
    state.profileId = created.profile.id;

    const probe = await app.inject({
      method: "POST",
      url: "/api/auth/profile-login",
      payload: { profileId: created.profile.id, password: created.pin },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      passwordSetupRequired: true,
      profile: { id: created.profile.id, passwordSet: false },
    });

    const completed = await app.inject({
      method: "POST",
      url: "/api/auth/profile-login",
      payload: {
        profileId: created.profile.id,
        password: created.pin,
        newPassword: "a-strong-password",
      },
    });
    expect(completed.statusCode).toBe(200);
    const body = completed.json();
    expect(body).toMatchObject({
      authenticated: true,
      kind: "profile",
      profileId: created.profile.id,
      user: { name: "Jacob", isAdmin: false },
    });

    const setCookie = completed.headers["set-cookie"];
    const profileCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    const session = await invoker(app, profileCookie as string, {
      method: "GET",
      url: "/api/auth/session",
    });
    expect(session.json()).toMatchObject({
      authenticated: true,
      kind: "profile",
      profileId: created.profile.id,
    });

    const managed = await invoker(app, adminCookie as string, {
      method: "GET",
      url: "/api/profiles",
    });
    expect(managed.json()).toMatchObject([
      { name: "Jacob", initialPin: null, passwordSet: true },
    ]);

    const later = await app.inject({
      method: "POST",
      url: "/api/auth/profile-login",
      payload: { profileId: created.profile.id, password: "a-strong-password" },
    });
    expect(later.statusCode).toBe(200);
    expect(later.json()).toMatchObject({ kind: "profile", authenticated: true });
    await app.close();
  });

  it("resets a PIN and signs out that person's sessions", async () => {
    const state: HouseholdState = { pin: "", jellyfinUserId: "jf-jacob" };
    installHouseholdFetch(state);
    const app = await buildServer(makeConfig());
    const { cookie: adminCookie } = await login(app);
    const created = await createJacob(app, adminCookie as string);
    state.profileId = created.profile.id;

    const completed = await app.inject({
      method: "POST",
      url: "/api/auth/profile-login",
      payload: {
        profileId: created.profile.id,
        password: created.pin,
        newPassword: "a-strong-password",
      },
    });
    const profileCookie = (
      (completed.headers["set-cookie"] as string[] | string | undefined) instanceof Array
        ? (completed.headers["set-cookie"] as string[])[0]
        : (completed.headers["set-cookie"] as string)
    )?.split(";")[0];

    const reset = await invoker(app, adminCookie as string, {
      method: "POST",
      url: `/api/profiles/${created.profile.id}/pin`,
    });
    expect(reset.statusCode).toBe(200);
    const newPin = reset.json().pin as string;
    expect(newPin).toMatch(/^\d{6}$/);
    expect(newPin).not.toBe(created.pin);

    const after = await invoker(app, profileCookie as string, {
      method: "GET",
      url: "/api/status",
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });

  it("deletes the Jellyfin user and the profile", async () => {
    const state: HouseholdState = { pin: "", jellyfinUserId: "jf-jacob" };
    installHouseholdFetch(state);
    const app = await buildServer(makeConfig());
    const { cookie: adminCookie } = await login(app);
    const created = await createJacob(app, adminCookie as string);
    state.profileId = created.profile.id;

    const deleted = await invoker(app, adminCookie as string, {
      method: "DELETE",
      url: `/api/profiles/${created.profile.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const publicList = await app.inject({ method: "GET", url: "/api/auth/profiles" });
    expect(publicList.json()).toEqual([]);

    const missing = await invoker(app, adminCookie as string, {
      method: "DELETE",
      url: `/api/profiles/${created.profile.id}`,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("matches public routes by method as well as path", async () => {
    const app = await buildServer(makeConfig());
    const publicList = await app.inject({ method: "GET", url: "/api/auth/profiles" });
    expect(publicList.statusCode).toBe(200);

    const privateCreate = await app.inject({
      method: "POST",
      url: "/api/auth/profiles",
      payload: { name: "Jacob" },
    });
    expect(privateCreate.statusCode).toBe(401);

    const privateSession = await app.inject({ method: "POST", url: "/api/auth/session" });
    expect(privateSession.statusCode).toBe(401);
    await app.close();
  });
});
