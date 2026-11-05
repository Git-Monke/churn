import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { expireSession, requireAuth } from "../auth.js";
import { jellyfinPublicUrlForRequest, type AppConfig } from "../config.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import {
  buildJellyfinHlsUrl,
  buildJellyfinStreamUrl,
  canBrowserDirectPlay,
  mapPlaybackItem,
  parsePlaybackQuality,
  parsePlaybackReport,
  pickMediaSource,
  playbackHlsPath,
  playbackReportBodies,
  playbackStreamPath,
  type PlaybackItemResponse,
} from "../playback.js";
import type { IntroDbService } from "../introdb-warm.js";
import { createJellyfinClient, providerString } from "../upstream/jellyfin.js";
import { errorMessage } from "../upstream/states.js";

type ReportKind = "start" | "progress" | "stop";

interface PlaybackParams {
  itemId: string;
}

interface StreamQuery {
  mediaSourceId?: unknown;
  playSessionId?: unknown;
  quality?: unknown;
}

interface ItemQuery {
  quality?: unknown;
}

const ITEM_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export function registerPlaybackRoutes(
  app: FastifyInstance,
  config: AppConfig,
  introDb: IntroDbService,
): void {
  const seriesImdbCache = new Map<
    string,
    { imdbId?: string; fetchedAt: number }
  >();
  app.get<{ Params: PlaybackParams; Querystring: ItemQuery }>(
    "/api/playback/items/:itemId",
    async (request, reply): Promise<PlaybackItemResponse> => {
      reply.header("cache-control", "no-store");
      const auth = requireAuth(request);
      const itemId = parseItemId(request.params.itemId);
      const quality = parsePlaybackQuality(request.query.quality);
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        auth.accessToken,
        {
          deviceId: auth.deviceId,
        },
      );

      let item;
      let playbackInfo;
      try {
        [item, playbackInfo] = await Promise.all([
          client.getItem(itemId, auth.user.id),
          client.getPlaybackInfo(itemId, auth.user.id),
        ]);
      } catch (error) {
        if (isUnauthorized(error)) {
          return { state: "unauthorized", detail: errorMessage(error) };
        }
        if (
          error instanceof UpstreamError &&
          (error.status === 400 || error.status === 404)
        ) {
          throw new ApiError(404, "playback_item_not_found", "Item not found");
        }
        return { state: "unreachable", detail: errorMessage(error) };
      }

      const picked = pickMediaSource(playbackInfo);
      // Any explicit tier has to be transcoded; only `max` may direct-play.
      const directPlay =
        quality === "max" &&
        picked.directPlay &&
        canBrowserDirectPlay(picked.source);
      const streamUrl = directPlay
        ? playbackStreamPath(itemId, picked.source?.Id, picked.playSessionId)
        : playbackHlsPath(
            itemId,
            picked.source?.Id,
            picked.playSessionId,
            quality,
          );
      const mapped = mapPlaybackItem(
        item,
        picked.source,
        picked.playSessionId,
        streamUrl,
        directPlay,
        quality,
      );
      if (!mapped) {
        throw new ApiError(
          404,
          "playback_item_not_found",
          "Item is not a playable movie or episode",
        );
      }

      // Segment timestamps are warmed when the episode/season is grabbed;
      // playback only reads the cache. Any lookup problem simply means the
      // player gets no skip affordance.
      if (
        mapped.type === "Episode" &&
        mapped.seriesId &&
        mapped.seasonNumber !== undefined &&
        mapped.episodeNumber !== undefined
      ) {
        try {
          const imdbId = await resolveSeriesImdb(
            client,
            mapped.seriesId,
            seriesImdbCache,
          );
          const segments = imdbId
            ? await introDb.segmentsFor(
                imdbId,
                mapped.seasonNumber,
                mapped.episodeNumber,
              )
            : undefined;
          if (segments) {
            mapped.segments = segments;
          }
        } catch {
          // IntroDB data is optional; playback must not depend on it.
        }
      }

      return { state: "ok", item: mapped };
    },
  );

  app.get<{ Params: PlaybackParams; Querystring: StreamQuery }>(
    "/api/playback/items/:itemId/hls.m3u8",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      const auth = requireAuth(request);
      const itemId = parseItemId(request.params.itemId);
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        auth.accessToken,
        {
          deviceId: auth.deviceId,
        },
      );

      let mediaSourceId = parseOptionalSessionId(
        request.query.mediaSourceId,
        "mediaSourceId",
      );
      let playSessionId = parseOptionalSessionId(
        request.query.playSessionId,
        "playSessionId",
      );
      const quality = parsePlaybackQuality(request.query.quality);

      let source;
      try {
        const playbackInfo = await client.getPlaybackInfo(
          itemId,
          auth.user.id,
        );
        const picked = pickMediaSource(playbackInfo);
        source = mediaSourceId
          ? playbackInfo.MediaSources?.find(
              (candidate) => candidate.Id === mediaSourceId,
            ) ?? picked.source
          : picked.source;
        mediaSourceId = source?.Id ?? mediaSourceId;
        playSessionId ??= picked.playSessionId;
      } catch (error) {
        throw playbackRouteError(
          error,
          "Jellyfin could not prepare this stream",
          request,
        );
      }

      const hlsUrl = buildJellyfinHlsUrl(
        jellyfinPublicUrlForRequest(config, request.headers),
        itemId,
        source,
        playSessionId,
        auth.accessToken,
        quality,
      );
      return reply.redirect(hlsUrl, 302);
    },
  );

  app.get<{ Params: PlaybackParams; Querystring: StreamQuery }>(
    "/api/playback/items/:itemId/stream",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      const auth = requireAuth(request);
      const itemId = parseItemId(request.params.itemId);
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        auth.accessToken,
        {
          deviceId: auth.deviceId,
        },
      );

      let mediaSourceId = parseOptionalSessionId(
        request.query.mediaSourceId,
        "mediaSourceId",
      );
      let playSessionId = parseOptionalSessionId(
        request.query.playSessionId,
        "playSessionId",
      );

      try {
        if (!mediaSourceId || !playSessionId) {
          const playbackInfo = await client.getPlaybackInfo(
            itemId,
            auth.user.id,
          );
          const picked = pickMediaSource(playbackInfo);
          mediaSourceId ??= picked.source?.Id;
          playSessionId ??= picked.playSessionId;
        }
      } catch (error) {
        throw playbackRouteError(
          error,
          "Jellyfin could not prepare this stream",
          request,
        );
      }

      const streamUrl = buildJellyfinStreamUrl(
        jellyfinPublicUrlForRequest(config, request.headers),
        itemId,
        mediaSourceId,
        playSessionId,
        auth.accessToken,
      );
      return reply.redirect(streamUrl, 302);
    },
  );

  app.post<{ Params: PlaybackParams; Body: unknown }>(
    "/api/playback/items/:itemId/start",
    (request, reply) => reportPlayback(request, reply, config, "start"),
  );
  app.post<{ Params: PlaybackParams; Body: unknown }>(
    "/api/playback/items/:itemId/progress",
    (request, reply) => reportPlayback(request, reply, config, "progress"),
  );
  app.post<{ Params: PlaybackParams; Body: unknown }>(
    "/api/playback/items/:itemId/stop",
    (request, reply) => reportPlayback(request, reply, config, "stop"),
  );
}

