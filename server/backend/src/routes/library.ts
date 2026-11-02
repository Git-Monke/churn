import type { FastifyInstance } from "fastify";

import { expireSession, requireAuth } from "../auth.js";
import type { AppConfig } from "../config.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import type { LibraryItem, LibraryResponse, LibraryState } from "../types.js";
import {
  createJellyfinClient,
  mapJellyfinItem,
  type JellyfinImageQuery,
} from "../upstream/jellyfin.js";

export function registerLibraryRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/library", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = requireAuth(request);
    const service = config.services.jellyfin;
    const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken);

    let publicInfo;
    try {
      publicInfo = await client.getPublicInfo();
    } catch (error) {
      return emptyLibrary(libraryStateForError(error), errorMessage(error));
    }

    if (publicInfo.StartupWizardCompleted === false) {
      return emptyLibrary("setup_required", "Finish Jellyfin first-run setup to build the library");
    }

    if (!service.apiKey) {
      return emptyLibrary("unconfigured", "Set JELLYFIN_API_KEY in server/.env to load the library");
    }

    try {
      const upstreamItems = await client.listLibrary(auth.user.id);
      const items = upstreamItems
        .map(mapJellyfinItem)
        .filter((item): item is LibraryItem => item !== null);
      const response: LibraryResponse = {
        source: "jellyfin",
        state: "ok",
        items,
        total: items.length,
      };
      return response;
    } catch (error) {
      if (isUnauthorized(error)) {
        expireSession(request);
        throw new ApiError(
          401,
          "session_expired",
          "Your Jellyfin session expired. Sign in again.",
        );
      }
      if (error instanceof UpstreamError) {
        return emptyLibrary(libraryStateForError(error), error.message);
      }
      throw error;
    }
  });

  app.get<{ Params: { itemId: string }; Querystring: Record<string, unknown> }>(
    "/api/library/images/:itemId",
    async (request, reply) => {
      const auth = requireAuth(request);
      const itemId = request.params.itemId;
      if (!/^[A-Za-z0-9-]{1,64}$/.test(itemId)) {
        throw new ApiError(400, "invalid_item_id", "Invalid library item id");
      }
      const query = parseImageQuery(request.query);
      const service = config.services.jellyfin;
      if (!service.apiKey) {
        throw new ApiError(503, "jellyfin_unconfigured", "Set JELLYFIN_API_KEY in server/.env");
      }

      const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken);
      try {
        const image = await client.getPrimaryImage(itemId, query);
        if (!image) {
          throw new ApiError(404, "image_not_found", "Image not found");
        }
        reply.header("cache-control", "public, max-age=86400");
        return reply.type(image.contentType).send(image.body);
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        if (isUnauthorized(error)) {
          expireSession(request);
          throw new ApiError(
            401,
            "session_expired",
            "Your Jellyfin session expired. Sign in again.",
          );
        }
        if (error instanceof UpstreamError) {
          if (error.status === 404) {
            throw new ApiError(404, "image_not_found", "Image not found");
          }
          throw new ApiError(502, "jellyfin_image_failed", error.message);
        }
        throw error;
      }
    },
  );
}

function parseImageQuery(query: Record<string, unknown>): JellyfinImageQuery {
  const tag = optionalString(query.tag, "tag", /^[A-Za-z0-9._~-]{1,128}$/);
  const maxWidth = optionalSize(query.maxWidth, "maxWidth");
  const maxHeight = optionalSize(query.maxHeight, "maxHeight");
  return { tag, maxWidth, maxHeight };
}

function optionalString(value: unknown, name: string, pattern: RegExp): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ApiError(400, "invalid_query", `Invalid ${name}`);
  }
  return value;
}

function optionalSize(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) {
    throw new ApiError(400, "invalid_query", `Invalid ${name}`);
  }
  const size = Number.parseInt(value, 10);
  if (size < 1 || size > 2000) {
    throw new ApiError(400, "invalid_query", `${name} must be between 1 and 2000`);
  }
  return size;
}

function emptyLibrary(state: LibraryState, detail: string): LibraryResponse {
  return {
    source: "jellyfin",
    state,
    items: [],
    total: 0,
    detail,
  };
}

function libraryStateForError(error: unknown): LibraryState {
  if (isUnauthorized(error)) {
    return "unauthorized";
  }
  return "unreachable";
}

function errorMessage(error: unknown): string {
  return error instanceof UpstreamError ? error.message : "Jellyfin is unreachable";
}
