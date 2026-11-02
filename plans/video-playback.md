# Video playback

## Context

The dashboard covers library browsing, search/requests, active downloads and
show detail, but every playback action still means opening Jellyfin in another
tab. Roadmap step 4 (download history/queue actions) remains open; this plan
takes the playback half of step 5 so movies and episodes can be watched from
Churn, with resume points and watched state written back to Jellyfin.

Decisions made with the user:

- **In-app player**: an HTML5 `<video>` page inside the dashboard.
- **Direct Jellyfin streaming**: the browser receives a Jellyfin stream URL and
  pulls bytes straight from Jellyfin. The backend does not proxy video bytes.
- **Report to Jellyfin**: send playback start/progress/stop so resume works in
  Jellyfin apps too, and expose a Continue Watching row.
- **Entry points**: movie cards in Library, episode rows in show detail, and
  Continue Watching.

### Security tradeoff (accepted)

The direct stream URL must contain a Jellyfin token because `<video>` cannot add
request headers. That token is visible in the browser's DOM and network tab.
Use the **user access token**, not the admin API key, and keep the existing API
key server-side for library/status calls. The app still binds to `127.0.0.1` by
default. If it is ever exposed beyond the LAN, replace direct streaming with a
same-origin redirect or a backend/HLS proxy.

### Why a user token is required

Jellyfin API keys are server-level credentials with no user identity.
`POST /Sessions/Playing*` resolves the user from the access token, so progress
reported with an API key is not attributed to a user. Churn already
authenticates as the admin during install; this plan persists that
`AccessToken` as a user token so playback state syncs to the admin's
Continue Watching.

Existing installs must re-run `churn` once to mint the token; rerunning prompts
for the Jellyfin admin password only when the token is missing. The password is
still not persisted.

## Approach

### 1. Installer: persist a Jellyfin user token

`src/jellyfin.rs`:

- Add `pub const USER_TOKEN_ENV: &str = "JELLYFIN_USER_TOKEN";`.
- Extend the authentication result parsing to keep the existing `AccessToken`.
- Return the token from `provision` and write it with
  `envfile::upsert(env_path, USER_TOKEN_ENV, &token)` next to
  `JELLYFIN_API_KEY`.
- Add `validate_user_token(&self, token)` using `GET /Users/Me` with
  `X-Emby-Token`, mirroring `validate_api_key`.
- Align the installer `AUTH_HEADER` `DeviceId` with the backend's playback
  device id (`churn-web`) so the persisted token and the player use one stable
  Jellyfin device identity. The token is a normal user session token, not an
  API key.

`src/main.rs` `setup_jellyfin`:

- Read both `JELLYFIN_API_KEY` and `JELLYFIN_USER_TOKEN` from process env /
  `server/.env`.
- Only return early when the key is valid **and** the user token is valid.
- Otherwise collect credentials and run `provision`, which reuses a valid API
  key but always persists a fresh user token.
- Keep the current dry-run output and success logging.

### 2. Backend config

`server/backend/src/config.ts`:

- Add `userToken?: string` to `ServiceConfig` (only Jellyfin uses it), read from
  `JELLYFIN_USER_TOKEN`.
- Add `jellyfinPublicUrl: string` to `AppConfig`, read from
  `JELLYFIN_PUBLIC_URL` and defaulting to `services.jellyfin.url`. This lets the
  backend reach Jellyfin over one address while the browser uses another
  (Docker/LAN). Keep `JELLYFIN_URL` as the backend address.
- Update `server/backend/test/routes.test.ts` `makeConfig` and
  `server/backend/test/config.test.ts`.

### 3. Jellyfin client extensions

`server/backend/src/upstream/jellyfin.ts`:

- Extend `JellyfinItem` with `UserData?: { PlaybackPositionTicks?, Played?,
  PlayCount?, LastPlayedDate? }`, `SeriesName?`, `SeriesId?`, and `Type:
  "Episode"` handling.
- Allow an explicit auth token:
  `createJellyfinClient(config, timeoutMs, token = config.apiKey)`. Existing
  callers keep using the API key; playback uses the user token when present.
