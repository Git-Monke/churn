import "@fastify/cookie";

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionExpiresAt,
  type AuthSessionKind,
  type AuthUser,
  type LoginThrottle,
  type ProfileRecord,
  type SessionRecord,
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

interface ProfileLoginBody {
  profileId: string;
  password: string;
  newPassword?: string;
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
    const deviceId = randomUUID();
    const client = createJellyfinClient(
      service,
      config.requestTimeoutMs,
      undefined,
      { deviceId },
    );
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
    const kind: AuthSessionKind = user.isAdmin ? "admin" : "direct";
    const { cookieValue, record } = deps.store.create(user, result.AccessToken, {
      kind,
      deviceId,
    });
    setSessionCookie(reply, request, config, cookieValue);
    return sessionPayload(config, user, kind, record);
  });

  app.get("/api/auth/profiles", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return deps.store.listProfiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      passwordSet: profile.initialPin === null,
    }));
  });

  app.post<{ Body: unknown }>("/api/auth/profile-login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = parseProfileLoginBody(request.body);
    const throttleKey = `profile:${request.ip}|${body.profileId}`;
    const decision = deps.throttle.check(throttleKey);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds ?? 60));
      throw new ApiError(429, "too_many_attempts", "Too many sign-in attempts. Try again later.");
    }

    const profile = deps.store.getProfile(body.profileId);
    if (!profile) {
      throw new ApiError(404, "profile_not_found", "Person not found");
    }

    const service = config.services.jellyfin;
    const deviceId = randomUUID();
    const client = createJellyfinClient(
      config.services.jellyfin,
      config.requestTimeoutMs,
      undefined,
      { deviceId },
    );

    let result;
    try {
      result = await client.authenticate(profile.name, body.password);
    } catch (error) {
      if (isUnauthorized(error)) {
        deps.throttle.recordFailure(throttleKey);
        throw new ApiError(401, "invalid_credentials", "Invalid name or password");
      }
      if (error instanceof UpstreamError) {
        throw new ApiError(502, "jellyfin_unreachable", error.message);
      }
      throw error;
    }
    if (!result.AccessToken) {
      throw new ApiError(
        502,
        "jellyfin_invalid_response",
        "Jellyfin did not return a usable user session",
      );
    }

    const pendingPin = profile.initialPin !== null;
    if (pendingPin && body.newPassword === undefined) {
      await bestEffortLogout(service, config.requestTimeoutMs, result.AccessToken, deviceId);
      deps.throttle.reset(throttleKey);
      return { passwordSetupRequired: true, profile: publicProfile(profile) };
    }
    if (!pendingPin && body.newPassword !== undefined) {
      throw new ApiError(
        400,
        "password_already_set",
        "This person already has a password",
      );
    }

    let accessToken = result.AccessToken;
    if (pendingPin && body.newPassword !== undefined) {
      if (body.newPassword === body.password) {
        throw new ApiError(
          400,
          "invalid_password",
          "Choose a password different from the PIN",
        );
      }
      const userClient = createJellyfinClient(
        service,
        config.requestTimeoutMs,
        accessToken,
        { deviceId },
      );
      try {
        await userClient.setUserPassword(profile.jellyfinUserId, body.newPassword, {
          currentPassword: body.password,
        });
      } catch (error) {
        if (isUnauthorized(error)) {
          deps.throttle.recordFailure(throttleKey);
          throw new ApiError(401, "invalid_credentials", "Invalid name or password");
        }
        if (error instanceof UpstreamError) {
          throw new ApiError(502, "jellyfin_password_failed", error.message);
        }
        throw error;
      }
      await bestEffortLogout(service, config.requestTimeoutMs, accessToken, deviceId);
      try {
        result = await client.authenticate(profile.name, body.newPassword);
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw new ApiError(502, "jellyfin_password_failed", error.message);
        }
        throw error;
      }
      if (!result.AccessToken) {
        throw new ApiError(
          502,
          "jellyfin_invalid_response",
          "Jellyfin returned no token after the password change",
        );
      }
      accessToken = result.AccessToken;
      deps.store.markPasswordSet(profile.id);
    }

    deps.throttle.reset(throttleKey);
    const user: AuthUser = {
      id: profile.jellyfinUserId,
      name: profile.name,
      isAdmin: false,
    };
    const session = deps.store.create(user, accessToken, {
      kind: "profile",
      profileId: profile.id,
      deviceId,
    });
    setSessionCookie(reply, request, config, session.cookieValue);
    return sessionPayload(config, user, "profile", session.record, profile.id);
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
        { deviceId: record.deviceId },
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
    return sessionPayload(
      config,
      record.user,
      record.kind,
      record,
      record.profileId,
    );
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

function parseProfileLoginBody(body: unknown): ProfileLoginBody {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "invalid_request", "Person and password are required");
  }
  const record = body as Record<string, unknown>;
  const profileId = typeof record.profileId === "string" ? record.profileId.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!profileId || !password) {
    throw new ApiError(400, "invalid_request", "Person and password are required");
  }
  if (profileId.length > 64) {
    throw new ApiError(400, "invalid_request", "Invalid person");
  }
  if (password.length > 1024) {
    throw new ApiError(400, "invalid_request", "Password is too long");
  }
  if (record.newPassword === undefined) {
    return { profileId, password };
  }
  if (typeof record.newPassword !== "string" || record.newPassword.length < 8) {
    throw new ApiError(400, "invalid_password", "Use at least 8 characters for the new password");
  }
  if (record.newPassword.length > 1024) {
    throw new ApiError(400, "invalid_password", "Password is too long");
  }
  return { profileId, password, newPassword: record.newPassword };
}

function publicProfile(profile: ProfileRecord): {
  id: string;
  name: string;
  passwordSet: boolean;
} {
  return {
    id: profile.id,
    name: profile.name,
    passwordSet: profile.initialPin === null,
  };
}

function setSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  config: AppConfig,
  cookieValue: string,
): void {
  reply.setCookie(
    SESSION_COOKIE_NAME,
    cookieValue,
    sessionCookieOptions(request, config.cookieSecure),
  );
}

function sessionPayload(
  config: AppConfig,
  user: AuthUser,
  kind: AuthSessionKind,
  record: SessionRecord,
  profileId?: string,
): {
  authenticated: true;
  user: AuthUser;
  kind: AuthSessionKind;
  profileId?: string;
  expiresAt: string;
} {
  return {
    authenticated: true,
    user,
    kind,
    ...(profileId ? { profileId } : {}),
    expiresAt: new Date(sessionExpiresAt(record, config.sessionTtlMs)).toISOString(),
  };
}

async function bestEffortLogout(
  service: AppConfig["services"]["jellyfin"],
  timeoutMs: number,
  accessToken: string,
  deviceId: string,
): Promise<void> {
  try {
    await createJellyfinClient(service, timeoutMs, accessToken, { deviceId }).logout(
      accessToken,
    );
  } catch {
    // Signing out of the probe session is best-effort.
  }
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
