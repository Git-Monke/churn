# Video playback

## Context

The account system is done: every request runs as a signed-in Jellyfin user,
and the backend holds that user's `AccessToken` in the in-memory session
(`request.auth.accessToken`, `request.auth.user.id`). This plan resumes the
playback work that was paused for auth, but replaces the old installer-provisioned
`JELLYFIN_USER_TOKEN` design with the signed-in session identity.

The dashboard covers library browsing, search/requests, active downloads and
show detail, but every playback action still means opening Jellyfin in another
tab. This adds an in-app player, Jellyfin resume positions and playback reporting
so watched state syncs back to Jellyfin.

Decisions made with the user:

- **In-app player**: an HTML5 `<video>` page inside the dashboard.
- **Same-origin redirect streaming**: `<video>` points at
  `/api/playback/items/:itemId/stream`. The backend validates the session and
  returns a `302` to the Jellyfin stream URL containing the user's token. Video
  bytes come straight from Jellyfin; the token stays out of the DOM/`src` (but
  is still visible in devtools, which is accepted). No backend video proxy.
- **Report to Jellyfin**: send playback start/progress/stop so resume works in
  Jellyfin apps too.
- **Entry points**: movie cards in Library and episode rows in show detail.
- **No Continue Watching row this round** (not selected by the user). The old
  plan's `/api/playback/resume` route and row are dropped.
- **No watched/unwatched toggle** this round.
- **`JELLYFIN_PUBLIC_URL`**: the browser-facing Jellyfin address, defaulting to
  `JELLYFIN_URL`. This keeps Docker/service-DNS backend URLs working.

### Why the session token is the right credential

Jellyfin API keys have no user identity. `POST /Sessions/Playing*` resolves the
user from the access token, and `/UserItems/Resume` is per user. The session
already stores the token returned by `/Users/AuthenticateByName`, so playback
gets per-user resume and reporting for free. No new `.env` token, no installer
change, and existing installs do not need to re-run `churn`.

### Security tradeoff (accepted)

The redirect target contains the user's Jellyfin access token as `api_key`
because a redirect cannot add request headers. The token is that user's own
session, not the admin API key. It appears in devtools/network and the browser's
redirect cache, but not in the page DOM. Jellyfin still enforces the user's
library access. If Churn is exposed beyond the LAN, a backend proxy would be the
stricter option.

## Approach

### 1. Backend config

`server/backend/src/config.ts`:

- Add `jellyfinPublicUrl: string` to `AppConfig`, read from
  `JELLYFIN_PUBLIC_URL` and defaulting to `services.jellyfin.url`.
- Validate/normalize it with the existing `normalizeUrl` helper (http/https,
  trailing slashes stripped). Keep `JELLYFIN_URL` as the backend address.
- Update `server/backend/test/config.test.ts` (default and override) and the
  `makeConfig` helper in `server/backend/test/routes.test.ts`.

No `JELLYFIN_USER_TOKEN` and no `src/`/`tests/` Rust changes.

### 2. Jellyfin client extensions

`server/backend/src/upstream/jellyfin.ts`:

- Extend `JellyfinItem` with
  `UserData?: { PlaybackPositionTicks?, Played?, PlayCount?, LastPlayedDate? }`,
  `SeriesName?`, and `SeriesId?`.
- Add `PlaybackInfoResponse`, `JellyfinMediaSource` and `JellyfinMediaStream`
  types (`Id`, `SupportsDirectPlay`, `SupportsDirectStream`,
  `SupportsTranscoding`, `Container`, `Name`).
- Extend `getItem(itemId, userId?)` to append `userId` so Jellyfin returns
  `UserData`.
- Add `getPlaybackInfo(itemId, userId)` →
  `GET /Items/:id/PlaybackInfo?userId=`.
- Add `reportPlaybackStart/Progress/Stopped(body)` posting to
  `/Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped`
  with the client's token and the existing `X-Emby-*` device headers.
- Use `fetchWithTimeout` + `upstreamResponseError` for reporting, **not**
  `postJson`: Jellyfin returns `204 No Content`, and `fetchJson` rejects empty
  bodies as invalid JSON.