- Add:
  - `getCurrentUser()` → `GET /Users/Me` (user token).
  - `listUsers()` → `GET /Users` (fallback admin selection).
  - `getItem(itemId, userId?)` → append `userId` to `GET /Items/:id`.
  - `getPlaybackInfo(itemId, userId)` → `GET /Items/:id/PlaybackInfo?userId=`.
  - `getResumeItems(userId, limit)` → `GET /UserItems/Resume` with
    `Limit`, `IncludeItemTypes=Movie,Episode`,
    `Fields=ProductionYear,RunTimeTicks,ProviderIds,Overview`,
    `ImageTypeLimit=1`, `EnableImageTypes=Primary`.
  - `reportPlaybackStart/Progress/Stopped(userToken, body)` posting to
    `/Sessions/Playing`, `/Sessions/Playing/Progress`,
    `/Sessions/Playing/Stopped` with token, client/device headers
    (`X-Emby-Client: Churn`, `X-Emby-Device-Name: Churn Web`,
    `X-Emby-Device-Id: churn-web`, `X-Emby-Client-Version`).
- Add `PlaybackInfoResponse`, `JellyfinMediaSource`, and `JellyfinUser` types.
- Reuse `fetchJson` / `postJson` from `server/backend/src/http.ts`.

### 4. Backend playback module and routes

New `server/backend/src/playback.ts`:

- `resolvePlaybackUser(config)`:
  - token = `jellyfin.userToken ?? jellyfin.apiKey`;
  - with a user token, `GET /Users/Me`;
  - otherwise `GET /Users` and pick an administrator, then the first user;
  - cache `{ userId, tokenKind, expiresAt }` in memory for ~10 minutes, keyed by
    Jellyfin URL + token. No database.
- `buildDirectStreamUrl(publicUrl, itemId, mediaSource, playSessionId, token)`:
  `/Videos/{itemId}/stream?static=true&mediaSourceId=...&playSessionId=...&api_key=...`.
- `mapResumeItem(item)` and `playbackProgress` helpers.

New `server/backend/src/routes/playback.ts`, registered in `server.ts`:

```ts
GET  /api/playback/items/:itemId
POST /api/playback/items/:itemId/start
POST /api/playback/items/:itemId/progress
POST /api/playback/items/:itemId/stop
GET  /api/playback/resume
```

`GET /api/playback/items/:itemId` returns:

```ts
interface PlaybackItemResponse {
  state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
  detail?: string;
  item: {
    id: string;
    type: "Movie" | "Episode";
    name: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    year?: number;
    overview?: string;
    runtimeTicks?: number;
    positionTicks?: number;
    played?: boolean;
    imageUrl?: string;
    streamUrl: string;
    playSessionId?: string;
    mediaSourceId?: string;
    directPlay: boolean;   // mediaSource.SupportsDirectPlay
    syncEnabled: boolean;  // user token available
  };
}
```

Flow:

1. Require the Jellyfin API key; otherwise `unconfigured`.
2. Resolve the user (user token or admin fallback).
3. Fetch the item (with `userId`) and `PlaybackInfo` in parallel.
4. Pick the first media source, its `Id`, `SupportsDirectPlay`, and the
   response `PlaySessionId`.
5. Build the direct URL with the playback token; `directPlay: false` is a
   warning, not an error.
6. Map image with the existing `/api/library/images/:itemId?tag=` pattern.

Errors: 401/403 → `unauthorized` with a re-run-churn hint, transport failures
→ `unreachable`, missing item → 404, invalid item id → 400. Cache-control
`no-store`.

`GET /api/playback/resume` returns `{ state, detail?, items, total }` where each
item mirrors the resume card fields (`itemId`, `type`, name, series/season/
episode, year, runtime, `positionTicks`, percent, image URL). It uses
`/UserItems/Resume` with the resolved user id; a missing user token still works
via API key for reading.

The three POST routes validate `{ positionTicks?, playSessionId?, mediaSourceId?,
isPaused? }`, map to Jellyfin `PlaybackStartInfo` / `PlaybackProgressInfo` /
`PlaybackStopInfo`, and return 204. If no user token is configured they skip
the upstream call and still return 204; the player already knows sync is off
from `syncEnabled`.

