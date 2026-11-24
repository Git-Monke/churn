import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { expireSession, requireAuth } from "../auth.js";
import type { AppConfig } from "../config.js";
import { ApiError, isUnauthorized, UpstreamError } from "../errors.js";
import { upstreamResponseError } from "../http.js";
import {
  availablePlaybackQualities,
  buildJellyfinHlsUrl,
  buildJellyfinStreamUrl,
  canDirectPlay,
  mapPlaybackItem,
  parsePlaybackQuality,
  parsePlaybackReport,
  pickMediaSource,
  pickNextEpisode,
  playbackHlsPath,
  playbackReportBodies,
  playbackStreamPath,
  rewriteHlsPlaylist,
  type PlaybackItemResponse,
} from "../playback.js";
import type { IntroDbService } from "../introdb-warm.js";
import { createNextEpisodeLookup } from "../next-episode.js";
import {
  createJellyfinClient,
  providerString,
  type JellyfinClient,
} from "../upstream/jellyfin.js";
import { errorMessage } from "../upstream/states.js";
import { parsePlaybackClient } from "../playback-clients.js";

type ReportKind = "start" | "progress" | "stop";

interface PlaybackParams {
  itemId: string;
}

interface StreamQuery {
  mediaSourceId?: unknown;
  playSessionId?: unknown;
  quality?: unknown;
  client?: unknown;
}

interface HlsAssetParams {
  itemId: string;
  "*": string;
}

interface ItemQuery {
  quality?: unknown;
  client?: unknown;
}

interface SubtitleParams {
  itemId: string;
  index: string;
}

interface SubtitleQuery {
  mediaSourceId?: unknown;
}

const ITEM_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const HLS_ASSET_PATTERN = /^[A-Za-z0-9._~/-]{1,512}$/;
const MEDIA_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

