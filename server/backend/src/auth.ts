import { createHash, randomBytes } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { CookieSecureSetting } from "./config.js";
import { ApiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE_NAME = "churn_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface AuthUser {
  /** Jellyfin user id. */
  id: string;
  name: string;
  /** Display only; every logged-in user has full dashboard access for now. */
  isAdmin: boolean;
}

export interface AuthContext {
  user: AuthUser;
  accessToken: string;
  /** Raw cookie value, needed only to destroy this session. */
  sessionId: string;
  /** Invalidate this session in the server-side store. */
  destroySession: () => void;
}

export interface SessionRecord {
  /** sha256(cookie value); the raw id is never stored. */
  idHash: string;
  user: AuthUser;
  accessToken: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface CreatedSession {
  cookieValue: string;
  record: SessionRecord;
}

export interface SessionStore {
  readonly ttlMs: number;
  create(user: AuthUser, accessToken: string): CreatedSession;
  get(cookieValue: string): SessionRecord | undefined;
  destroy(cookieValue: string): SessionRecord | undefined;
  destroyAllForUser(userId: string): number;
  size(): number;
  close(): void;
}

interface MemorySessionStoreOptions {
  ttlMs: number;
  now?: () => number;
  sweepIntervalMs?: number;
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw new ApiError(401, "unauthenticated", "Sign in to continue");
  }
  return request.auth;
}

export function expireSession(request: FastifyRequest): void {
  request.auth?.destroySession();
  request.auth = null;
}

export function hashSessionId(cookieValue: string): string {
  return createHash("sha256").update(cookieValue).digest("hex");
}

export function createMemorySessionStore(options: MemorySessionStoreOptions): SessionStore {
  const { ttlMs } = options;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionRecord>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 5 * 60 * 1000;

  const removeExpired = (currentTime: number) => {
    for (const [hash, record] of sessions) {
      if (currentTime - record.lastSeenAt >= ttlMs) {
        sessions.delete(hash);
      }
    }
  };

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => removeExpired(now()), sweepIntervalMs)
      : undefined;
  timer?.unref();

  return {
    ttlMs,

    create(user, accessToken) {
      const cookieValue = randomBytes(32).toString("base64url");
      const currentTime = now();
      const record: SessionRecord = {
        idHash: hashSessionId(cookieValue),
        user,
        accessToken,
        createdAt: currentTime,
        lastSeenAt: currentTime,
      };
      sessions.set(record.idHash, record);
      return { cookieValue, record };
    },

    get(cookieValue) {
      const record = sessions.get(hashSessionId(cookieValue));
      if (!record) {
        return undefined;
      }
      const currentTime = now();
      if (currentTime - record.lastSeenAt >= ttlMs) {
        sessions.delete(record.idHash);
        return undefined;
      }
      record.lastSeenAt = currentTime;
      return record;
    },

    destroy(cookieValue) {
      const hash = hashSessionId(cookieValue);
      const record = sessions.get(hash);
      if (record) {
        sessions.delete(hash);
      }
      return record;
    },

    destroyAllForUser(userId) {
      let removed = 0;
      for (const [hash, record] of sessions) {
        if (record.user.id === userId) {
          sessions.delete(hash);
          removed += 1;
        }
      }
      return removed;
    },

    size() {
      return sessions.size;
    },

    close() {
      if (timer) {
        clearInterval(timer);
      }
      sessions.clear();
    },
  };
}

export function sessionExpiresAt(record: SessionRecord, ttlMs: number): number {
  return record.lastSeenAt + ttlMs;
}

export function shouldUseSecureCookie(
  request: FastifyRequest,
  setting: CookieSecureSetting,
): boolean {
  if (setting !== "auto") {
    return setting;
  }
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.protocol === "https" || forwardedProto?.toLowerCase() === "https";
}

export function sessionCookieOptions(
  request: FastifyRequest,
  setting: CookieSecureSetting,
): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    secure: shouldUseSecureCookie(request, setting),
  };
}

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface LoginThrottle {
  check(key: string): ThrottleDecision;
  recordFailure(key: string): void;
  reset(key: string): void;
}

interface ThrottleEntry {
  failures: number;
  resetAt: number;
}

interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, ThrottleEntry>();

  const activeEntry = (key: string): ThrottleEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (now() >= entry.resetAt) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    check(key) {
      const entry = activeEntry(key);
      if (!entry || entry.failures < maxFailures) {
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)),
      };
    },

    recordFailure(key) {
      const entry = activeEntry(key);
      if (!entry) {
        entries.set(key, { failures: 1, resetAt: now() + windowMs });
        return;
      }
      entry.failures += 1;
    },

    reset(key) {
      entries.delete(key);
    },
  };
}