- Existing callers keep using `createJellyfinClient(service, timeout, token)`;
  playback passes `request.auth.accessToken`.

### 3. Playback helpers

New `server/backend/src/playback.ts`:

- `playbackStreamPath(itemId, mediaSourceId, playSessionId)` → same-origin
  `/api/playback/items/:itemId/stream?...` used as the `<video>` source.
- `buildJellyfinStreamUrl(publicUrl, itemId, mediaSourceId, playSessionId, token)`
  → `${publicUrl}/Videos/{itemId}/stream?static=true&mediaSourceId=...&playSessionId=...&api_key=...`.
  Concatenate onto `publicUrl` rather than using `new URL("/...")` so a
  sub-path public URL (e.g. `https://host/jellyfin`) survives.
- `pickMediaSource(playbackInfo)` → first source plus `PlaySessionId`, with
  `SupportsDirectPlay`/`SupportsDirectStream`.
- `mapPlaybackItem(item, source, playSessionId, streamUrl)` → the API item shape
  (id, type, name, series/season/episode, year, overview, runtimeTicks,
  positionTicks, played, imageUrl, directPlay).
- `parsePlaybackReport(body)` → validates/normalizes
  `{ positionTicks?, playSessionId?, mediaSourceId?, isPaused? }`; ticks must be
  a non-negative safe integer, session/source ids match
  `/^[A-Za-z0-9._~-]{1,128}$/`.
- `playbackReportBodies(itemId, input)` → PascalCase Jellyfin payloads for start
  / progress / stop (`ItemId`, `MediaSourceId`, `PlaySessionId`,
  `PositionTicks`, `CanSeek`, `IsPaused`, `IsMuted`, `PlayMethod: "DirectPlay"`,
  plus `Failed: false` on stop).

Unit-test these in a new `server/backend/test/playback.test.ts`.

### 4. Playback routes

New `server/backend/src/routes/playback.ts`, registered in
`server/backend/src/server.ts` alongside the other route modules:

```ts
GET  /api/playback/items/:itemId
GET  /api/playback/items/:itemId/stream
POST /api/playback/items/:itemId/start
POST /api/playback/items/:itemId/progress
POST /api/playback/items/:itemId/stop
```

`GET /api/playback/items/:itemId` returns:

```ts
interface PlaybackItemResponse {
  state: "ok" | "unauthorized" | "unreachable";
  detail?: string;
  item?: {
    id: string;
    type: "Movie" | "Episode";
    name: string;
    seriesName?: string;
    seriesId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    year?: number;
    overview?: string;
    runtimeTicks?: number;
    positionTicks?: number;
    played?: boolean;
    imageUrl?: string;
    streamUrl: string;      // same-origin redirect endpoint
    playSessionId?: string;
    mediaSourceId?: string;
    directPlay: boolean;    // mediaSource.SupportsDirectPlay
  };
}
```

Flow:

1. `requireAuth(request)` — the global auth hook already enforces the cookie.
2. Validate the item id with the existing `/^[A-Za-z0-9-]{1,64}$/` pattern.
3. `getItem(itemId, auth.user.id)` and `getPlaybackInfo(itemId, auth.user.id)`
   in parallel with the session token.
4. `pickMediaSource`; build `streamUrl` via `playbackStreamPath` including the
   chosen `mediaSourceId`/`playSessionId` so reports use the same values.
5. Map the image with the existing `/api/library/images/:itemId?tag=` shape.
6. Errors: 401/403 → `unauthorized`; transport/invalid JSON → `unreachable`;
   missing item → 404; invalid id → 400. `cache-control: no-store`.

`GET /api/playback/items/:itemId/stream`:

1. `requireAuth`, validate id and optional `mediaSourceId`/`playSessionId`
   query strings.
2. If both query values are absent, call `getPlaybackInfo` to choose a source.
   If present, use them directly; they came from Churn's own metadata response.
3. Build the Jellyfin URL with `JELLYFIN_PUBLIC_URL` and the session token.
4. Return `reply.header("cache-control", "no-store")`
   `.header("referrer-policy", "no-referrer")` and a `302` redirect.
