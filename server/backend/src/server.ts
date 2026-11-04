import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import {
  createLoginThrottle,
  createMemorySessionStore,
  SESSION_COOKIE_NAME,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import { ApiError, UpstreamError } from "./errors.js";
import { createLibraryScanWatcher } from "./library-scan.js";
import { createMediaCache } from "./media-cache.js";
import { createReleaseSearchService } from "./release-search.js";
import { createReleaseEventStore } from "./release-events.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerMovieRoutes } from "./routes/movies.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerRequestedLibraryRoutes } from "./routes/requested.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerShowRoutes } from "./routes/shows.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerVpnRoutes } from "./routes/vpn.js";

interface BuildServerOptions {
  logger?: boolean;
}

export async function buildServer(
  config: AppConfig,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  mkdirSync(config.stateDir, { recursive: true });
  const sessionStore = createMemorySessionStore({
    ttlMs: config.sessionTtlMs,
    stateDir: config.stateDir,
    onWarning: (message) => app.log.warn(message),
  });
  const loginThrottle = createLoginThrottle();
  const releaseEvents = createReleaseEventStore();
  const cacheDir = resolveReleaseCacheDir(config.serverDir);
  const mediaCache = createMediaCache({ cacheDir: path.join(cacheDir, "media") });
  const releaseSearch = createReleaseSearchService(config, mediaCache, {
    cacheDir: path.join(cacheDir, "prowlarr"),
  });
  const libraryScan = createLibraryScanWatcher(config);
  libraryScan.start();

  app.addHook("onClose", async () => {
    libraryScan.stop();
    await sessionStore.flush();
    sessionStore.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof UpstreamError) {
      return reply
        .code(502)
        .send({ error: { code: "upstream_error", message: error.message } });
    }
    request.log.error({ err: error }, "request failed");
    return reply
      .code(500)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  await app.register(cookie);

  const isPublicApi = (method: string, pathname: string): boolean => {
    if (method === "GET" && pathname === "/api/health") {
      return true;
    }
    if (method === "POST" && pathname === "/api/auth/login") {
      return true;
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      return true;
    }
    if (method === "GET" && pathname === "/api/auth/session") {
      return true;
    }
    if (method === "GET" && pathname === "/api/auth/profiles") {
      return true;
    }
    if (method === "POST" && pathname === "/api/auth/profile-login") {
      return true;
    }
    return false;
  };
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    if (!pathname.startsWith("/api/")) {
      return;
    }

    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      isCrossOriginRequest(request)
    ) {
      reply.header("cache-control", "no-store");
      return reply.code(403).send({
        error: { code: "cross_origin_request", message: "Cross-origin request rejected" },
      });
    }

    if (isPublicApi(request.method, pathname)) {
      return;
    }

    const cookieValue = request.cookies[SESSION_COOKIE_NAME];
    const record = cookieValue ? sessionStore.get(cookieValue) : undefined;
    if (!record || !cookieValue) {
      reply.header("cache-control", "no-store");
      return reply.code(401).send({
        error: { code: "unauthenticated", message: "Sign in to continue" },
      });
    }
    request.auth = {
      user: record.user,
      accessToken: record.accessToken,
      sessionId: cookieValue,
      deviceId: record.deviceId,
      kind: record.kind,
      profileId: record.profileId,
      destroySession: () => sessionStore.destroy(cookieValue),
    };
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, config, { store: sessionStore, throttle: loginThrottle });
  registerProfileRoutes(app, config, { store: sessionStore });
  registerStatusRoutes(app, config);
  registerVpnRoutes(app, config);
  registerLibraryRoutes(app, config, releaseSearch);
  registerPlaybackRoutes(app, config);
  registerRequestedLibraryRoutes(app, config, mediaCache, releaseSearch);
  registerMovieRoutes(app, config, releaseSearch);
  registerSearchRoutes(app, config);
  registerRequestRoutes(app, config, mediaCache, releaseSearch);
  registerActivityRoutes(app, config, releaseEvents);
  registerShowRoutes(app, config, releaseSearch);
  registerServiceRoutes(app, config);

  const hasFrontend = existsSync(path.join(config.frontendDist, "index.html"));
  if (hasFrontend) {
    await app.register(fastifyStatic, {
      root: config.frontendDist,
      wildcard: false,
    });
  } else {
    app.log.warn(`frontend build not found at ${config.frontendDist}; run npm run build`);
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "API route not found" } });
    }
    if (!hasFrontend) {
      return reply.code(503).send({
        error: {
          code: "frontend_not_built",
          message: "Frontend not built. Run npm run build in server/.",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Not found" } });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

/**
 * `server/cache` belongs to the Jellyfin container and can be root-owned on an
 * installed stack. Prefer it, but fall back to a directory the backend user can
 * actually write so cached release searches survive restarts.
 */
function resolveReleaseCacheDir(serverDir: string): string {
  const candidates = [
    path.join(serverDir, "cache", "releases"),
    path.join(serverDir, ".churn-cache", "releases"),
    path.join(tmpdir(), "churn-releases"),
  ];
  for (const directory of candidates) {
    try {
      mkdirSync(directory, { recursive: true });
      accessSync(directory, constants.W_OK);
      return directory;
    } catch {
      // Try the next writable location.
    }
  }
  return path.join(tmpdir(), "churn-releases");
}

function isCrossOriginRequest(request: {
  headers: {
    origin?: string;
    "sec-fetch-site"?: string;
    host?: string;
    "x-forwarded-host"?: string;
    forwarded?: string;
  };
}): boolean {
  const origin = request.headers.origin;
  if (origin) {
    try {
      return !requestHosts(request).includes(new URL(origin).host);
    } catch {
      return true;
    }
  }
  const fetchSite = request.headers["sec-fetch-site"];
  return typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none";
}

/** Hosts the browser may have used, including the reverse-proxy public host. */
function requestHosts(request: {
  headers: { host?: string; "x-forwarded-host"?: string; forwarded?: string };
}): string[] {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const host = value?.split(",")[0]?.trim();
    if (host) {
      hosts.add(host);
    }
  };
  if (request.headers.host) {
    add(request.headers.host);
  }
  if (typeof request.headers["x-forwarded-host"] === "string") {
    add(request.headers["x-forwarded-host"]);
  }
  const forwarded = request.headers.forwarded;
  if (typeof forwarded === "string") {
    const match = forwarded.match(/(?:^|;)\s*host="?([^";,]+)"?/i);
    if (match?.[1]) {
      add(match[1]);
    }
  }
  return [...hosts];
}
