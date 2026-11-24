/**
 * Paths here are written without a version (`/api/library`); the server also
 * serves each one under `/api/v1/...`, and openapi.json documents the
 * versioned paths, which is what separately shipped clients should call.
 *
 * The API contract: every route churn serves, what it takes and what it
 * returns. Response shapes are the TypeScript types in `types.ts` (and
 * `playback.ts`), named here by type name; `npm run api:generate` turns this
 * table and those types into `server/openapi.json`, and the frontend's types
 * are generated from that file. Tests check every JSON response against the
 * schema of its route, so a response that drifts from its type fails a test.
 *
 * Routes not described yet are listed in `UNDESCRIBED_ROUTES`; a test fails
 * when a route is in neither list, so a new route can't be added silently.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ParameterContract {
  name: string;
  required?: boolean;
  description: string;
  /** A JSON Schema for the value; query values arrive as strings. */
  schema: Record<string, unknown>;
}

export type ResponseContract =
  /** A JSON body of this type from `types.ts` or `playback.ts`. */
  | { json: string; array?: boolean; status?: number }
  /** Not JSON: images, video, subtitles, playlists. */
  | { contentType: string; status?: number }
  /** A redirect to another URL. */
  | { redirect: true }
  /** No body. */
  | { empty: true; status: 204 };

export interface RouteContract {
  method: HttpMethod;
  /** Fastify path, with `:params`. */
  path: string;
  summary: string;
  /**
   * Who may call it: anyone; anyone signed in, with the dashboard's cookie or
   * a paired device's bearer token; a person signed in to the dashboard (not
   * a paired device); or an administrator.
   */
  auth: "none" | "user" | "person" | "admin";
  query?: ParameterContract[];
  headers?: ParameterContract[];
  /** The JSON request body, by type name. */
  body?: string;
  /** Descriptions for path parameters, by name. */
  params?: Record<string, ParameterContract>;
  response: ResponseContract;
}

const id = (description: string): ParameterContract => ({
  name: "",
  required: true,
  description,
  schema: { type: "string" },
});

const source = (kinds: string[]): ParameterContract => ({
  name: "source",
  required: true,
  description: `Where the id comes from: ${kinds.join(" or ")}.`,
  schema: { type: "string", enum: kinds },
});

const integer = { type: "string", pattern: "^[0-9]+$" };

const playbackClient: ParameterContract = {
  name: "client",
  description:
    "What will play the stream, so the server chooses formats it can decode: `web` (the default) or `tvos` (Apple TV).",
  schema: { type: "string", enum: ["web", "tvos"] },
};

