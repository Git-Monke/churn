import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemorySessionStore, type SessionStore } from "../src/auth.js";
import type { ServiceConfig } from "../src/config.js";
import { syncProfiles, syncProfilesAtStartup } from "../src/profiles.js";

const jellyfin: ServiceConfig = {
  id: "jellyfin",
  name: "Jellyfin",
  url: "http://jellyfin.test:8096",
  apiKey: "api-key",
};

function stubUsers(response: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStore(): SessionStore {
  return createMemorySessionStore({ ttlMs: 60_000 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("profile sync", () => {
  it("imports an unknown Jellyfin user as a profile with the password already set", async () => {
    stubUsers(() =>
      jsonResponse([
        { Id: "u1", Name: "Jacob", HasPassword: true, Policy: { IsAdministrator: false } },
      ]),
    );
    const store = makeStore();

    const result = await syncProfiles(store, jellyfin, { timeoutMs: 500 });

    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.error).toBeUndefined();
    const profile = store.getProfileByName("jacob");
    expect(profile).toMatchObject({ name: "Jacob", jellyfinUserId: "u1", initialPin: null });
    expect(profile?.initialPin).toBeNull();

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("http://jellyfin.test:8096/Users");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ "X-Emby-Token": "api-key" });
  });

  it("skips accounts that are not churn people", async () => {
    stubUsers(() =>
      jsonResponse([
        { Id: "admin", Name: "admin", Policy: { IsAdministrator: true } },
        { Id: "u2", Name: "NoSecret", HasPassword: false },
        { Id: "u3", Name: "Disabled", Policy: { IsDisabled: true } },
        { Id: "u-known", Name: "Existing", Policy: {} },
        { Id: "u-dup", Name: "  existing ", Policy: {} },
        { Id: "u4", Policy: {} },
      ]),
    );
    const store = makeStore();
    store.createProfile({ name: "Existing", jellyfinUserId: "u-known", initialPin: "123456" });
    const warnings: string[] = [];

    const result = await syncProfiles(store, jellyfin, {
      timeoutMs: 500,
      onWarning: (message) => warnings.push(message),
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped).toBe(6);
    expect(store.listProfiles()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Jellyfin user "existing" shares a name');
  });

  it("adopts accounts that Jellyfin hides from its own login screen", async () => {
    // Jellyfin 10.11 reports IsHidden: true even for ordinary accounts; only
    // Jellyfin's own login screen honours it, and churn renders its own picker.
    stubUsers(() =>
      jsonResponse([
        { Id: "u1", Name: "Jacob", HasPassword: true, Policy: { IsHidden: true } },
      ]),
    );

    const result = await syncProfiles(makeStore(), jellyfin, { timeoutMs: 500 });

    expect(result.imported.map((profile) => profile.name)).toEqual(["Jacob"]);
  });

  it("is idempotent across restarts", async () => {
    stubUsers(() => jsonResponse([{ Id: "u1", Name: "Jacob", Policy: {} }]));
    const store = makeStore();

    await syncProfiles(store, jellyfin, { timeoutMs: 500 });
    const second = await syncProfiles(store, jellyfin, { timeoutMs: 500 });

    expect(second.imported).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(store.listProfiles()).toHaveLength(1);
  });

  it("does not call Jellyfin when no API key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warnings: string[] = [];

    const result = await syncProfiles(
      makeStore(),
      { ...jellyfin, apiKey: undefined },
      { timeoutMs: 500, onWarning: (message) => warnings.push(message) },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.imported).toEqual([]);
    expect(warnings[0]).toContain("JELLYFIN_API_KEY is not configured");
  });

  it("reports an unreachable Jellyfin without throwing or importing anyone", async () => {
    stubUsers(() => jsonResponse({ error: "boom" }, 500));
    const store = makeStore();
    const warnings: string[] = [];

    const result = await syncProfiles(store, jellyfin, {
      timeoutMs: 500,
      onWarning: (message) => warnings.push(message),
    });

    expect(result.error).toContain("HTTP 500");
    expect(result.imported).toEqual([]);
    expect(store.listProfiles()).toEqual([]);
    expect(warnings[0]).toContain("profile sync could not read Jellyfin users");
  });

  it("retries a failed startup sync while Jellyfin is still booting", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: "not ready" }, 503)
          : jsonResponse([{ Id: "u1", Name: "Jacob", Policy: {} }]);
      }),
    );
    const store = makeStore();
    const warnings: string[] = [];

    const result = await syncProfilesAtStartup(store, jellyfin, {
      timeoutMs: 500,
      retryDelaysMs: [0],
      onWarning: (message) => warnings.push(message),
    });

    expect(attempt).toBe(2);
    expect(result.error).toBeUndefined();
    expect(store.getProfileByName("jacob")?.jellyfinUserId).toBe("u1");
    expect(warnings).toHaveLength(1);
  });

  it("gives up quietly after the retries are exhausted", async () => {
    stubUsers(() => jsonResponse({ error: "down" }, 503));
    const store = makeStore();
    const warnings: string[] = [];

    const result = await syncProfilesAtStartup(store, jellyfin, {
      timeoutMs: 500,
      retryDelaysMs: [0],
      onWarning: (message) => warnings.push(message),
    });

    expect(result.error).toContain("HTTP 503");
    expect(store.listProfiles()).toEqual([]);
    expect(warnings.at(-1)).toContain("giving up on the profile sync");
  });
});