export function registerPlaybackRoutes(
  app: FastifyInstance,
  config: AppConfig,
  introDb: IntroDbService,
): void {
  const seriesImdbCache = new Map<
    string,
    { imdbId?: string; fetchedAt: number }
  >();
  const getSeriesEpisodes = createNextEpisodeLookup();
  app.get<{ Params: PlaybackParams; Querystring: ItemQuery }>(
    "/api/playback/items/:itemId",
    async (request, reply): Promise<PlaybackItemResponse> => {
      reply.header("cache-control", "no-store");
      const auth = requireAuth(request);
      const itemId = parseItemId(request.params.itemId);
      const quality = parsePlaybackQuality(request.query.quality);
      const playbackClient = parsePlaybackClient(request.query.client);
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
      // A remembered tier may not exist for this source. Fall back to Max for
      // this item without changing the caller's stored preference.
      const qualities = availablePlaybackQualities(picked.source);
      const appliedQuality = qualities.some((option) => option.id === quality)
        ? quality
        : "max";
      // Any explicit tier has to be transcoded; only `max` may direct-play.
      const directPlay =
        appliedQuality === "max" &&
        picked.directPlay &&
        canDirectPlay(picked.source, playbackClient);
      const streamUrl = directPlay
        ? playbackStreamPath(itemId, picked.source?.Id, picked.playSessionId)
        : playbackHlsPath(
            itemId,
            picked.source?.Id,
            picked.playSessionId,
            appliedQuality,
            playbackClient,
          );
      const mapped = mapPlaybackItem(
        item,
        picked.source,
        picked.playSessionId,
        streamUrl,
        directPlay,
        appliedQuality,
        playbackClient,
      );
      if (!mapped) {
        throw new ApiError(
          404,
          "playback_item_not_found",
          "Item is not a playable movie or episode",
        );
      }

      const episodeContext =
        mapped.type === "Episode" &&
        mapped.seriesId &&
        mapped.seasonNumber !== undefined &&
        mapped.episodeNumber !== undefined
          ? {
              seriesId: mapped.seriesId,
              seasonNumber: mapped.seasonNumber,
              episodeNumber: mapped.episodeNumber,
            }
          : undefined;

      // Next-episode and segment lookups are best effort and independent, so
      // run them together. A failure only omits that optional data.
      const nextEpisodePromise = episodeContext
        ? getSeriesEpisodes(client, episodeContext.seriesId).then((episodes) =>
            episodes
              ? pickNextEpisode(episodes, {
                  id: mapped.id,
                  seasonNumber: episodeContext.seasonNumber,
                  episodeNumber: episodeContext.episodeNumber,
                })
              : undefined,
          )
        : Promise.resolve(undefined);

      if (episodeContext) {
        try {
          const imdbId = await resolveSeriesImdb(
            client,
            episodeContext.seriesId,
            seriesImdbCache,
          );
          const segments = imdbId
            ? await introDb.segmentsFor(
                imdbId,
                episodeContext.seasonNumber,
                episodeContext.episodeNumber,
              )
            : undefined;
          if (segments) {
            mapped.segments = segments;
          }
        } catch {
          // IntroDB data is optional; playback must not depend on it.
        }
      }

      const nextEpisode = await nextEpisodePromise;
      if (nextEpisode) {
        mapped.nextEpisode = nextEpisode;
      }

      return { state: "ok", item: mapped };
    },
  );

  app.get<{ Params: PlaybackParams; Querystring: StreamQuery }>(
    "/api/playback/items/:itemId/hls.m3u8",
    async (request, reply) => {
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
      const playbackClient = parsePlaybackClient(request.query.client);

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

      const hlsQuality = availablePlaybackQualities(source).some(
        (option) => option.id === quality,
      )
        ? quality
        : "max";
      const manifestUrl = buildJellyfinHlsUrl(
        config.services.jellyfin.url,
        itemId,
        source,
        playSessionId,
        hlsQuality,
        playbackClient,
      );
      return proxyUpstreamMedia(
        request,
        reply,
        client,
        manifestUrl,
        itemId,
        config.services.jellyfin.url,
      );
    },
  );

  app.get<{ Params: PlaybackParams; Querystring: StreamQuery }>(
    "/api/playback/items/:itemId/stream",
    async (request, reply) => {
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
        config.services.jellyfin.url,
        itemId,
        mediaSourceId,
        playSessionId,
      );
      return proxyUpstreamMedia(
        request,
        reply,
        client,
        streamUrl,
        itemId,
        config.services.jellyfin.url,
      );
    },
  );

  app.get<{ Params: HlsAssetParams; Querystring: Record<string, unknown> }>(
    "/api/playback/items/:itemId/jellyfin/*",
    async (request, reply) => {
      const itemId = parseItemId(request.params.itemId);
      const asset = parseHlsAsset(request.params["*"]);
      const auth = requireAuth(request);
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        auth.accessToken,
        { deviceId: auth.deviceId },
      );
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) {
        if (key !== "api_key" && typeof value === "string") {
          params.append(key, value);
        }
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const upstreamUrl =
        `${config.services.jellyfin.url}/Videos/${encodeURIComponent(itemId)}/${asset}${suffix}`;
      return proxyUpstreamMedia(
        request,
        reply,
        client,
        upstreamUrl,
        itemId,
        config.services.jellyfin.url,
      );
    },
  );

  app.get<{ Params: SubtitleParams; Querystring: SubtitleQuery }>(
    "/api/playback/items/:itemId/subtitles/:index",
    async (request, reply) => {
      // Text tracks are immutable per media file, so let the browser reuse them
      // across quality switches that keep the same source.
      reply.header("cache-control", "private, max-age=3600");
      reply.header("referrer-policy", "no-referrer");
      const auth = requireAuth(request);
      const itemId = parseItemId(request.params.itemId);
      const mediaSourceId = parseOptionalSessionId(
        request.query.mediaSourceId,
        "mediaSourceId",
      );
      if (!mediaSourceId) {
        throw new ApiError(400, "invalid_query", "mediaSourceId is required");
      }
      const index = parseSubtitleIndex(request.params.index);
      const client = createJellyfinClient(
        config.services.jellyfin,
        config.requestTimeoutMs,
        auth.accessToken,
        {
          deviceId: auth.deviceId,
        },
      );

      let vtt: string | null;
      try {
        vtt = await client.getSubtitle(itemId, mediaSourceId, index);
      } catch (error) {
        throw playbackRouteError(
          error,
          "Jellyfin could not deliver subtitles",
          request,
        );
      }
      if (vtt === null) {
        throw new ApiError(404, "subtitle_not_found", "Subtitle track not found");
      }
      return reply.type("text/vtt; charset=utf-8").send(vtt);
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

async function proxyUpstreamMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  client: JellyfinClient,
  upstreamUrl: string,
  itemId: string,
  jellyfinBaseUrl: string,
): Promise<FastifyReply> {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");

  // Abort the upstream transfer when the browser goes away (seek, tab close).
  // A completed response also emits "close", so only a truncated one counts.
  const abort = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      abort.abort();
    }
  });

  const range = request.headers.range;
  let response: Response;
  try {
    response = await client.openStream(upstreamUrl, {
      signal: abort.signal,
      headers: {
        accept: "*/*",
        "accept-encoding": "identity",
        ...(range ? { range } : {}),
      },
    });
  } catch (error) {
    if (abort.signal.aborted) {
      reply.hijack();
      return reply;
    }
    throw playbackRouteError(error, "Jellyfin could not serve this video", request);
  }

  if (response.status === 404) {
    throw new ApiError(404, "playback_asset_not_found", "Video asset not found");
  }
  if (!response.ok && response.status !== 416) {
    throw playbackRouteError(
      await upstreamResponseError("jellyfin", response),
      "Jellyfin could not serve this video",
      request,
    );
  }

  if (new URL(upstreamUrl).pathname.endsWith(".m3u8")) {
    const playlist = await response.text();
    reply.type("application/vnd.apple.mpegurl");
    reply.send(rewriteHlsPlaylist(playlist, itemId, upstreamUrl, jellyfinBaseUrl));
    return reply;
  }

  reply.code(response.status);
  for (const name of MEDIA_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      reply.header(name, value);
    }
  }
  if (!response.body) {
    reply.send();
    return reply;
  }
  reply.send(Readable.fromWeb(response.body));
  return reply;
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

function parseSubtitleIndex(value: string): number {
  if (!/^\d{1,4}$/.test(value)) {
    throw new ApiError(400, "invalid_subtitle_index", "Invalid subtitle index");
  }
  return Number(value);
}

function parseItemId(value: string): string {
  if (!ITEM_ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_item_id", "Invalid Jellyfin item id");
  }
  return value;
}

function parseHlsAsset(value: string): string {
  const segments = value.split("/");
  const valid =
    HLS_ASSET_PATTERN.test(value) &&
    !segments.some((segment) => segment === "." || segment === "..");
  if (!valid) {
    throw new ApiError(404, "playback_asset_not_found", "Video asset not found");
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
