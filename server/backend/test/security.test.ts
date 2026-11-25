import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const origin = "https://churn.example.com";
const passkeyHeaders = { host: "churn.example.com", origin };
const temporaryDirs: string[] = [];

function temporaryDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "churn-security-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function buildTestServer() {
  const dir = temporaryDir();
  return buildServer(loadConfig({
    serverDir: dir,
    readDotEnv: false,
    env: { CHURN_STATE_DIR: dir, CHURN_PASSKEY_ORIGIN: origin },
  }));
}

describe("funnel hardening", () => {
  it("trusts forwarded client addresses only from loopback", async () => {
    const app = await buildTestServer();
    let seen: string | undefined;
    app.addHook("onRequest", async (request) => {
      seen = request.ip;
    });

    await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(seen).toBe("203.0.113.5");

    await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "192.0.2.9",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(seen).toBe("192.0.2.9");
    await app.close();
  });

  it("sends security headers on every response and HSTS only over https", async () => {
    const app = await buildTestServer();
    const plain = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "127.0.0.1" });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(plain.headers["x-content-type-options"]).toBe("nosniff");
    expect(plain.headers["referrer-policy"]).toBe("no-referrer");
    expect(plain.headers["x-frame-options"]).toBe("DENY");
    expect(plain.headers["strict-transport-security"]).toBeUndefined();

    const secure = await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(secure.headers["strict-transport-security"]).toBe("max-age=31536000");

    const spoofed = await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "192.0.2.9",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(spoofed.headers["strict-transport-security"]).toBeUndefined();
    await app.close();
  });

  it("caps passkey challenges per client without blocking other clients", async () => {
    const app = await buildTestServer();
    const request = { method: "POST" as const, url: "/api/auth/passkeys/authenticate/options", headers: passkeyHeaders };
    for (let index = 0; index < 16; index += 1) {
      const options = await app.inject(request);
      expect(options.statusCode).toBe(200);
    }
    const blocked = await app.inject(request);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("too_many_challenges");

    const other = await app.inject({
      ...request,
      remoteAddress: "127.0.0.1",
      headers: { ...passkeyHeaders, "x-forwarded-for": "198.51.100.7" },
    });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it("does not charge the throttle when a passkey challenge is missing", async () => {
    const app = await buildTestServer();
    const verify = {
      method: "POST" as const,
      url: "/api/auth/passkeys/authenticate/verify",
      headers: passkeyHeaders,
      payload: {},
    };
    for (let index = 0; index < 12; index += 1) {
      const rejected = await app.inject(verify);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("passkey_rejected");
    }
    const options = await app.inject({
      method: "POST",
      url: "/api/auth/passkeys/authenticate/options",
      headers: passkeyHeaders,
    });
    expect(options.statusCode).toBe(200);
    await app.close();
  });
});