export const API_ROUTES: RouteContract[] = [
  {
    method: "GET",
    path: "/api/health",
    summary: "Liveness check.",
    auth: "none",
    response: { json: "HealthResponse" },
  },
  {
    method: "GET",
    path: "/api/meta",
    summary: "API versions and optional features this server has. Check it before signing in.",
    auth: "none",
    response: { json: "MetaResponse" },
  },
  {
    method: "POST",
    path: "/api/tv/pair/start",
    summary: "A device asks to be paired: returns a code to show and a token to poll with.",
    auth: "none",
    body: "PairingStartRequest",
    response: { json: "PairingStartResponse" },
  },
  {
    method: "GET",
    path: "/api/tv/pair/:code",
    summary: "The device polls until the code is approved or denied; approval carries its token, once.",
    auth: "none",
    params: { code: { ...id("The pairing code."), name: "code" } },
    headers: [
      {
        name: "x-churn-pair-token",
        required: true,
        description: "The pollToken from starting the pairing.",
        schema: { type: "string" },
      },
    ],
    response: { json: "PairingStatusResponse" },
  },
  {
    method: "GET",
    path: "/api/tv/pair/:code/details",
    summary: "What a person is about to approve: the device's name and the code's state.",
    auth: "person",
    params: { code: { ...id("The pairing code."), name: "code" } },
    response: { json: "PairingDetailsResponse" },
  },
  {
    method: "POST",
    path: "/api/tv/pair/:code/approve",
    summary: "Pair the device as the person approving it.",
    auth: "person",
    params: { code: { ...id("The pairing code."), name: "code" } },
    response: { json: "PairingApproveResponse" },
  },
  {
    method: "POST",
    path: "/api/tv/pair/:code/deny",
    summary: "Refuse to pair the device.",
    auth: "person",
    params: { code: { ...id("The pairing code."), name: "code" } },
    response: { empty: true, status: 204 },
  },
  {
    method: "GET",
    path: "/api/tv/devices",
    summary: "Paired devices: your own, or everyone's for an administrator.",
    auth: "person",
    response: { json: "PairedDevicesResponse" },
  },
  {
    method: "DELETE",
    path: "/api/tv/devices/:id",
    summary: "Revoke a paired device. It has to be paired again to sign in.",
    auth: "person",
    params: { id: id("The device id from the device list.") },
    response: { empty: true, status: 204 },
  },
  {
    method: "GET",
    path: "/api/auth/session",
    summary: "Who is signed in, if anyone.",
    auth: "none",
    response: { json: "AuthSessionResponse" },
  },
  {
    method: "GET",
    path: "/api/auth/passkeys/available",
    summary: "Whether passkey sign-in is on, and for which origin.",
    auth: "none",
    response: { json: "PasskeyAvailabilityResponse" },
  },
  {
    method: "GET",
    path: "/api/auth/passkeys",
    summary: "The signed-in person's saved passkeys.",
    auth: "user",
    response: { json: "SavedPasskey", array: true },
  },
  {
    method: "GET",
    path: "/api/auth/profiles",
    summary: "Household members to pick from on the sign-in screen.",
    auth: "none",
    response: { json: "ProfileSummary", array: true },
  },
  {
    method: "GET",
    path: "/api/profiles",
    summary: "Household members, for an administrator to manage.",
    auth: "admin",
    response: { json: "ManagedProfile", array: true },
  },
  {
    method: "GET",
    path: "/api/status",
    summary: "Health of Jellyfin, Sonarr and Radarr.",
    auth: "user",
    response: { json: "StatusResponse" },
  },
  {
    method: "GET",
    path: "/api/stats",
    summary: "Torrent, disk and library statistics.",
    auth: "user",
    response: { json: "StatsResponse" },
  },
  {
    method: "GET",
    path: "/api/vpn",
    summary: "The VPN check: whether downloads leave through the VPN.",
    auth: "user",
    response: { json: "VpnStatusResponse" },
  },
  {
    method: "GET",
    path: "/api/library",
    summary: "Every movie and show in Jellyfin that the signed-in person can see.",
    auth: "user",
    response: { json: "LibraryResponse" },
  },
  {
    method: "GET",
    path: "/api/library/resume",
    summary: "Continue watching: items in progress and next episodes.",
    auth: "user",
    response: { json: "ContinueWatchingResponse" },
  },
  {
    method: "GET",
    path: "/api/library/requested",
    summary: "Titles requested in Sonarr and Radarr that are not in Jellyfin yet.",
    auth: "user",
    response: { json: "RequestedLibraryResponse" },
  },
  {
    method: "GET",
    path: "/api/library/images/:itemId",
    summary: "A Jellyfin poster or backdrop, proxied so the token stays on the server.",
    auth: "user",
    params: { itemId: id("Jellyfin item id.") },
    query: [
      { name: "type", description: "Which image.", schema: { type: "string", enum: ["Primary", "Backdrop"] } },
      { name: "tag", description: "Jellyfin's image tag, for caching.", schema: { type: "string" } },
      { name: "maxWidth", description: "Largest width wanted, in pixels.", schema: integer },
      { name: "maxHeight", description: "Largest height wanted, in pixels.", schema: integer },
    ],
    response: { contentType: "image/*" },
  },
  {
    method: "GET",
    path: "/api/requests/options",
    summary: "Quality profiles, root folders and defaults for a new request.",
    auth: "user",
    response: { json: "RequestOptionsResponse" },
  },
  {
    method: "GET",
    path: "/api/search",
    summary: "Search Sonarr and Radarr for titles to request.",
    auth: "user",
    query: [
      {
        name: "q",
        required: true,
        description: "What to look for, 2 to 120 characters.",
        schema: { type: "string", minLength: 2, maxLength: 120 },
      },
    ],
    response: { json: "SearchResponse" },
  },
  {
    method: "GET",
    path: "/api/search/images/:service",
    summary: "A Sonarr or Radarr poster from an allowed artwork host, proxied.",
    auth: "user",
    params: { service: { ...source(["sonarr", "radarr"]), name: "service", description: "Which service the image came from." } },
    query: [{ name: "url", required: true, description: "The artwork URL.", schema: { type: "string" } }],
    response: { contentType: "image/*" },
  },
  {
    method: "GET",
    path: "/api/activity",
    summary: "Downloads in progress, queued or needing attention.",
    auth: "user",
    response: { json: "ActivityResponse" },
  },
  {
    method: "GET",
    path: "/api/library/shows/:source/:id",
    summary: "A show: its seasons, episodes and what is downloaded.",
    auth: "user",
    params: { source: source(["jellyfin", "sonarr"]), id: id("The show's id in that source.") },
    response: { json: "ShowDetailResponse" },
  },
  {
    method: "GET",
    path: "/api/library/shows/:source/:id/downloads",
    summary: "Episode downloads in progress for a show.",
    auth: "user",
    params: { source: source(["jellyfin", "sonarr"]), id: id("The show's id in that source.") },
    response: { json: "ShowDownloadsResponse" },
  },
  {
    method: "GET",
    path: "/api/library/shows/:source/:id/releases",
    summary: "Cached release search results for a season or episode.",
    auth: "user",
    params: { source: source(["sonarr"]), id: id("Sonarr series id.") },
    query: [
      { name: "season", required: true, description: "Season number.", schema: integer },
      { name: "episode", description: "Episode number, for one episode.", schema: integer },
    ],
    response: { json: "CachedReleasesResponse" },
  },
  {
    method: "GET",
    path: "/api/library/movies/:source/:id",
    summary: "A movie: details and download state.",
    auth: "user",
    params: { source: source(["jellyfin", "radarr"]), id: id("The movie's id in that source.") },
    response: { json: "MovieDetailResponse" },
  },
  {
    method: "GET",
    path: "/api/library/movies/:source/:id/download",
    summary: "A movie's download progress.",
    auth: "user",
    params: { source: source(["jellyfin", "radarr"]), id: id("The movie's id in that source.") },
    response: { json: "MovieDownloadResponse" },
  },
  {
    method: "GET",
    path: "/api/library/movies/:id/releases",
    summary: "Cached release search results for a movie.",
    auth: "user",
    params: { id: id("Radarr movie id.") },
    response: { json: "CachedReleasesResponse" },
  },
  {
    method: "GET",
    path: "/api/playback/items/:itemId",
    summary: "How to play an item: stream URL, quality options, subtitles, segments.",
    auth: "user",
    params: { itemId: id("Jellyfin item id.") },
    query: [
      {
        name: "quality",
        description: "Quality preset; `max` may play the file directly.",
        schema: { type: "string", enum: ["max", "high", "medium", "low"] },
      },
      playbackClient,
    ],
    response: { json: "PlaybackItemResponse" },
  },
  {
    method: "GET",
    path: "/api/playback/items/:itemId/stream",
    summary: "The original file, proxied from Jellyfin for direct play (supports ranges).",
    auth: "user",
    params: { itemId: id("Jellyfin item id.") },
    response: { contentType: "video/*" },
  },
  {
    method: "GET",
    path: "/api/playback/items/:itemId/hls.m3u8",
    summary: "Jellyfin's HLS playlist, proxied, for sources the client can't play directly.",
    auth: "user",
    params: { itemId: id("Jellyfin item id.") },
    query: [playbackClient],
    response: { contentType: "application/vnd.apple.mpegurl" },
  },
  {
    method: "GET",
    path: "/api/playback/items/:itemId/jellyfin/*",
    summary: "HLS segments and playlists the proxied playlist points to.",
    auth: "user",
    params: {
      itemId: id("Jellyfin item id."),
      "*": { ...id("The path inside Jellyfin's HLS output."), name: "*" },
    },
    response: { contentType: "application/octet-stream" },
  },
  {
    method: "GET",
    path: "/api/playback/items/:itemId/subtitles/:index",
    summary: "A text subtitle track as WebVTT.",
    auth: "user",
    params: { itemId: id("Jellyfin item id."), index: { ...id("Jellyfin stream index."), schema: integer } },
    response: { contentType: "text/vtt" },
  },
  {
    method: "GET",
    path: "/api/services/:id/open",
    summary: "Redirect to a service's own web page.",
    auth: "user",
    params: { id: { ...source(["jellyfin", "sonarr", "radarr"]), name: "id", description: "Which service." } },
    response: { redirect: true },
  },
];

