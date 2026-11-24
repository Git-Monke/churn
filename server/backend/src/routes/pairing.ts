import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  createLoginThrottle,
  requireAuth,
  sessionExpiresAt,
  type AuthContext,
  type SessionRecord,
  type SessionStore,
} from "../auth.js";
import type { AppConfig } from "../config.js";
import { cleanDeviceName, isPairingCode, type Pairing, type PairingStore } from "../device-pairing.js";
import { ApiError, UpstreamError } from "../errors.js";
import type {
  PairedDevice,
  PairedDevicesResponse,
  PairingApproveResponse,
  PairingDetailsResponse,
  PairingStartResponse,
  PairingStatusResponse,
} from "../types.js";
import { createJellyfinClient } from "../upstream/jellyfin.js";

const POLL_INTERVAL_SECONDS = 3;
/** Pairing starts per address in the throttle window, approved or not. */
const MAX_STARTS = 20;

/**
 * Device pairing (`churn-6nfv`): a TV shows a code, someone signed in
 * approves it in the dashboard, and the TV gets a token of its own.
 *
 * The TV's Jellyfin session comes from Jellyfin's Quick Connect, authorized
 * as the person approving, so it is separate from theirs: signing out on the
 * phone leaves the TV signed in, and revoking the TV leaves the phone alone.
 */
export function registerPairingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: { store: SessionStore; pairings: PairingStore },
): void {
  const startThrottle = createLoginThrottle({ maxFailures: MAX_STARTS });
  const jellyfin = config.services.jellyfin;

  app.post<{ Body: unknown }>("/api/tv/pair/start", async (request, reply): Promise<PairingStartResponse> => {
    reply.header("cache-control", "no-store");
    const decision = startThrottle.check(request.ip);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds ?? 60));
      throw new ApiError(429, "too_many_requests", "Too many pairing attempts. Try again later.");
    }
    startThrottle.recordFailure(request.ip);
    const deviceName = cleanDeviceName((request.body as { deviceName?: unknown } | null)?.deviceName);
    if (!deviceName) {
      throw new ApiError(400, "invalid_request", "Give the device a name, such as \"Living Room TV\"");
    }
    if (!jellyfin.apiKey) {
      throw new ApiError(503, "jellyfin_unconfigured", "Jellyfin isn't set up yet");
    }

    const deviceId = `churn-tv-${randomUUID()}`;
    const client = createJellyfinClient(jellyfin, config.requestTimeoutMs, undefined, { deviceId, deviceName });
    let quickConnect;
    try {
      if (!(await client.isQuickConnectEnabled())) {
        throw quickConnectOff();
      }
      quickConnect = await client.initiateQuickConnect();
    } catch (error) {
      throw jellyfinError(error);
    }
    if (!quickConnect.Code || !quickConnect.Secret) {
      throw new ApiError(502, "jellyfin_invalid_response", "Jellyfin didn't start a Quick Connect sign-in");
    }
    const created = deps.pairings.create({
      deviceName,
      deviceId,
      quickConnectCode: quickConnect.Code,
      quickConnectSecret: quickConnect.Secret,
    });
    if (!created) {
      throw new ApiError(429, "too_many_requests", "Too many devices are waiting to pair. Try again in a few minutes.");
    }
    return {
      code: created.pairing.code,
      pollToken: created.pollToken,
      expiresAt: new Date(created.pairing.expiresAt).toISOString(),
      approvePath: `/#/pair?code=${created.pairing.code}`,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    };
  });

  app.get<{ Params: { code: string } }>(
    "/api/tv/pair/:code",
    async (request, reply): Promise<PairingStatusResponse> => {
      reply.header("cache-control", "no-store");
      const pollToken = request.headers["x-churn-pair-token"];
      const pairing =
        typeof pollToken === "string" ? deps.pairings.getForDevice(request.params.code, pollToken) : undefined;
      if (!pairing) throw notFound();
      if (pairing.status === "pending") return { status: "pending" };
      deps.pairings.delete(pairing.code);
      if (pairing.status === "denied" || !pairing.issued) return { status: "denied" };
      return {
        status: "approved",
        token: pairing.issued.token,
        user: pairing.issued.user,
        expiresAt: new Date(pairing.issued.expiresAt).toISOString(),
      };
    },
  );

  app.get<{ Params: { code: string } }>(
    "/api/tv/pair/:code/details",
    async (request, reply): Promise<PairingDetailsResponse> => {
      reply.header("cache-control", "no-store");
      requirePerson(request);
      const pairing = findPairing(deps.pairings, request.params.code);
      return {
        code: pairing.code,
        deviceName: pairing.deviceName,
        status: pairing.status,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
      };
    },
  );

  app.post<{ Params: { code: string } }>(
    "/api/tv/pair/:code/approve",
    async (request, reply): Promise<PairingApproveResponse> => {
      reply.header("cache-control", "no-store");
      const auth = requirePerson(request);
      const pairing = findPairing(deps.pairings, request.params.code);
      if (pairing.status !== "pending") throw alreadyDecided();

      let accessToken: string;
      try {
        const asApprover = createJellyfinClient(jellyfin, config.requestTimeoutMs, auth.accessToken, {
          deviceId: auth.deviceId,
        });
        if (!(await asApprover.authorizeQuickConnect(pairing.quickConnectCode, auth.user.id))) {
          throw new ApiError(502, "pairing_failed", "Jellyfin didn't accept the pairing. Start again on the TV.");
        }
        const asDevice = createJellyfinClient(jellyfin, config.requestTimeoutMs, undefined, {
          deviceId: pairing.deviceId,
          deviceName: pairing.deviceName,
        });
        const result = await asDevice.authenticateWithQuickConnect(pairing.quickConnectSecret);
        if (!result.AccessToken || result.User?.Id !== auth.user.id) {
          throw new ApiError(502, "pairing_failed", "Jellyfin didn't sign the device in. Start again on the TV.");
        }
        accessToken = result.AccessToken;
      } catch (error) {
        throw jellyfinError(error);
      }

      // Approving twice at once: the first one wins.
      if (pairing.status !== "pending") throw alreadyDecided();
      const session = deps.store.create(auth.user, accessToken, {
        kind: "device",
        deviceId: pairing.deviceId,
        deviceName: pairing.deviceName,
        ...(auth.profileId ? { profileId: auth.profileId } : {}),
      });
      pairing.status = "approved";
      pairing.issued = {
        token: session.cookieValue,
        user: auth.user,
        expiresAt: sessionExpiresAt(session.record, deps.store.ttlFor(session.record)),
      };
      return { status: "approved", device: deviceSummary(session.record) };
    },
  );

  app.post<{ Params: { code: string } }>("/api/tv/pair/:code/deny", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requirePerson(request);
    const pairing = findPairing(deps.pairings, request.params.code);
    if (pairing.status !== "pending") throw alreadyDecided();
    pairing.status = "denied";
    return reply.code(204).send();
  });

  app.get("/api/tv/devices", async (request, reply): Promise<PairedDevicesResponse> => {
    reply.header("cache-control", "no-store");
    const auth = requirePerson(request);
    const devices = deps.store
      .listDevices()
      .filter((record) => auth.user.isAdmin || record.user.id === auth.user.id)
      .map(deviceSummary);
    return { devices };
  });

  app.delete<{ Params: { id: string } }>("/api/tv/devices/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = requirePerson(request);
    const target = deps.store.listDevices().find((record) => record.deviceId === request.params.id);
    if (!target || (!auth.user.isAdmin && target.user.id !== auth.user.id)) {
      throw new ApiError(404, "device_not_found", "No such paired device");
    }
    deps.store.destroyDevice(target.deviceId);
    try {
      await createJellyfinClient(jellyfin, config.requestTimeoutMs, target.accessToken, {
        deviceId: target.deviceId,
      }).logout(target.accessToken);
    } catch {
      // Revoking in churn must not depend on Jellyfin being reachable.
    }
    return reply.code(204).send();
  });
}

