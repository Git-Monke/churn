import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemorySessionStore } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import {
  cleanDeviceName,
  createPairingStore,
  generatePairingCode,
  isPairingCode,
  normalizeCode,
} from "../src/device-pairing.js";
import { buildServer as buildUncheckedServer } from "../src/server.js";
import { createContractChecker } from "./support/api-contract-check.js";

const contract = createContractChecker();
const buildServer: typeof buildUncheckedServer = (config, options = {}) =>
  buildUncheckedServer(config, { ...options, onResponse: contract.check });

afterEach(() => {
  contract.assertClean();
  vi.unstubAllGlobals();
});

/** A config whose state lives in a temporary directory of this test's own. */
function makeConfig(): AppConfig {
  const serverDir = mkdtempSync(path.join(tmpdir(), "churn-pairing-"));
  return {
    host: "127.0.0.1",
    port: 4000,
    serverDir,
    frontendDist: path.join(serverDir, "no-frontend"),
    requestTimeoutMs: 500,
    releaseTimeoutMs: 500,
    searchTimeoutMs: 500,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    stateDir: path.join(serverDir, "state"),
    cookieSecure: "auto",
    jellyfinPublicUrl: "http://jellyfin.test:8096",
    jellyfinPublicUrlExplicit: true,
    services: {
      jellyfin: { id: "jellyfin", name: "Jellyfin", url: "http://jellyfin.test:8096", apiKey: "jellyfin-key" },
      sonarr: { id: "sonarr", name: "Sonarr", url: "http://sonarr.test:8989" },
      radarr: { id: "radarr", name: "Radarr", url: "http://radarr.test:7878" },
    },
    qbittorrent: { url: "http://qbittorrent.test:8080" },
    prowlarr: { url: "http://prowlarr.test:9696" },
    introdb: { url: "https://api.introdb.test", timeoutMs: 500 },
    vpn: { statusUrl: "http://vpn-status.test:8098", timeoutMs: 500 },
  } as unknown as AppConfig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const admin = { Id: "user-1", Name: "Ada", Policy: { IsAdministrator: true } };

interface FakeJellyfin {
  quickConnectEnabled: boolean;
  authorized: Set<string>;
  loggedOut: string[];
  /** Device names Jellyfin saw on Quick Connect requests. */
  deviceHeaders: string[];
}

/** A Jellyfin that does password sign-in and Quick Connect, and records sign-outs. */
function installJellyfin(): FakeJellyfin {
  const fake: FakeJellyfin = { quickConnectEnabled: true, authorized: new Set(), loggedOut: [], deviceHeaders: [] };
  let next = 0;
  const secrets = new Map<string, string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname === "/Users/AuthenticateByName") {
        return jsonResponse({ AccessToken: "browser-token", User: admin });
      }
      if (url.pathname === "/QuickConnect/Enabled") return jsonResponse(fake.quickConnectEnabled);
      if (url.pathname === "/QuickConnect/Initiate") {
        if (!fake.quickConnectEnabled) return jsonResponse({}, 401);
        fake.deviceHeaders.push(headers.get("x-emby-device-name") ?? "");
        next += 1;
        secrets.set(`QC${next}`, `secret-${next}`);
        return jsonResponse({ Code: `QC${next}`, Secret: `secret-${next}`, Authenticated: false });
      }
      if (url.pathname === "/QuickConnect/Authorize") {
        // Authorized as the person approving, with their own token.
        if (headers.get("x-emby-token") !== "browser-token" || url.searchParams.get("userId") !== admin.Id) {
          return jsonResponse({}, 401);
        }
        fake.authorized.add(url.searchParams.get("code") ?? "");
        return jsonResponse(true);
      }
      if (url.pathname === "/Users/AuthenticateWithQuickConnect") {
        const secret = (JSON.parse(String(init?.body)) as { Secret: string }).Secret;
        const code = [...secrets].find(([, value]) => value === secret)?.[0];
        if (!code || !fake.authorized.has(code)) return jsonResponse({}, 401);
        return jsonResponse({ AccessToken: `device-token-for-${code}`, User: admin });
      }
      if (url.pathname === "/Sessions/Logout") {
        fake.loggedOut.push(headers.get("x-emby-token") ?? "");
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, 404);
    }),
  );
  return fake;
}