async function reportPlayback(
  request: FastifyRequest<{ Params: PlaybackParams; Body: unknown }>,
  reply: FastifyReply,
  config: AppConfig,
  kind: ReportKind,
): Promise<unknown> {
  const auth = requireAuth(request);
  const itemId = parseItemId(request.params.itemId);
  const input = parsePlaybackReport(request.body);
  const bodies = playbackReportBodies(itemId, input);
  const client = createJellyfinClient(
    config.services.jellyfin,
    config.requestTimeoutMs,
    auth.accessToken,
    {
      deviceId: auth.deviceId,
    },
  );

  try {
    if (kind === "start") {
      await client.reportPlaybackStart(bodies.start);
    } else if (kind === "progress") {
      await client.reportPlaybackProgress(bodies.progress);
    } else {
      await client.reportPlaybackStopped(bodies.stop);
    }
  } catch (error) {
    throw playbackRouteError(
      error,
      "Jellyfin could not record playback progress",
      request,
    );
  }

  return reply.code(204).send();
}

function playbackRouteError(
  error: unknown,
  fallback: string,
  request?: FastifyRequest,
): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (isUnauthorized(error)) {
    if (request) {
      expireSession(request);
    }
    return new ApiError(
      401,
      "session_expired",
      "Your Jellyfin session expired. Sign in again.",
    );
  }
  if (error instanceof UpstreamError) {
    return new ApiError(502, "jellyfin_playback_failed", `${fallback}: ${error.message}`);
  }
  return new ApiError(502, "jellyfin_playback_failed", errorMessage(error));
}

const SERIES_IMDB_TTL_MS = 60 * 60 * 1000;
const SERIES_IMDB_CACHE_MAX = 200;

/**
 * The episode item does not repeat the series provider ids, so read them from
 * the series once. Binging a season then costs one Jellyfin item lookup, not
 * one per episode.
 */
async function resolveSeriesImdb(
  client: ReturnType<typeof createJellyfinClient>,
  seriesId: string,
  cache: Map<string, { imdbId?: string; fetchedAt: number }>,
): Promise<string | undefined> {
  const cached = cache.get(seriesId);
  if (cached && Date.now() - cached.fetchedAt < SERIES_IMDB_TTL_MS) {
    return cached.imdbId;
  }

  const series = await client.getItem(seriesId);
  const imdbId = providerString(series, "imdb");
  if (cache.size >= SERIES_IMDB_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(seriesId, { ...(imdbId ? { imdbId } : {}), fetchedAt: Date.now() });
  return imdbId;
}

function parseItemId(value: string): string {
  if (!ITEM_ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_item_id", "Invalid Jellyfin item id");
  }
  return value;
}

function parseOptionalSessionId(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_query", `Invalid ${name}`);
  }
  return value;
}
