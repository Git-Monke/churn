import "@fastify/cookie";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import {
  requireAuth,
  type AuthContext,
  type AuthSessionKind,
  type AuthUser,
  type LoginThrottle,
  type SessionStore,
} from "../auth.js";
import type { AppConfig } from "../config.js";
import { ApiError, isUnauthorized } from "../errors.js";
import type { PasskeyRecord, PasskeyStore } from "../passkey-store.js";
import { createJellyfinClient } from "../upstream/jellyfin.js";
import { mapAuthUser, sessionPayload, setSessionCookie } from "./auth.js";
import type { PasskeyAvailabilityResponse, SavedPasskey } from "../types.js";

const TTL = 5 * 60_000;
const MAX_CHALLENGES = 256;
const MAX_KEYS = 20;

interface PendingRegistration {
  label: string;
  user: AuthUser;
  profileId?: string;
  deviceId: string;
  accessToken: string;
}

interface Challenge {
  expected: string;
  expiresAt: number;
  registration?: PendingRegistration;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Invalid passkey response.");
  }
  return value as Record<string, unknown>;
}

/**
 * WebAuthn user handle. Profile passkeys get their own handle so two people
 * sharing a Jellyfin account stay separate credentials on the authenticator.
 */
export function passkeyHandle(origin: string, userId: string, profileId?: string) {
  const scope = profileId ? `${userId}\0${profileId}` : userId;
  return createHash("sha256").update(origin).update("\0").update(scope).digest();
}