async function signIn(app: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "Ada", password: "secret" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function startPairing(app: Awaited<ReturnType<typeof buildServer>>, deviceName = "Living Room TV") {
  const response = await app.inject({ method: "POST", url: "/api/v1/tv/pair/start", payload: { deviceName } });
  expect(response.statusCode).toBe(200);
  return response.json() as { code: string; pollToken: string; approvePath: string; pollIntervalSeconds: number };
}

describe("pairing codes", () => {
  it("are six easy-to-read characters, accepted however they are typed", () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(isPairingCode(code.toLowerCase())).toBe(true);
    }
    expect(normalizeCode("ab-c d2e")).toBe("ABCD2E");
    expect(isPairingCode("ABC0EF")).toBe(false);
    expect(isPairingCode("ABCDE")).toBe(false);
  });

  it("expire, and only the device's own token can poll them", () => {
    let now = 1_000;
    const store = createPairingStore({ now: () => now, ttlMs: 60_000 });
    const created = store.create({ deviceName: "TV", deviceId: "d1", quickConnectCode: "Q", quickConnectSecret: "S" })!;
    expect(store.getForDevice(created.pairing.code, created.pollToken)).toBeDefined();
    expect(store.getForDevice(created.pairing.code, "someone-else")).toBeUndefined();
    expect(store.get(created.pairing.code.toLowerCase())).toBeDefined();
    now += 60_000;
    expect(store.get(created.pairing.code)).toBeUndefined();
  });
});

describe("device names", () => {
  it("drop quotes and control characters, so they are safe inside Jellyfin's header", () => {
    expect(cleanDeviceName('Living "Room"\r\nTV\\')).toBe("Living Room TV");
    expect(cleanDeviceName("  Bedroom   Apple TV ")).toBe("Bedroom Apple TV");
    expect(cleanDeviceName("x".repeat(100))).toHaveLength(60);
    expect(cleanDeviceName("\n\t")).toBeUndefined();
    expect(cleanDeviceName(42)).toBeUndefined();
  });
});

