import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
  /** Jellyfin administrator flag; gates profile management in Churn. */
  isAdmin: boolean;
}

export type AuthSessionKind = "admin" | "profile" | "direct";

/** A household member managed by Churn. */
export interface ProfileRecord {
  id: string;
  /** Jellyfin username; also the display name in Churn. */
  name: string;
  jellyfinUserId: string;
  /** One-time PIN, cleared once the person sets their own password. */
  initialPin: string | null;
  createdAt: number;
}

export interface AuthContext {
  user: AuthUser;
  accessToken: string;
  /** Raw cookie value, needed only to destroy this session. */
  sessionId: string;
  /** Unique per Churn session so Jellyfin never revokes another login. */
  deviceId: string;
  kind: AuthSessionKind;
  profileId?: string;
  /** Invalidate this session in the server-side store. */
  destroySession: () => void;
}

export interface SessionRecord {
  /** sha256(cookie value); the raw id is never stored. */
  idHash: string;
  user: AuthUser;
  accessToken: string;
  /** Jellyfin device id used by every request for this session. */
  deviceId: string;
  kind: AuthSessionKind;
  profileId?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface CreatedSession {
  cookieValue: string;
  record: SessionRecord;
}

export interface SessionCreateOptions {
  kind?: AuthSessionKind;
  profileId?: string;
  deviceId?: string;
}

export interface SessionStore {
  readonly ttlMs: number;
  create(
    user: AuthUser,
    accessToken: string,
    options?: SessionCreateOptions,
  ): CreatedSession;
  get(cookieValue: string): SessionRecord | undefined;
  destroy(cookieValue: string): SessionRecord | undefined;
  destroyAllForUser(userId: string): number;
  destroyAllForProfile(profileId: string): number;
  size(): number;
  listProfiles(): ProfileRecord[];
  getProfile(id: string): ProfileRecord | undefined;
  getProfileByName(name: string): ProfileRecord | undefined;
  createProfile(input: {
    name: string;
    jellyfinUserId: string;
    initialPin: string;
  }): ProfileRecord;
  setProfilePin(id: string, pin: string): ProfileRecord | undefined;
  markPasswordSet(id: string): ProfileRecord | undefined;
  deleteProfile(id: string): ProfileRecord | undefined;
  /** Persist the current state; a no-op when persistence is disabled. */
  flush(): Promise<void>;
  close(): void;
}

interface MemorySessionStoreOptions {
  ttlMs: number;
  /** Persist profiles and sessions under this directory. */
  stateDir?: string;
  now?: () => number;
  sweepIntervalMs?: number;
  flushDebounceMs?: number;
  touchFlushIntervalMs?: number;
  onWarning?: (message: string) => void;
}

const AUTH_STATE_VERSION = 1;
const AUTH_STATE_FILENAME = "auth-state.json";
const DEFAULT_FLUSH_DEBOUNCE_MS = 1_000;
const DEFAULT_TOUCH_FLUSH_INTERVAL_MS = 60_000;

export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

interface PersistedAuthState {
  version: number;
  profiles: ProfileRecord[];
  sessions: SessionRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAuthUser(value: unknown): AuthUser | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.isAdmin !== "boolean"
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, isAdmin: value.isAdmin };
}

function parseProfileRecord(value: unknown): ProfileRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.jellyfinUserId !== "string" ||
    typeof value.createdAt !== "number"
  ) {
    return undefined;
  }
  const initialPin =
    value.initialPin === null
      ? null
      : typeof value.initialPin === "string"
        ? value.initialPin
        : undefined;
  if (initialPin === undefined) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    jellyfinUserId: value.jellyfinUserId,
    initialPin,
    createdAt: value.createdAt,
  };
}

function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.idHash !== "string" ||
    typeof value.accessToken !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.lastSeenAt !== "number" ||
    (value.kind !== "admin" && value.kind !== "profile" && value.kind !== "direct")
  ) {
    return undefined;
  }
  const user = parseAuthUser(value.user);
  if (!user) {
    return undefined;
  }
  if (value.profileId !== undefined && typeof value.profileId !== "string") {
    return undefined;
  }
  return {
    idHash: value.idHash,
    user,
    accessToken: value.accessToken,
    deviceId: value.deviceId,
    kind: value.kind,
    profileId: value.profileId,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
  };
}

function parsePersistedAuthState(
  value: unknown,
): { profiles: ProfileRecord[]; sessions: SessionRecord[] } | undefined {
  if (!isRecord(value) || value.version !== AUTH_STATE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value.profiles) || !Array.isArray(value.sessions)) {
    return undefined;
  }
  const profiles = value.profiles
    .map(parseProfileRecord)
    .filter((profile): profile is ProfileRecord => profile !== undefined);
  const sessions = value.sessions
    .map(parseSessionRecord)
    .filter((session): session is SessionRecord => session !== undefined);
  return { profiles, sessions };
}

