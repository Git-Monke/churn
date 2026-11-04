import "@fastify/cookie";

import type { FastifyInstance } from "fastify";

import {
  generatePin,
  requireAdmin,
  type ProfileRecord,
  type SessionStore,
} from "../auth.js";
import type { AppConfig } from "../config.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import { createJellyfinClient } from "../upstream/jellyfin.js";

export interface ProfileDependencies {
  store: SessionStore;
}

interface ProfileParams {
  id: string;
}

interface CreateProfileBody {
  name: string;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  config: AppConfig,
  deps: ProfileDependencies,
): void {
  app.get("/api/profiles", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireAdmin(request);
    return deps.store.listProfiles().map(managedProfile);
  });

  app.post<{ Body: unknown }>("/api/profiles", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireAdmin(request);
    const name = parseProfileName(request.body);
    if (deps.store.getProfileByName(name)) {
      throw new ApiError(409, "profile_exists", "A person with that name already exists");
    }

    const service = config.services.jellyfin;
    if (!service.apiKey) {
      throw new ApiError(503, "jellyfin_unconfigured", "Set JELLYFIN_API_KEY in server/.env");
    }

    const pin = generatePin();
    const client = createJellyfinClient(service, config.requestTimeoutMs);
    let jellyfinUserId: string | undefined;
    try {
      const created = await client.createUser(name, pin);
      jellyfinUserId = created.Id;
    } catch (error) {
      throw profileRouteError(error, "Jellyfin could not create that user", "profile_create_failed");
    }
    if (!jellyfinUserId) {
      throw new ApiError(
        502,
        "jellyfin_invalid_response",
        "Jellyfin created the user but returned no id",
      );
    }

    const profile = deps.store.createProfile({ name, jellyfinUserId, initialPin: pin });
    reply.code(201);
    return { profile: managedProfile(profile), pin };
  });

  app.post<{ Params: ProfileParams }>(
    "/api/profiles/:id/pin",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      requireAdmin(request);
      const profile = requireProfile(deps.store, request.params.id);

      const service = config.services.jellyfin;
      if (!service.apiKey) {
        throw new ApiError(503, "jellyfin_unconfigured", "Jellyfin is not configured");
      }

      const pin = generatePin();
      const client = createJellyfinClient(service, config.requestTimeoutMs);
      try {
        await client.setUserPassword(profile.jellyfinUserId, pin);
      } catch (error) {
        throw profileRouteError(error, "Jellyfin could not reset that PIN", "profile_pin_failed");
      }

      deps.store.setProfilePin(profile.id, pin);
      deps.store.destroyAllForProfile(profile.id);
      return { profile: managedProfile(profile), pin };
    },
  );

  app.delete<{ Params: ProfileParams }>("/api/profiles/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireAdmin(request);
    const profile = requireProfile(deps.store, request.params.id);

    const service = config.services.jellyfin;
    if (service.apiKey) {
      const client = createJellyfinClient(service, config.requestTimeoutMs);
      try {
        await client.deleteUser(profile.jellyfinUserId);
      } catch (error) {
        if (!isNotFound(error)) {
          throw profileRouteError(
            error,
            "Jellyfin could not delete that user",
            "profile_delete_failed",
          );
        }
      }
    }

    deps.store.destroyAllForProfile(profile.id);
    deps.store.deleteProfile(profile.id);
    return reply.code(204).send();
  });
}

function managedProfile(profile: ProfileRecord): {
  id: string;
  name: string;
  initialPin: string | null;
  passwordSet: boolean;
  createdAt: number;
} {
  return {
    id: profile.id,
    name: profile.name,
    initialPin: profile.initialPin,
    passwordSet: profile.initialPin === null,
    createdAt: profile.createdAt,
  };
}

function parseProfileName(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "invalid_request", "A name is required");
  }
  const name = (body as Partial<CreateProfileBody>).name;
  if (typeof name !== "string") {
    throw new ApiError(400, "invalid_request", "A name is required");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ApiError(400, "invalid_request", "A name is required");
  }
  if (trimmed.length > 32) {
    throw new ApiError(400, "invalid_request", "Name is too long");
  }
  return trimmed;
}

function requireProfile(store: SessionStore, id: string): ProfileRecord {
  const profile = store.getProfile(id);
  if (!profile) {
    throw new ApiError(404, "profile_not_found", "Person not found");
  }
  return profile;
}

function profileRouteError(
  error: unknown,
  fallback: string,
  code: string,
): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (isUnauthorized(error)) {
    return new ApiError(502, code, "Jellyfin rejected the admin API key");
  }
  if (error instanceof UpstreamError) {
    const detail = error.message;
    if (error.status === 400 || error.status === 409) {
      return new ApiError(409, "profile_exists", detail);
    }
    return new ApiError(502, code, `${fallback}: ${detail}`);
  }
  return new ApiError(502, code, fallback);
}

function isNotFound(error: unknown): boolean {
  return error instanceof UpstreamError && error.status === 404;
}