describe("device pairing", () => {
  it("pairs a TV approved from the dashboard, and the TV signs in with its own token", async () => {
    const jellyfin = installJellyfin();
    const app = await buildServer(makeConfig());
    const cookie = await signIn(app);

    // The TV, signed out, starts pairing and polls.
    const started = await startPairing(app);
    expect(started.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(started.approvePath).toBe(`/#/pair?code=${started.code}`);
    expect(jellyfin.deviceHeaders).toEqual(["Living Room TV"]);
    const poll = () =>
      app.inject({
        method: "GET",
        url: `/api/v1/tv/pair/${started.code}`,
        headers: { "x-churn-pair-token": started.pollToken },
      });
    expect((await poll()).json()).toEqual({ status: "pending" });

    // A person signed in to the dashboard sees what they're approving, then approves.
    const details = await app.inject({
      method: "GET",
      url: `/api/tv/pair/${started.code.toLowerCase()}/details`,
      headers: { cookie },
    });
    expect(details.json()).toMatchObject({ code: started.code, deviceName: "Living Room TV", status: "pending" });
    const approved = await app.inject({ method: "POST", url: `/api/tv/pair/${started.code}/approve`, headers: { cookie } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().device).toMatchObject({ name: "Living Room TV", user: { id: "user-1", name: "Ada" } });

    // The token comes once.
    const delivered = (await poll()).json();
    expect(delivered).toMatchObject({ status: "approved", user: { id: "user-1" } });
    expect(typeof delivered.token).toBe("string");
    expect((await poll()).statusCode).toBe(404);

    // The TV is signed in as a device, on its own Jellyfin session.
    const bearer = { authorization: `Bearer ${delivered.token}` };
    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer });
    expect(session.json()).toMatchObject({ authenticated: true, kind: "device", user: { id: "user-1" } });
    const expiresInDays = (Date.parse(session.json().expiresAt) - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(170);

    // Even an administrator's TV does no admin work, and can't pair or manage devices.
    expect((await app.inject({ method: "GET", url: "/api/v1/profiles", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/tv/devices", headers: bearer })).statusCode).toBe(403);

    // The dashboard lists it, and revoking it signs it out of Jellyfin and churn.
    const listed = await app.inject({ method: "GET", url: "/api/tv/devices", headers: { cookie } });
    expect(listed.json().devices).toHaveLength(1);
    const deviceId = listed.json().devices[0].id;
    const revoked = await app.inject({ method: "DELETE", url: `/api/tv/devices/${deviceId}`, headers: { cookie } });
    expect(revoked.statusCode).toBe(204);
    expect(jellyfin.loggedOut).toContain(`device-token-for-QC1`);
    const after = await app.inject({ method: "GET", url: "/api/v1/library", headers: bearer });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("device_not_paired");

    // The browser that approved it is still signed in.
    const browser = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    expect(browser.json()).toMatchObject({ authenticated: true, kind: "admin" });
    await app.close();
  });

  it("tells the TV when pairing is denied", async () => {
    installJellyfin();
    const app = await buildServer(makeConfig());
    const cookie = await signIn(app);
    const started = await startPairing(app);
    const denied = await app.inject({ method: "POST", url: `/api/tv/pair/${started.code}/deny`, headers: { cookie } });
    expect(denied.statusCode).toBe(204);
    const again = await app.inject({ method: "POST", url: `/api/tv/pair/${started.code}/approve`, headers: { cookie } });
    expect(again.json().error.code).toBe("pairing_already_decided");
    const poll = () =>
      app.inject({
        method: "GET",
        url: `/api/tv/pair/${started.code}`,
        headers: { "x-churn-pair-token": started.pollToken },
      });
    expect((await poll()).json()).toEqual({ status: "denied" });
    expect((await poll()).statusCode).toBe(404);
    await app.close();
  });

  it("keeps the code to itself: wrong tokens, unknown codes and signed-out approvals are refused", async () => {
    installJellyfin();
    const app = await buildServer(makeConfig());
    const started = await startPairing(app);
    const wrongToken = await app.inject({
      method: "GET",
      url: `/api/tv/pair/${started.code}`,
      headers: { "x-churn-pair-token": "guess" },
    });
    expect(wrongToken.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tv/pair/${started.code}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/tv/pair/${started.code}/approve` })).statusCode).toBe(401);
    const cookie = await signIn(app);
    const unknown = await app.inject({ method: "GET", url: "/api/tv/pair/ZZZZZZ/details", headers: { cookie } });
    expect(unknown.json().error.code).toBe("pairing_not_found");
    await app.close();
  });

  it("asks for a name, explains when Quick Connect is off, and limits how often pairing starts", async () => {
    const jellyfin = installJellyfin();
    const app = await buildServer(makeConfig());
    const nameless = await app.inject({ method: "POST", url: "/api/tv/pair/start", payload: { deviceName: " " } });
    expect(nameless.json().error.code).toBe("invalid_request");

    jellyfin.quickConnectEnabled = false;
    const off = await app.inject({ method: "POST", url: "/api/tv/pair/start", payload: { deviceName: "TV" } });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe("quick_connect_disabled");

    jellyfin.quickConnectEnabled = true;
    let last = 0;
    for (let index = 0; index < 20; index += 1) {
      last = (await app.inject({ method: "POST", url: "/api/tv/pair/start", payload: { deviceName: "TV" } })).statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("lets a TV sign itself out without touching anyone else's session", async () => {
    installJellyfin();
    const app = await buildServer(makeConfig());
    const cookie = await signIn(app);
    const started = await startPairing(app);
    await app.inject({ method: "POST", url: `/api/tv/pair/${started.code}/approve`, headers: { cookie } });
    const { token } = (
      await app.inject({
        method: "GET",
        url: `/api/tv/pair/${started.code}`,
        headers: { "x-churn-pair-token": started.pollToken },
      })
    ).json();
    const bearer = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: bearer })).json()).toEqual({
      authenticated: false,
    });
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).json()).toMatchObject({
      authenticated: true,
    });
    await app.close();
  });
});

describe("device sessions", () => {
  it("outlive browser sessions and survive a restart with their name", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "churn-device-sessions-"));
    let now = 0;
    const options = { ttlMs: 1_000, deviceTtlMs: 10_000, stateDir, now: () => now, sweepIntervalMs: 0, flushDebounceMs: 0 };
    const store = createMemorySessionStore(options);
    const user = { id: "u", name: "Ada", isAdmin: false };
    const browser = store.create(user, "t1");
    const device = store.create(user, "t2", { kind: "device", deviceId: "tv-1", deviceName: "Den TV" });
    await store.flush();
    store.close();

    now = 5_000;
    const reloaded = createMemorySessionStore(options);
    expect(reloaded.get(browser.cookieValue)).toBeUndefined();
    expect(reloaded.get(device.cookieValue)).toMatchObject({ kind: "device", deviceName: "Den TV" });
    expect(reloaded.listDevices().map((record) => record.deviceId)).toEqual(["tv-1"]);
    expect(reloaded.destroyDevice("tv-1")).toBeDefined();
    expect(reloaded.get(device.cookieValue)).toBeUndefined();
    reloaded.close();
  });
});