### 5. Show episodes: expose Jellyfin episode ids

`server/backend/src/shows.ts` and `server/backend/src/types.ts`:

- Add `jellyfinId?: string` to `ShowEpisode` and map `candidate.jellyfin?.Id`.
- Mirror the field in `server/frontend/src/api/types.ts`.
- Update `server/backend/test/shows.test.ts` expectations where useful.

### 6. Frontend API and player

`server/frontend/src/api/{client,types}.ts`:

- Add `PlaybackItemResponse`, `PlaybackResumeResponse`, `PlaybackReport` types.
- `fetchPlayback(itemId)`, `fetchResume()`,
  `reportPlaybackStart/Progress/Stop(itemId, body)`.

Route: extend `server/frontend/src/hooks/use-hash-route.ts` with
`{ page: "play"; id: string }` for `#/play/<itemId>`. `AppHeader` highlights
Library for play routes; `App.tsx` renders `<PlayPage key={id} id={id} />`.

New `server/frontend/src/pages/PlayPage.tsx`:

- Query `["playback", id]` (`no-store`, no interval).
- `<video controls playsInline preload="metadata" poster={imageUrl}
  src={streamUrl}>`.
- On `loadedmetadata`, seek to `positionTicks / 10_000_000` when it is > 0 and
  not near the end; show a short “Resumed” note.
- Back link to Library and title/meta header reusing `Card`, `Badge`, `Alert`,
  `Skeleton`, `Empty`.
- On `play`, report start once; every ~10 s while playing and on pause, report
  progress; on `ended` or unmount, report stop. Use `navigator.sendBeacon` for
  page unload and `fetch(..., { keepalive: true })` for route cleanup.
- Show a warning when `directPlay` is false (“this file may need transcoding;
  open Jellyfin if it does not play”) and when `syncEnabled` is false (“rerun
  churn to sync progress”).
- On `<video>` error, show an alert with an “Open Jellyfin” action using the
  existing `/api/services/jellyfin/open` redirect.
- After a stop, invalidate `["playback-resume"]` and `["library"]`.

New `server/frontend/src/features/playback/ContinueWatchingRow.tsx`:

- Query `["playback-resume"]` every 30 s on the Library page.
- Horizontal row of poster cards with a progress bar, “Resume S01E02 · 12:34” or
  movie title, linking to `#/play/<itemId>`.
- Hide the row when the list is empty; show a compact alert if Jellyfin is
  unavailable.

Library and show entry points:

- `LibraryGrid`/`LibraryPage`: make available movie cards link to
  `#/play/<library.id>` and show a small play affordance/chevron. Shows keep
  opening show detail.
- `ShowPage` `EpisodeRow`: add a Play/Resume button for episodes with
  `jellyfinId` and `availability === "jellyfin"`, linking to
  `#/play/<jellyfinId>`.
- `LibraryPage` renders `ContinueWatchingRow` above the type tabs.

### 7. Documentation

- `server/README.md`: add `JELLYFIN_USER_TOKEN` and `JELLYFIN_PUBLIC_URL` to the
  env table, list the playback routes, document the direct-stream/token
  tradeoff, and move playback to done in the roadmap.
- Root `README.md` and `docs/src/web-ui.md`: note in-app playback, direct
  streaming and the one-time churn rerun for existing installs.
- `docs/src/server.md`: update the roadmap sentence if needed.

## Files to modify

Installer

- `src/jellyfin.rs` — user-token provisioning/validation.
- `src/main.rs` — reuse/refresh token logic.
- `tests/jellyfin.rs` — token written and reused.

Backend

- `server/backend/src/config.ts` — `JELLYFIN_USER_TOKEN`, `JELLYFIN_PUBLIC_URL`.
- `server/backend/src/upstream/jellyfin.ts` — user/resume/PlaybackInfo/reporting.
- `server/backend/src/playback.ts` (new) — user resolution, URL building, mapping.
- `server/backend/src/routes/playback.ts` (new).
- `server/backend/src/server.ts` — register playback routes.
- `server/backend/src/types.ts` and `server/backend/src/shows.ts` — `jellyfinId`.
- `server/backend/test/{routes,config,shows}.test.ts`, new `playback.test.ts`.