async function writeAuthState(
  filePath: string,
  state: PersistedAuthState,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw new ApiError(401, "unauthenticated", "Sign in to continue");
  }
  return request.auth;
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (!auth.user.isAdmin) {
    throw new ApiError(403, "forbidden", "Administrator access is required");
  }
  return auth;
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
  const profiles = new Map<string, ProfileRecord>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 5 * 60 * 1000;
  const flushDebounceMs = options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
  const touchFlushIntervalMs =
    options.touchFlushIntervalMs ?? DEFAULT_TOUCH_FLUSH_INTERVAL_MS;
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const stateFile = options.stateDir
    ? path.join(options.stateDir, AUTH_STATE_FILENAME)
    : undefined;

  let flushTimer: NodeJS.Timeout | undefined;
  let lastTouchFlushAt = now();
  let writeChain: Promise<void> = Promise.resolve();

  function removeExpired(currentTime: number): boolean {
    let removed = false;
    for (const [hash, record] of sessions) {
      if (currentTime - record.lastSeenAt >= ttlMs) {
        sessions.delete(hash);
        removed = true;
      }
    }
    return removed;
  }

  function serializeState(): PersistedAuthState {
    return {
      version: AUTH_STATE_VERSION,
      profiles: [...profiles.values()],
      sessions: [...sessions.values()],
    };
  }

  function loadPersistedState(): boolean {
    if (!stateFile) {
      return false;
    }
    let raw: string;
    try {
      raw = readFileSync(stateFile, "utf8");
    } catch {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warn(`churn: ignoring unreadable auth state at ${stateFile}`);
      return false;
    }
    const state = parsePersistedAuthState(parsed);
    if (!state) {
      warn(`churn: ignoring unsupported auth state at ${stateFile}`);
      return false;
    }

    for (const profile of state.profiles) {
      profiles.set(profile.id, profile);
    }
    let pruned = false;
    const currentTime = now();
    for (const session of state.sessions) {
      if (currentTime - session.lastSeenAt >= ttlMs) {
        pruned = true;
        continue;
      }
      if (
        session.kind === "profile" &&
        (!session.profileId || !profiles.has(session.profileId))
      ) {
        pruned = true;
        continue;
      }
      sessions.set(session.idHash, session);
    }
    return pruned;
  }

  function scheduleFlush(delayMs = flushDebounceMs): void {
    if (!stateFile || flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, delayMs);
    flushTimer.unref?.();
  }

  async function flush(): Promise<void> {
    if (!stateFile) {
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const snapshot = serializeState();
    writeChain = writeChain
      .then(() => writeAuthState(stateFile, snapshot))
      .catch((error: unknown) => {
        warn(
          `churn: could not persist auth state to ${stateFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return writeChain;
  }

  const pruneNeeded = loadPersistedState();

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          if (removeExpired(now())) {
            scheduleFlush();
          }
        }, sweepIntervalMs)
      : undefined;
  timer?.unref();
  if (pruneNeeded) {
    scheduleFlush(0);
  }

  return {
    ttlMs,

    create(user, accessToken, createOptions = {}) {
      const cookieValue = randomBytes(32).toString("base64url");
      const currentTime = now();
      const record: SessionRecord = {
        idHash: hashSessionId(cookieValue),
        user,
        accessToken,
        deviceId: createOptions.deviceId ?? randomUUID(),
        kind: createOptions.kind ?? "direct",
        profileId: createOptions.profileId,
        createdAt: currentTime,
        lastSeenAt: currentTime,
      };
      sessions.set(record.idHash, record);
      scheduleFlush();
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
        scheduleFlush();
        return undefined;
      }
      record.lastSeenAt = currentTime;
      if (currentTime - lastTouchFlushAt >= touchFlushIntervalMs) {
        lastTouchFlushAt = currentTime;
        scheduleFlush();
      }
      return record;
    },

    destroy(cookieValue) {
      const hash = hashSessionId(cookieValue);
      const record = sessions.get(hash);
      if (record) {
        sessions.delete(hash);
        scheduleFlush();
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
      if (removed > 0) {
        scheduleFlush();
      }
      return removed;
    },

    destroyAllForProfile(profileId) {
      let removed = 0;
      for (const [hash, record] of sessions) {
        if (record.profileId === profileId) {
          sessions.delete(hash);
          removed += 1;
        }
      }
      if (removed > 0) {
        scheduleFlush();
      }
      return removed;
    },

    size() {
      return sessions.size;
    },

    listProfiles() {
      return [...profiles.values()];
    },

    getProfile(id) {
      return profiles.get(id);
    },

    getProfileByName(name) {
      const normalized = name.trim().toLowerCase();
      for (const profile of profiles.values()) {
        if (profile.name.trim().toLowerCase() === normalized) {
          return profile;
        }
      }
      return undefined;
    },

    createProfile(input) {
      const profile: ProfileRecord = {
        id: randomUUID(),
        name: input.name,
        jellyfinUserId: input.jellyfinUserId,
        initialPin: input.initialPin,
        createdAt: now(),
      };
      profiles.set(profile.id, profile);
      scheduleFlush();
      return profile;
    },

    setProfilePin(id, pin) {
      const profile = profiles.get(id);
      if (!profile) {
        return undefined;
      }
      profile.initialPin = pin;
      scheduleFlush();
      return profile;
    },

    markPasswordSet(id) {
      const profile = profiles.get(id);
      if (!profile) {
        return undefined;
      }
      profile.initialPin = null;
      scheduleFlush();
      return profile;
    },

    deleteProfile(id) {
      const profile = profiles.get(id);
      if (!profile) {
        return undefined;
      }
      profiles.delete(id);
      for (const [hash, session] of sessions) {
        if (session.profileId === id) {
          sessions.delete(hash);
        }
      }
      scheduleFlush();
      return profile;
    },

    flush,

    close() {
      if (timer) {
        clearInterval(timer);
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      void flush();
      sessions.clear();
      profiles.clear();
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
