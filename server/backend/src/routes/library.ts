import type { FastifyInstance } from "fastify";

import { expireSession, requireAuth } from "../auth.js";
import type { AppConfig } from "../config.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import type { MediaAttributionStore } from "../media-attribution.js";
import type { ReleaseSearchService } from "../release-search.js";
import {
  buildContinueWatching,
  continueWatchingResponse,
  NEXT_UP_FETCH_LIMIT,
  PLAYED_FETCH_LIMIT,
  RESUME_FETCH_LIMIT,
} from "../resume.js";
import type {
  CancelJellyfinItemResponse,
  LibraryItem,
  LibraryResponse,
  LibraryState,
} from "../types.js";
import {
  createJellyfinClient,
  mapJellyfinItem,
  type JellyfinImageQuery,
  type JellyfinImageType,
  type JellyfinItem,
} from "../upstream/jellyfin.js";
import {
  cancelRequestedTitle,
  findArrTitleMatch,
  removeQbittorrentForTitle,
} from "./requested.js";

export function registerLibraryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  releaseSearch: ReleaseSearchService,
  mediaAttribution: MediaAttributionStore,
): void {
  app.get("/api/library", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = requireAuth(request);
    const service = config.services.jellyfin;
    const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken, {
      deviceId: auth.deviceId,
    });

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
        .filter((item): item is LibraryItem => item !== null)
        .map((item) => attachMediaAttribution(item, mediaAttribution));
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

  /**
   * Continue watching: Jellyfin's own per-user resume list merged with its Next
   * Up list, so finishing an episode offers the next one. The user's token is
   * forwarded, so each profile sees its own progress and nothing is persisted
   * in Churn.
   */
  app.get("/api/library/resume", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const auth = requireAuth(request);
    const service = config.services.jellyfin;
    if (!service.apiKey) {
      return continueWatchingResponse(
        "unconfigured",
        [],
        "Set JELLYFIN_API_KEY in server/.env to load continue watching",
      );
    }
    const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken, {
      deviceId: auth.deviceId,
    });

    try {
      // The resume list is the row's backbone; the two lookups that add a
      // next-up card are best effort, so a slow or failing Next Up never hides
      // the cards that already work today.
      const resume = client.listResumeItems(auth.user.id, RESUME_FETCH_LIMIT);
      const nextUp = client.listNextUpItems(auth.user.id, NEXT_UP_FETCH_LIMIT).catch(() => []);
      const played = client.listPlayedEpisodes(auth.user.id, PLAYED_FETCH_LIMIT).catch(() => []);
      const [resumeItems, nextUpItems, playedItems] = await Promise.all([resume, nextUp, played]);
      return continueWatchingResponse(
        "ok",
        buildContinueWatching({ resume: resumeItems, nextUp: nextUpItems, played: playedItems }),
      );
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
        return continueWatchingResponse(libraryStateForError(error), [], error.message);
      }
      throw error;
    }
  });

  app.delete<{ Params: { itemId: string } }>(
    "/api/library/jellyfin/:itemId",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const auth = requireAuth(request);
      const itemId = parseJellyfinItemId(request.params.itemId);
      const service = config.services.jellyfin;
      if (!service.apiKey) {
        throw new ApiError(503, "jellyfin_unconfigured", "Set JELLYFIN_API_KEY in server/.env");
      }

      const client = createJellyfinClient(service, config.requestTimeoutMs);
      let item: JellyfinItem;
      try {
        // Jellyfin 10.11 rejects an API-key-only item lookup with HTTP 400.
        item = await client.getItem(itemId, auth.user.id);
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          throw new ApiError(404, "not_found", "Title was not found in Jellyfin");
        }
        throw error;
      }
      if (item.Type !== "Movie" && item.Type !== "Series") {
        throw new ApiError(400, "invalid_item_type", "Only movies and series can be removed");
      }
      const title = item.Name?.trim();
      if (!title) {
        throw new ApiError(400, "invalid_item", "Jellyfin item has no title");
      }
      const kind = item.Type === "Movie" ? "movie" : "series";
      const providerIds = {
        tmdbId: parseProviderId(item.ProviderIds?.Tmdb),
        tvdbId: parseProviderId(item.ProviderIds?.Tvdb),
      };

      // Preserve Sonarr/Radarr ownership when the local catalog key differed.
      const arrMatch = await findArrTitleMatch(
        config,
        kind,
        title,
        item.ProductionYear,
        providerIds,
      );
      if (arrMatch) {
        return cancelRequestedTitle(
          config,
          arrMatch.service,
          arrMatch.arrId,
          releaseSearch,
          mediaAttribution,
        );
      }

      await client.deleteItem(itemId);
      await mediaAttribution.remove({
        kind,
        tmdbId: providerIds.tmdbId,
        tvdbId: providerIds.tvdbId,
      });
      await removeQbittorrentForTitle(config, kind, title, item.ProductionYear);

      const response: CancelJellyfinItemResponse = {
        status: "cancelled",
        service: "jellyfin",
        kind,
        id: itemId,
      };
      return response;
    },
  );

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

      const client = createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken, {
      deviceId: auth.deviceId,
    });
      try {
        const image = await client.getItemImage(itemId, query);
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

function attachMediaAttribution(
  item: LibraryItem,
  mediaAttribution: MediaAttributionStore,
): LibraryItem {
  const addedBy = mediaAttribution.get({
    kind: item.type === "Movie" ? "movie" : "series",
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
  });
  return addedBy ? { ...item, addedBy } : item;
}

function parseJellyfinItemId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new ApiError(400, "invalid_item_id", "Invalid library item id");
  }
  return value;
}

function parseProviderId(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,12}$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseImageQuery(query: Record<string, unknown>): JellyfinImageQuery {
  const type = parseImageType(query.type);
  const tag = optionalString(query.tag, "tag", /^[A-Za-z0-9._~-]{1,128}$/);
  const maxWidth = optionalSize(query.maxWidth, "maxWidth");
  const maxHeight = optionalSize(query.maxHeight, "maxHeight");
  return { type, tag, maxWidth, maxHeight };
}

function parseImageType(value: unknown): JellyfinImageType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "Primary" || value === "Backdrop") {
    return value;
  }
  throw new ApiError(400, "invalid_query", "type must be Primary or Backdrop");
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