Frontend

- `server/frontend/src/api/{client,types}.ts`
- `server/frontend/src/hooks/use-hash-route.ts`
- `server/frontend/src/App.tsx`
- `server/frontend/src/components/AppHeader.tsx`
- `server/frontend/src/pages/PlayPage.tsx` (new)
- `server/frontend/src/pages/LibraryPage.tsx`
- `server/frontend/src/features/library/LibraryGrid.tsx`
- `server/frontend/src/features/playback/ContinueWatchingRow.tsx` (new)
- `server/frontend/src/pages/ShowPage.tsx`
- `server/frontend/src/api/types.ts` (episode `jellyfinId`)

Docs

- `server/README.md`, `README.md`, `docs/src/web-ui.md`, `docs/src/server.md`.

## Reuse

- Jellyfin auth/error patterns: `server/backend/src/upstream/jellyfin.ts`,
  `server/backend/src/errors.ts`, `server/backend/src/upstream/states.ts`.
- HTTP helpers: `fetchJson`, `postJson` in `server/backend/src/http.ts`.
- Image proxy URL shape: `mapJellyfinItem` and
  `server/backend/src/routes/library.ts`.
- Route registration/error envelope: `server/backend/src/server.ts`.
- Existing hash routing and header nav: `use-hash-route.ts`, `AppHeader.tsx`.
- UI primitives: `Card`, `Badge`, `Alert`, `Button`, `Progress`, `Skeleton`,
  `Empty`, `Tooltip` under `server/frontend/src/components/ui/`.
- Existing show episode rendering: `server/frontend/src/pages/ShowPage.tsx`.
- Existing image fallback/poster rendering: `LibraryGrid.tsx`.

## Steps

- [ ] Installer persists and validates `JELLYFIN_USER_TOKEN`; update Rust tests.
- [ ] Config reads `JELLYFIN_USER_TOKEN` and `JELLYFIN_PUBLIC_URL`; update tests.
- [ ] Extend Jellyfin client with user, item-with-user, PlaybackInfo, resume and
      playback-report methods.
- [ ] Add `playback.ts` helpers (cached user resolution, direct URL builder,
      progress mapping) with unit tests.
- [ ] Add `/api/playback/*` routes and register them.
- [ ] Add `jellyfinId` to show episodes and tests.
- [ ] Add frontend API types/client for playback.
- [ ] Add `#/play/:id` route and `PlayPage` with resume, reporting and fallback
      states.
- [ ] Add Continue Watching row and movie-card / episode-row play entry points.
- [ ] Update README and docs.

## Verification

Automated:

```bash
cd /home/monke/Projects/churn && cargo test
cd server && npm run typecheck && npm test && npm run build
```

Backend tests must cover: stream URL contains the user token/media source/play
session; resume mapping; progress posts correct Jellyfin payloads and headers;
missing user token degrades to `syncEnabled: false`; Jellyfin 401/404/transport
states; invalid ids/ticks rejected.

Manual end-to-end (server stack running):

1. Re-run `sudo ./target/release/churn` (or the release binary) and confirm
   `JELLYFIN_USER_TOKEN` appears in `server/.env` without overwriting hand-added
   keys; restart the backend.
2. `cd server && npm run dev`; open Library and confirm Continue Watching appears
   after watching part of a title.
3. Play a movie: video loads directly from Jellyfin, seeks work (Range), and
   playback resumes near the previous position on reload.
4. While playing, Jellyfin Dashboard → Activity shows the Churn web session at
   the current position; pausing updates it.
5. Navigate back mid-play; stop progress is recorded and Continue Watching
   reflects the position. Let a short item finish and confirm Jellyfin marks it
   played.
6. Play an episode from show detail; confirm the correct episode starts.
7. Stop Jellyfin or use a wrong token: the player shows the setup/error alert and
   the Open Jellyfin action works; the rest of Library still renders.
8. Test a browser-unsupported codec: the video error alert appears instead of a
   silent blank frame.
