import "@fastify/cookie";

import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionExpiresAt,
  type AuthUser,
  type LoginThrottle,
  type SessionStore,
} from "../auth.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import { createJellyfinClient } from "../upstream/jellyfin.js";

export interface AuthDependencies {
  store: SessionStore;
  throttle: LoginThrottle;
}

interface LoginBody {
  username: string;
  password: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: AuthDependencies,
): void {
  app.post<{ Body: unknown }>("/api/auth/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = parseLoginBody(request.body);
    const throttleKey = `${request.ip}|${body.username.toLowerCase()}`;
    const decision = deps.throttle.check(throttleKey);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds ?? 60));
      throw new ApiError(429, "too_many_attempts", "Too many sign-in attempts. Try again later.");
    }

    const service = config.services.jellyfin;
    const client = createJellyfinClient(service, config.requestTimeoutMs);
    let result;
    try {
      result = await client.authenticate(body.username, body.password);
    } catch (error) {
      if (isUnauthorized(error)) {
        deps.throttle.recordFailure(throttleKey);
        throw new ApiError(401, "invalid_credentials", "Invalid username or password");
      }
      if (error instanceof UpstreamError) {
        throw new ApiError(502, "jellyfin_unreachable", error.message);
      }
      throw error;
    }

    const user = mapAuthUser(result.User);
    if (!user || !result.AccessToken) {
      throw new ApiError(
        502,
        "jellyfin_invalid_response",
        "Jellyfin did not return a usable user session",
      );
    }

    deps.throttle.reset(throttleKey);
    const { cookieValue, record } = deps.store.create(user, result.AccessToken);
    reply.setCookie(
      SESSION_COOKIE_NAME,
      cookieValue,
      sessionCookieOptions(request, config.cookieSecure),
    );
    return {
      authenticated: true,
      user,
      expiresAt: new Date(sessionExpiresAt(record, config.sessionTtlMs)).toISOString(),
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const cookieValue = request.cookies[SESSION_COOKIE_NAME];
    const record = cookieValue ? deps.store.destroy(cookieValue) : undefined;
    reply.clearCookie(SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieOptions(request, config.cookieSecure).secure,
    });

    if (record) {
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        record.accessToken,
      );
      try {
        await client.logout(record.accessToken);
      } catch {
        // Signing out of Churn must not depend on Jellyfin being reachable.
      }
    }
    return reply.code(204).send();
  });

  app.get("/api/auth/session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const cookieValue = request.cookies[SESSION_COOKIE_NAME];
    const record = cookieValue ? deps.store.get(cookieValue) : undefined;
    if (!record) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      user: record.user,
      expiresAt: new Date(sessionExpiresAt(record, config.sessionTtlMs)).toISOString(),
    };
  });
}

function parseLoginBody(body: unknown): LoginBody {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "invalid_request", "Username and password are required");
  }
  const record = body as Record<string, unknown>;
  const username = typeof record.username === "string" ? record.username.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!username || !password) {
    throw new ApiError(400, "invalid_request", "Username and password are required");
  }
  if (username.length > 64) {
    throw new ApiError(400, "invalid_request", "Username is too long");
  }
  if (password.length > 1024) {
    throw new ApiError(400, "invalid_request", "Password is too long");
  }
  return { username, password };
}

function mapAuthUser(user: { Id?: string; Name?: string; Policy?: { IsAdministrator?: boolean } } | undefined): AuthUser | undefined {
  if (!user?.Id || !user.Name) {
    return undefined;
  }
  return {
    id: user.Id,
    name: user.Name,
    isAdmin: user.Policy?.IsAdministrator === true,
  };
}