5. On 401/403, call `expireSession(request)` and return 401. On other upstream
   failures return 502. Do not log the redirect URL.

The browser follows the redirect for the initial request and then sends Range
requests directly to Jellyfin. Seeking works because Jellyfin serves byte
ranges for `static=true`.

The three POST routes:

1. `requireAuth`, validate id, `parsePlaybackReport(request.body)`.
2. Build payloads with `playbackReportBodies`.
3. Call the client report method with `auth.accessToken`.
4. On 401/403 `expireSession` + 401 `session_expired` (same pattern as
   library/shows). Otherwise return 204.
5. If Jellyfin is briefly unreachable, return 502; the player keeps playing and
   the next progress tick retries.

Because every route is authenticated, `syncEnabled` is no longer needed: a
missing user token cannot happen. `directPlay: false` remains a warning, not an
error; the player offers Jellyfin as a fallback.

### 5. Show episodes: expose Jellyfin episode ids

`server/backend/src/shows.ts` and `server/backend/src/types.ts`:

- Add `jellyfinId?: string` to `ShowEpisode`.
- `assignIfDefined(episode, "jellyfinId", jellyfin?.Id)` in `mapEpisode`.
- Mirror the field in `server/frontend/src/api/types.ts`.
- Extend `server/backend/test/shows.test.ts` to assert the id is mapped.

### 6. Frontend API, route and player

`server/frontend/src/api/{client,types}.ts`:

- Add `PlaybackItemResponse`, `PlaybackItem`, `PlaybackReport` types.
- `fetchPlayback(itemId)`, `reportPlaybackStart/Progress/Stop(itemId, body)`.
  The report calls can use `requestJson<null>`; 204 bodies parse to `null`.

Route: extend `server/frontend/src/hooks/use-hash-route.ts` with
`{ page: "play"; id: string }` for `#/play/<itemId>`. `AppHeader` treats
`play` like `show` (Library highlighted); `App.tsx` renders
`<PlayPage key={id} id={id} />`.

New `server/frontend/src/pages/PlayPage.tsx`:

- Query `["playback", id]` with no polling.
- Loading skeleton; non-`ok` state or missing item renders an `Alert` with a
  re-run/login hint and an **Open Jellyfin** action using the existing
  `/api/services/jellyfin/open` redirect.
- Header: title, `S01E02`/series name/type badge/year/runtime, back link to
  Library (and to the show detail page when `seriesId` is present).
- `<video controls playsInline preload="metadata" poster={imageUrl}
  src={streamUrl}>` in a `Card`.
- On `loadedmetadata`, seek to `positionTicks / 10_000_000` when it is > 0 and
  more than ~30 s from the end; show a short “Resumed” note.
- Reporting with refs so React StrictMode cannot double-start:
  - `onPlay`: report start once.
  - Every ~10 s while playing and on pause: report progress (`isPaused`).
  - `onEnded`: report stop at the duration.
  - Unmount/`pagehide`: send stop with `navigator.sendBeacon` (same-origin, so
    the cookie is included) or `fetch(..., { keepalive: true })`.
  - Ignore reporting failures in the player; keep the video playing.
- Show a warning when `directPlay` is false (“this file may need transcoding;
  open Jellyfin if it does not play”).
- On `<video>` error, show an alert with the same Open Jellyfin action.
- After a successful stop, invalidate `["playback", id]` so reopening the page
  picks up the new resume position.

### 7. Entry points

`server/frontend/src/features/library/LibraryGrid.tsx`:

- Movie cards backed by `entry.library` (Jellyfin movie) link to
  `#/play/<library.id>` and show a small play affordance. Series cards keep
  opening show detail. Requested-only/activity-only movies are not playable.

`server/frontend/src/pages/ShowPage.tsx`:

- `EpisodeRow` receives `playHref` for episodes with `jellyfinId` and
  `availability === "jellyfin"`.
- Render a **Play** button (with `PlayIcon`) next to the existing
  **Choose release** action; keep both right-aligned when present.

### 8. Documentation

- `server/README.md`: add `JELLYFIN_PUBLIC_URL` to the env table, add the five
  playback routes, explain same-origin redirect streaming and the token
  tradeoff, and move playback to done in the roadmap. Remove the “playback, when
  it lands” sentence and replace it with the session-token behavior.