/**
 * Routes that change things, not described yet. The next stage of the
 * contract adds their request bodies and responses; until then they are
 * listed here so the completeness test knows about them.
 */
export const UNDESCRIBED_ROUTES: Array<{ method: HttpMethod; path: string }> = [
  { method: "POST", path: "/api/auth/passkeys/authenticate/options" },
  { method: "POST", path: "/api/auth/passkeys/authenticate/verify" },
  { method: "POST", path: "/api/auth/passkeys/register/options" },
  { method: "POST", path: "/api/auth/passkeys/register/verify" },
  { method: "POST", path: "/api/auth/passkeys/register/cancel" },
  { method: "DELETE", path: "/api/auth/passkeys/:id" },
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/profile-login" },
  { method: "POST", path: "/api/auth/logout" },
  { method: "POST", path: "/api/profiles" },
  { method: "POST", path: "/api/profiles/:id/pin" },
  { method: "DELETE", path: "/api/profiles/:id" },
  { method: "DELETE", path: "/api/library/jellyfin/:itemId" },
  { method: "DELETE", path: "/api/library/requested/:service/:id" },
  { method: "DELETE", path: "/api/library/movies/:source/:id/download" },
  { method: "POST", path: "/api/library/movies/:id/releases/refresh" },
  { method: "POST", path: "/api/library/movies/:id/releases/grab" },
  { method: "POST", path: "/api/library/shows/:source/:id/releases/refresh" },
  { method: "POST", path: "/api/library/shows/:source/:id/releases/grab" },
  { method: "DELETE", path: "/api/library/shows/:source/:id/episodes/:season/:episode/download" },
  { method: "POST", path: "/api/playback/items/:itemId/start" },
  { method: "POST", path: "/api/playback/items/:itemId/progress" },
  { method: "POST", path: "/api/playback/items/:itemId/stop" },
  { method: "POST", path: "/api/requests" },
];

/** The contract for a request, matching Fastify's route path. */
export function findRoute(method: string, routePath: string): RouteContract | undefined {
  return API_ROUTES.find((route) => route.method === method && route.path === routePath);
}