/** Pairing is managed by people, never by a paired device. */
function requirePerson(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.kind === "device") {
    throw new ApiError(403, "forbidden", "Pair and manage devices from the dashboard, not from a paired device");
  }
  return auth;
}

function findPairing(pairings: PairingStore, code: string): Pairing {
  const pairing = isPairingCode(code) ? pairings.get(code) : undefined;
  if (!pairing) throw notFound();
  return pairing;
}

function deviceSummary(record: SessionRecord): PairedDevice {
  return {
    id: record.deviceId,
    name: record.deviceName ?? "Paired device",
    user: { id: record.user.id, name: record.user.name },
    pairedAt: new Date(record.createdAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
  };
}

function notFound(): ApiError {
  return new ApiError(404, "pairing_not_found", "That code has expired or doesn't exist. Start pairing again on the TV.");
}

function alreadyDecided(): ApiError {
  return new ApiError(409, "pairing_already_decided", "That device has already been approved or denied.");
}

function quickConnectOff(): ApiError {
  return new ApiError(
    409,
    "quick_connect_disabled",
    "Turn on Quick Connect in Jellyfin (Dashboard → General) to pair devices.",
  );
}

function jellyfinError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof UpstreamError) {
    if (error.status === 401 || error.status === 403) return quickConnectOff();
    return new ApiError(502, "jellyfin_unreachable", error.message);
  }
  return error;
}