function publicKey(record: PasskeyRecord): SavedPasskey {
  return {
    id: record.id, label: record.label, createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function rejected() {
  return new ApiError(400, "passkey_rejected", "The passkey could not be verified. Try again or use your password.");
}

export function registerPasskeyRoutes(
  app: FastifyInstance,
  config: AppConfig,
  store: PasskeyStore,
  sessions: SessionStore,
  throttle: LoginThrottle,
) {
  const origin = config.passkeyOrigin;
  const challenges = new Map<string, Challenge>();

  function client(token?: string, deviceId?: string) {
    return createJellyfinClient(config.services.jellyfin, config.requestTimeoutMs, token, { deviceId });
  }

  async function revoke(registration: Pick<PendingRegistration, "accessToken" | "deviceId">) {
    try {
      await client(registration.accessToken, registration.deviceId).logout(registration.accessToken);
    } catch {
      // Churn's credential and sessions are already gone.
    }
  }

  function cleanExpired() {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt > Date.now()) continue;
      challenges.delete(id);
      if (challenge.registration) void revoke(challenge.registration);
    }
  }

  const timer = origin ? setInterval(cleanExpired, 30_000) : undefined;
  timer?.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    const pending = [...challenges.values()];
    challenges.clear();
    await Promise.all(pending.flatMap(({ registration }) => registration ? [revoke(registration)] : []));
  });

  function requireOrigin(request: FastifyRequest, reply: FastifyReply): string {
    reply.header("cache-control", "no-store");
    if (!origin || request.headers.origin !== origin) {
      throw new ApiError(403, "passkey_origin", "Open Churn at its configured HTTPS address to use passkeys.");
    }
    return origin;
  }

  function ensureRoom() {
    cleanExpired();
    if (challenges.size >= MAX_CHALLENGES) {
      throw new ApiError(429, "too_many_challenges", "Too many passkey attempts. Try again shortly.");
    }
  }

  function limit(key: string, reply: FastifyReply) {
    const decision = throttle.check(key);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds ?? 60));
      throw new ApiError(429, "too_many_attempts", "Too many attempts. Try again later.");
    }
  }

  function cookieName(registering: boolean) {
    return registering ? "churn_passkey_registration" : "churn_passkey_authentication";
  }

  function take(request: FastifyRequest, reply: FastifyReply, registering: boolean) {
    const name = cookieName(registering);
    const id = request.cookies[name];
    reply.clearCookie(name, { path: "/api/auth/passkeys" });
    if (!id) return;
    const challenge = challenges.get(id);
    if (!challenge || !!challenge.registration !== registering) return;
    challenges.delete(id);
    if (challenge.expiresAt > Date.now()) return challenge;
    if (challenge.registration) void revoke(challenge.registration);
  }

  function issue(reply: FastifyReply, expected: string, registration?: PendingRegistration) {
    ensureRoom();
    const id = randomUUID();
    challenges.set(id, { expected, registration, expiresAt: Date.now() + TTL });
    reply.setCookie(cookieName(!!registration), id, {
      httpOnly: true, sameSite: "strict", secure: origin?.startsWith("https:"),
      path: "/api/auth/passkeys", maxAge: TTL / 1000,
    });
  }

  function checkProfile(auth: Pick<AuthContext, "profileId">, userId: string) {
    if (!auth.profileId) return undefined;
    const profile = sessions.getProfile(auth.profileId);
    if (!profile || profile.initialPin !== null || profile.jellyfinUserId !== userId) {
      throw new ApiError(403, "passkey_profile", "Sign in with your password to continue.");
    }
    return profile;
  }

  function enrollableProfile(profileId: string) {
    const profile = sessions.getProfile(profileId);
    if (!profile) throw new ApiError(404, "profile_not_found", "Person not found");
    if (profile.initialPin !== null) {
      throw new ApiError(
        403,
        "passkey_profile",
        "Set a password for this person before adding a passkey.",
      );
    }
    return profile;
  }

  async function remove(records: PasskeyRecord[]) {
    store.remove(records);
    for (const record of records) sessions.destroyAllForPasskey(record.id);
    await sessions.flush();
    await Promise.all(records.map(revoke));
  }

  app.get("/api/auth/passkeys/available", async (_request, reply): Promise<PasskeyAvailabilityResponse> => {
    reply.header("cache-control", "no-store");
    return { origin: origin ?? null };
  });

  app.get("/api/auth/passkeys", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = requireAuth(request);
    return store
      .list(auth.user.id)
      .filter((record) => record.origin === origin && record.profileId === auth.profileId)
      .map(publicKey);
  });

  app.post("/api/auth/passkeys/register/options", async (request, reply) => {
    const expectedOrigin = requireOrigin(request, reply);
    const { profileId, username, password, label } = jsonObject(request.body);
    if (typeof password !== "string" || !password || password.length > 1024 ||
        typeof label !== "string" || !label.trim() || label.trim().length > 50 ||
        (typeof profileId === "string") === (typeof username === "string")) {
      throw new ApiError(400, "invalid_request", "Enter your password and a name for the passkey.");
    }
    const accountName = typeof profileId === "string" ? "" : (username as string).trim();
    if (!accountName && typeof profileId !== "string") {
      throw new ApiError(400, "invalid_request", "Enter your username.");
    }
    const key = `passkey-register:${request.ip}|${typeof profileId === "string" ? profileId : accountName.toLowerCase()}`;
    limit(key, reply);
    const profile = typeof profileId === "string" ? enrollableProfile(profileId) : undefined;
    ensureRoom();
    const previous = take(request, reply, true);
    if (previous?.registration) void revoke(previous.registration);

    const deviceId = randomUUID();
    let accessToken: string | undefined;
    try {
      const authenticated = await client(undefined, deviceId).authenticate(
        profile ? profile.name : accountName,
        password,
      );
      accessToken = authenticated.AccessToken;
      const user = mapAuthUser(authenticated.User);
      if (!accessToken || !user || authenticated.User?.Policy?.IsDisabled ||
          (profile && user.id !== profile.jellyfinUserId)) {
        throw rejected();
      }
      const registered = store.list(user.id);
      if (registered.length >= MAX_KEYS) {
        throw new ApiError(409, "passkey_limit", "Remove an existing passkey before adding another.");
      }
      const options = await generateRegistrationOptions({
        rpName: "Churn",
        rpID: new URL(expectedOrigin).hostname,
        userName: profile ? `${user.name} / ${profile.name}` : user.name,
        userDisplayName: profile ? profile.name : user.name,
        userID: passkeyHandle(expectedOrigin, user.id, profile?.id),
        timeout: TTL,
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: registered
          .filter((record) => record.origin === origin && record.profileId === profile?.id)
          .map(({ id }) => ({ id })),
      });
      issue(reply, options.challenge, {
        label: label.trim(), user, profileId: profile?.id, deviceId, accessToken,
      });
      throttle.reset(key);
      return options;
    } catch (error) {
      if (accessToken) void revoke({ accessToken, deviceId });
      if (isUnauthorized(error)) {
        throttle.recordFailure(key);
        throw new ApiError(403, "invalid_password", "The Jellyfin password was incorrect.");
      }
      throw error;
    }
  });

  app.post("/api/auth/passkeys/register/cancel", async (request, reply) => {
    requireOrigin(request, reply);
    const challenge = take(request, reply, true);
    if (challenge?.registration) void revoke(challenge.registration);
    return reply.code(204).send();
  });

  app.post("/api/auth/passkeys/register/verify", async (request, reply) => {
    const expectedOrigin = requireOrigin(request, reply);
    const challenge = take(request, reply, true);
    const pending = challenge?.registration;
    if (!challenge || !pending) throw rejected();
    let saved = false;
    try {
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: jsonObject(request.body) as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge.expected,
          expectedOrigin,
          expectedRPID: new URL(expectedOrigin).hostname,
          requireUserVerification: true,
        });
      } catch {
        throw rejected();
      }
      if (!result.verified) throw rejected();
      if (pending.profileId) enrollableProfile(pending.profileId);
      if (store.list(pending.user.id).length >= MAX_KEYS) throw rejected();
      const credential = result.registrationInfo.credential;
      const record: PasskeyRecord = {
        id: credential.id, origin: expectedOrigin,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter, userId: pending.user.id, profileId: pending.profileId,
        accessToken: pending.accessToken, deviceId: pending.deviceId, label: pending.label,
        createdAt: new Date().toISOString(),
      };
      saved = store.add(record);
      if (!saved) throw rejected();
      const kind: AuthSessionKind = pending.profileId
        ? "profile"
        : pending.user.isAdmin ? "admin" : "direct";
      const session = sessions.create(pending.user, pending.accessToken, {
        kind, profileId: pending.profileId, deviceId: pending.deviceId, passkeyId: record.id,
      });
      setSessionCookie(reply, request, config, session.cookieValue);
      return sessionPayload(config, pending.user, kind, session.record, pending.profileId);
    } finally {
      if (!saved) void revoke(pending);
    }
  });

  app.post("/api/auth/passkeys/authenticate/options", async (request, reply) => {
    const expectedOrigin = requireOrigin(request, reply);
    limit(`passkey-auth:${request.ip}`, reply);
    take(request, reply, false);
    const options = await generateAuthenticationOptions({
      rpID: new URL(expectedOrigin).hostname, userVerification: "required", timeout: TTL,
    });
    issue(reply, options.challenge);
    return options;
  });

  app.post("/api/auth/passkeys/authenticate/verify", async (request, reply) => {
    const expectedOrigin = requireOrigin(request, reply);
    const key = `passkey-auth:${request.ip}`;
    limit(key, reply);
    const challenge = take(request, reply, false);
    const response = jsonObject(request.body) as unknown as AuthenticationResponseJSON;
    const record = store.get(response.id);
    if (!challenge || !record || record.origin !== expectedOrigin ||
        response.response?.userHandle !== passkeyHandle(expectedOrigin, record.userId, record.profileId).toString("base64url")) {
      throttle.recordFailure(key);
      throw rejected();
    }

    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge.expected, expectedOrigin,
        expectedRPID: new URL(expectedOrigin).hostname,
        credential: { id: record.id, publicKey: Buffer.from(record.publicKey, "base64url"), counter: record.counter },
        requireUserVerification: true,
      });
    } catch {
      throttle.recordFailure(key);
      throw rejected();
    }
    if (!result.verified) {
      throttle.recordFailure(key);
      throw rejected();
    }

    checkProfile(record, record.userId);
    let jellyfinUser;
    try {
      jellyfinUser = await client(record.accessToken, record.deviceId).currentUser();
    } catch (error) {
      if (isUnauthorized(error)) {
        throw new ApiError(403, "passkey_jellyfin_expired", "Jellyfin revoked this sign-in. Use your password and add a new passkey.");
      }
      throw new ApiError(502, "jellyfin_unreachable", "Jellyfin could not validate your sign-in. Try again shortly.");
    }
    const jellyfinAccount = mapAuthUser(jellyfinUser);
    if (!jellyfinAccount || jellyfinAccount.id !== record.userId || jellyfinUser.Policy?.IsDisabled) {
      throw rejected();
    }
    checkProfile(record, record.userId);
    if (!store.update(record, result.authenticationInfo.newCounter)) throw rejected();

    throttle.reset(key);
    const profileId = record.profileId;
    const user = profileId ? { ...jellyfinAccount, isAdmin: false } : jellyfinAccount;
    const kind = profileId ? "profile" : user.isAdmin ? "admin" : "direct";
    const session = sessions.create(user, record.accessToken, {
      kind, profileId, deviceId: record.deviceId, passkeyId: record.id,
    });
    setSessionCookie(reply, request, config, session.cookieValue);
    return sessionPayload(config, user, kind, session.record, profileId);
  });

  app.delete<{ Params: { id: string } }>("/api/auth/passkeys/:id", async (request, reply) => {
    const expectedOrigin = requireOrigin(request, reply);
    const auth = requireAuth(request);
    const record = store.get(request.params.id);
    if (!record || record.userId !== auth.user.id || record.profileId !== auth.profileId ||
        record.origin !== expectedOrigin) {
      throw new ApiError(404, "passkey_not_found", "Passkey not found.");
    }
    await remove([record]);
    return reply.code(204).send();
  });

  return { revokeForUser: (userId: string) => remove(store.list(userId)) };
}