- Root `README.md`: note in-app playback and direct streaming; roadmap item 6
  becomes done/current.
- `docs/src/web-ui.md`: document the player, resume/reporting, movie/episode
  entry points and `JELLYFIN_PUBLIC_URL`; update the future-playback sentence.
- `docs/src/server.md`: update the roadmap wording if needed.

## Files to modify

Backend

- `server/backend/src/config.ts` — `JELLYFIN_PUBLIC_URL`.
- `server/backend/src/upstream/jellyfin.ts` — item `UserData`, PlaybackInfo,
  no-content playback reporting.
- `server/backend/src/playback.ts` (new) — URL/payload/mapping helpers.
- `server/backend/src/routes/playback.ts` (new).
- `server/backend/src/server.ts` — register playback routes.
- `server/backend/src/types.ts` and `server/backend/src/shows.ts` — `jellyfinId`.
- `server/backend/test/{config,routes,jellyfin,shows}.test.ts`; new
  `playback.test.ts`.

Frontend

- `server/frontend/src/api/{client,types}.ts`
- `server/frontend/src/hooks/use-hash-route.ts`
- `server/frontend/src/App.tsx`
- `server/frontend/src/components/AppHeader.tsx`
- `server/frontend/src/pages/PlayPage.tsx` (new)
- `server/frontend/src/pages/ShowPage.tsx`
- `server/frontend/src/features/library/LibraryGrid.tsx`

Docs

- `server/README.md`, `README.md`, `docs/src/web-ui.md`, `docs/src/server.md`.

## Reuse

- Session/auth plumbing: `server/backend/src/auth.ts` (`requireAuth`,
  `expireSession`), the global hook in `server/backend/src/server.ts`.
- Jellyfin client and token override:
  `server/backend/src/upstream/jellyfin.ts`, device headers already defined.
- HTTP/errors: `fetchWithTimeout`, `upstreamResponseError` in
  `server/backend/src/http.ts`; `UpstreamError`, `ApiError`,
  `isUnauthorized` in `server/backend/src/errors.ts`; `stateForError` /
  `errorMessage` in `server/backend/src/upstream/states.ts`.
- Image proxy URL shape and id validation: `mapJellyfinItem` and
  `server/backend/src/routes/library.ts`.
- Route registration and error envelope: `server/backend/src/server.ts`.
- Jellyfin open fallback: `GET /api/services/:id/open` in
  `server/backend/src/routes/services.ts`.
- Hash routing/header nav: `use-hash-route.ts`, `AppHeader.tsx`.
- UI primitives: `Card`, `Badge`, `Alert`, `Button`, `Skeleton`, `Empty`
  under `server/frontend/src/components/ui/`.
- Existing show episode rendering and movie card rendering: `ShowPage.tsx`,
  `LibraryGrid.tsx`.
- Test harness: `buildServer`, `makeConfig`, `installFetch`,
  `buildAuthedServer` in `server/backend/test/routes.test.ts`.

## Steps

- [x] Add `JELLYFIN_PUBLIC_URL` to config and update config/route test helpers.
- [x] Extend the Jellyfin client with `UserData`, `getItem(userId)`,
      `getPlaybackInfo` and no-content playback reporting; add client tests.
- [x] Add `playback.ts` helpers with unit tests.
- [x] Add `/api/playback/*` routes (metadata, redirect stream, start/progress/
      stop) and register them; add authenticated route tests.
- [x] Add `jellyfinId` to show episodes and update show tests.
- [x] Add frontend playback types/client functions.
- [x] Add `#/play/:id` route, header active state and `PlayPage` with resume,
      reporting, unload handling and fallback alerts.
- [x] Add movie-card and episode-row play entry points.
- [x] Update README/docs and roadmap.
- [x] Add browser codec compatibility checks and the HLS transcode fallback
      (see the post-implementation amendment below).

## Verification

Automated:

```bash
cd /home/monke/Projects/churn && cargo test
cd server && npm run typecheck && npm test && npm run build
```

Backend tests must cover:

