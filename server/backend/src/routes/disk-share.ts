import type { FastifyInstance } from "fastify";

import { requireAdmin, requireAuth, type SessionStore } from "../auth.js";
import type { DiskShareService } from "../disk-shares.js";
import { ApiError } from "../errors.js";

export interface DiskShareRouteDependencies {
  service: DiskShareService;
  sessions: SessionStore;
}

interface ProfileParams {
  profileId: string;
}

export function registerDiskShareRoutes(
  app: FastifyInstance,
  deps: DiskShareRouteDependencies,
): void {
  app.get("/api/disk-share", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return deps.service.summary(requireAuth(request).user);
  });

  app.get("/api/disk-share/admin", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireAdmin(request);
    return deps.service.adminSummary();
  });

  app.put<{ Body: unknown }>("/api/disk-share/settings", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireAdmin(request);
    const enabled = parseSettingsBody(request.body);
    await deps.service.setEnabled(enabled);
    return { enabled };
  });

  app.put<{ Params: ProfileParams; Body: unknown }>(
    "/api/disk-share/users/:profileId",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      requireAdmin(request);
      const profile = deps.sessions.getProfile(request.params.profileId);
      if (!profile) {
        throw new ApiError(404, "profile_not_found", "Person not found");
      }
      const limitBytes = parseLimitBody(request.body);
      await deps.service.setUserLimit(profile.jellyfinUserId, limitBytes);
      return { profileId: profile.id, limitBytes };
    },
  );
}

function parseSettingsBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "enabled must be a boolean");
  }
  const enabled = (value as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new ApiError(400, "invalid_request", "enabled must be a boolean");
  }
  return enabled;
}

function parseLimitBody(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitBytes must be a positive integer or null",
    );
  }
  const limitBytes = (value as Record<string, unknown>).limitBytes;
  if (
    limitBytes !== null &&
    !(typeof limitBytes === "number" && Number.isSafeInteger(limitBytes) && limitBytes > 0)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitBytes must be a positive integer or null",
    );
  }
  return limitBytes;
}
