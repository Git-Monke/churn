import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createPasskeyStore, type PasskeyRecord } from "../src/passkey-store.js";
import { buildServer } from "../src/server.js";

const origin = "https://churn.example.com";
const temporaryDirs: string[] = [];

function temporaryDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "churn-passkeys-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("passkey persistence", () => {
  it("persists updates, rejects stale writes, and keeps the token file private", () => {
    const dir = temporaryDir();
    const store = createPasskeyStore(dir);
    const record: PasskeyRecord = {
      id: "credential", origin, publicKey: "example", counter: 0, userId: "jellyfin-user",
      accessToken: "fixture-token", deviceId: "device-id", label: "Test key",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(store.add(record)).toBe(true);
    expect(store.add(record)).toBe(false);
    expect(store.update(record, 1)).toBe(true);
    expect(store.update(record, 2)).toBe(false);
    expect(createPasskeyStore(dir).get(record.id)?.counter).toBe(1);
    expect(statSync(path.join(dir, "passkeys.json")).mode & 0o777).toBe(0o600);
    store.remove([record]);
    expect(createPasskeyStore(dir).get(record.id)).toBeUndefined();
    expect(store.update(record, 2)).toBe(false);
  });
});

describe("passkey routes", () => {
  it("allows only the configured origin and keeps enrollment behind a session", async () => {
    const dir = temporaryDir();
    const app = await buildServer(loadConfig({
      serverDir: dir, readDotEnv: false,
      env: { CHURN_STATE_DIR: dir, CHURN_PASSKEY_ORIGIN: origin },
    }));
    try {
      const request = { method: "POST" as const, url: "/api/auth/passkeys/authenticate/options" };
      const headers = { host: "churn.example.com", origin };
      const available = await app.inject("/api/auth/passkeys/available");
      expect(available.json()).toEqual({ origin });

      expect((await app.inject({ ...request, headers: { host: headers.host } })).statusCode).toBe(403);
      expect((await app.inject({
        ...request, headers: { ...headers, origin: "http://churn.example.com" },
      })).statusCode).toBe(403);

      const options = await app.inject({ ...request, headers });
      expect(options.statusCode).toBe(200);
      expect(options.json()).toMatchObject({ rpId: headers.host, userVerification: "required" });
      expect(options.cookies.find(({ value }) => value)?.httpOnly).toBe(true);
      expect(options.cookies.find(({ value }) => value)?.secure).toBe(true);
      expect(options.cookies.find(({ value }) => value)?.sameSite).toBe("Strict");
      expect((await app.inject({
        ...request, url: "/api/auth/passkeys/register/options", headers,
      })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