- `JELLYFIN_PUBLIC_URL` defaults to `JELLYFIN_URL` and overrides it.
- metadata route returns a same-origin `streamUrl` (no token), the chosen
  `mediaSourceId`/`playSessionId` and `positionTicks`/`played` from `UserData`;
- stream route returns a `302` to `JELLYFIN_PUBLIC_URL` with `static=true`, the
  media source, play session and URL-encoded user token, and `no-store`;
- progress/start/stop post the correct PascalCase payloads and `X-Emby-*`
  headers with the session token, and return 204 for Jellyfin's empty body;
- Jellyfin 401/403 expires the session and returns `session_expired`;
- Jellyfin transport failure maps to `unreachable` / 502;
- invalid item ids, tick values and session/source ids are rejected;
- episodes expose `jellyfinId`.

Manual end-to-end (server stack running):

1. `cd server && npm run dev`; sign in with a Jellyfin user.
2. Open Library, click a movie card: the player page loads and the video plays
   directly from Jellyfin.
3. Confirm the network panel shows the same-origin stream URL redirecting to
   Jellyfin; the page DOM/`<video src>` contains no Jellyfin token.
4. Seek forward, navigate back, then reopen the movie: it resumes near the last
   position. Jellyfin Dashboard → Activity shows the Churn web session at the
   current position, and pausing updates it.
5. Let a short item finish; Jellyfin marks it played.
6. Open a Jellyfin show, click **Play** on an episode row: the correct episode
   starts and resumes independently per user.
7. Sign in as a second Jellyfin user with different library access; confirm
   playback and resume positions are scoped to that user.
8. Stop Jellyfin or revoke the user token: the player shows the setup/error
   alert and the Open Jellyfin action works; other pages still render.
9. Try a browser-unsupported codec: the video error alert appears instead of a
   silent blank frame.
10. Set `JELLYFIN_PUBLIC_URL` to a LAN address different from `JELLYFIN_URL`
    and confirm the redirect uses the public address.

## Post-implementation amendment: browser-compatible playback

The original plan treated Jellyfin's `SupportsDirectPlay` as sufficient for the
browser. That is not true for sources such as HEVC video with AC3 audio in an
MKV: Jellyfin can serve the original file, but the browser plays it silently or
not at all.

Implemented after the initial playback work:

- `canBrowserDirectPlay` in `server/backend/src/playback.ts` only allows direct
  play for browser-safe containers (MP4/M4V/MOV/WebM) and codecs (H.264/VP8/
  VP9/AV1 video; AAC/MP3/Opus/Vorbis/FLAC/PCM audio). Missing stream metadata
  still trusts Jellyfin's `SupportsDirectPlay` for older responses.
- `PlaybackItem` now includes `playbackMethod: "direct" | "hls"`. `directPlay`
  reflects browser compatibility, not just Jellyfin's source capability.
- `buildJellyfinHlsUrl` builds a Jellyfin `master.m3u8` URL with explicit
  H.264/AAC parameters, stereo downmix and source-derived `MaxHeight`/
  `VideoBitrate` (bounded to 240–2160p and 1–20 Mbps). Without these parameters
  Jellyfin falls back to a very low default transcode profile.
- `GET /api/playback/items/:itemId/hls.m3u8` validates the session, resolves
  the media source and redirects to that manifest. Direct playback still uses
  `GET /api/playback/items/:itemId/stream` with `static=true`.
- `PlayPage` dynamically imports `hls.js` for HLS items, uses native HLS when
  available, resets fatal errors to the existing **Open Jellyfin** alert, and
  leaves direct-play items on a normal `<video src>`.
- The transcoding warning is now informational (“Transcoding for browser
  playback”) instead of telling the user to leave Churn.
- Tests cover HEVC/AC3 rejection, MP4/H.264/AAC acceptance, HLS URL parameters,
  the HLS redirect route and metadata selecting `playbackMethod: "hls"`.

Verified end-to-end against Jellyfin 10.11.11: a 1080p HEVC/AC3 MKV produced an
HLS stream with H.264 video and stereo AAC audio, and the same-origin HLS route
played through `ffprobe` with the user's session cookie.
