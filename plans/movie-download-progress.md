# Detailed live download stats on movie and show pages

## Context

The expanded movie page (`server/frontend/src/pages/MoviePage.tsx`) currently
shows only a progress bar, `% complete`, and an ETA. The library list already
shows download speed, and qBittorrent already exposes seeder counts
(`num_seeds`, `num_complete`), but they are not aggregated or surfaced:

- `ActivityItem` carries `sizeBytes`, `sizeLeftBytes`, `downloadSpeedBytes`, and
  `timeLeft` from qBittorrent, but no seeder counts.
- `ShowDownload` carries only `sizeBytes` and `timeLeft`, no downloaded bytes,
  speed, or seeders.
- Movie detail refetches every 10s (1s only while waiting for a grab). Show
  detail refetches every 10s, and the route is heavy: Jellyfin `getItem`,
  `getSeasons`, `getEpisodes`, Sonarr `listSeries`/`getEpisodes`, qBittorrent,
  plus import-recovery side effects.

Goal: show speed, downloaded / total size, connected + swarm seeders, and ETA
on both movie and episode download cards, refreshed at 500ms while downloading,
without hammering Jellyfin/Sonarr/Radarr.

## Decisions

- Poll a new lightweight download-only endpoint **twice per second** while a
  download is active.
- Use a cached download identity (title/year for movies, title + episode
  identities for shows). The full detail routes populate the cache; the fast
  endpoint only reads the cache and reads qBittorrent.
- Show **connected and swarm** seeders: `18 connected · 143 in swarm`.
- Show speed, downloaded/total size, seeders, and ETA. No upload speed, peers,
  or raw torrent state.
- Apply the richer stats to **movies and shows/episodes**.

## Approach

### 1. Fast download endpoints with cached identity

Add `server/backend/src/live-downloads.ts`:

- `createLiveDownloadStore({ ttlMs?, now? })` with two TTL maps:
  - `rememberMovie(key, { title, year? })` / `movie(key)`
  - `rememberShow(key, { title, episodes: [{ key, seasonNumber, episodeNumber }] })`
    / `show(key)`
- `loadQbittorrentTorrents(config)` shared helper (moved from
  `routes/shows.ts`; returns `[]` when no API key, throws on request failure).
- `movieLiveDownload(config, identity)` → `movieTorrentActivity(torrents, identity)`.
- `showLiveDownloads(config, identity)` →
  `mapShowTorrentDownloads(torrents, identity.title, identity.episodes)`.

Create one store per route registrar (no shared server state needed):

- `registerMovieRoutes` creates a movie identity store.
  - The existing `GET /api/library/movies/:source/:id` handler remembers
    `{ title, year }` when the detail response is `ok`.
  - Add `GET /api/library/movies/:source/:id/download` returning
    `MovieDownloadResponse { checkedAt, ready, download? }`.
  - `ready` is `false` when the identity cache is cold, so the page keeps using
    the full detail response until the next full-detail load populates it.
- `registerShowRoutes` creates a show identity store.
  - The existing `GET /api/library/shows/:source/:id` handler remembers
    `detail.series.title` plus `detail.episodes` identities.
  - Add `GET /api/library/shows/:source/:id/downloads` returning
    `ShowDownloadsResponse { checkedAt, ready, downloads: Record<episodeKey, ShowDownload> }`.
  - The fast endpoint intentionally skips `recoverCompletedShowDownloads` and
    `markDownloadsImporting`; those side effects stay on the 10s full-detail
    refresh.

Both fast endpoints set `cache-control: no-store` and fail soft on qBittorrent
errors (throw/HTTP error so the frontend keeps previous data instead of hiding
the card).

### 2. Add seeder aggregates to the download shapes

- `QbittorrentTorrent` already exposes:
  - `num_seeds` — seeds currently connected.
  - `num_complete` — seeds the tracker reports for the swarm.
- `qbittorrent-activity.ts`:
  - In `aggregateTorrents()`, sum `nonNegative(t.num_seeds)` and
    `nonNegative(t.num_complete)` across torrents where the field is present.
  - Add `connectedSeeders?: number` and `swarmSeeders?: number` to the
    aggregate and to `ActivityItem`.
  - Assign them in `buildActivityItem`.
- `activity.ts`:
  - Add the two optional fields to `ActivityAggregate` and pass them through
    `buildActivityItem`; arr queue aggregation leaves them undefined.
- `qbittorrent-show.ts` (`torrentDownload`):
  - Add `sizeLeftBytes`, `downloadSpeedBytes`, `connectedSeeders`, and
    `swarmSeeders` to `ShowDownload`, using the existing `nonNegative` /
    `fraction` helpers and `amount_left` when available.
- Mirror all new optional fields in `server/frontend/src/api/types.ts`
  (`ActivityItem` and `ShowDownload`), and add `MovieDownloadResponse` /
  `ShowDownloadsResponse`.

### 3. Frontend polling and overlay

`server/frontend/src/api/client.ts`:

- `fetchMovieDownload(source, id)` → `/api/library/movies/:source/:id/download`.
- `fetchShowDownloads(source, id)` → `/api/library/shows/:source/:id/downloads`.

`MoviePage.tsx`:

- Keep `movieQuery` at 10s.
- Add `downloadQuery` with key `["movie", source, id, "download"]` so existing
  `invalidateQueries({ queryKey: ["movie"] })` covers it.
- Refetch at **500ms** when `awaitingDownload` or a download is present, else
  2s.
- Use the fast response only when `ready` is true; otherwise fall back to
  `movieQuery.data.download` so a cold identity cache never hides the card.
- Keep the 30s `awaitingDownload` timeout.

`ShowPage.tsx`:

- Keep `showQuery` at its current cadence.
- Add `showDownloadQuery` with key `["show", source, id, "downloads"]` so
  existing `invalidateQueries({ queryKey: ["show"] })` covers it.
- Refetch at **500ms** when any download is live, else 2s.
- When `ready`, overlay `downloads[episode.key]` onto the episode list in a
  `useMemo`. Overlay replaces `episode.download`; a missing entry removes the
  stale full-detail download. That keeps all existing badge / choose-release /
  cancel logic working unchanged.
- Grab and cancel already invalidate `["show"]` / `["movie"]`, which now also
  refreshes the fast queries.

### 4. Shared UI + formatting

Add `server/frontend/src/lib/format.ts` with the duplicated helpers:
`formatBytes`, `formatSpeed`, `formatEta`, `formatDownloaded`.

Add `server/frontend/src/features/download/DownloadStats.tsx`:

- Accepts the common subset shared by `ActivityItem` and `ShowDownload`.
- Renders:
  - Speed: `12.4 MB/s`
  - Downloaded: `3.4 GB / 8.1 GB`
  - Seeders: `18 connected · 143 in swarm`
  - ETA: `00:12:34` or a formatted completion time
- `compact` variant for episode rows; full label/value grid for the movie card.
- Omit values that are not available; show `—` for missing ETA.

Use it in `MovieDownloadCard` and `EpisodeRow`, keeping the existing progress
bar and `% complete` line. Replace local `formatBytes` / `formatEta` duplicates
in `MoviePage.tsx`, `ShowPage.tsx`, and `LibraryGrid.tsx` with the shared
helpers.

### 5. Docs

Update `docs/src/web-ui.md` API table with the two new routes and describe that
movie/show download cards show live speed, downloaded/total size, and
connected/swarm seeders while a torrent is active.

## Files to modify

- `server/backend/src/live-downloads.ts` (new) — identity cache + qBit helpers.
- `server/backend/src/routes/movies.ts` — fast endpoint, identity cache writes.
- `server/backend/src/routes/shows.ts` — fast endpoint, identity cache writes,
  reuse shared qBit loader.
- `server/backend/src/qbittorrent-activity.ts` — seeder aggregation.
- `server/backend/src/qbittorrent-show.ts` — speed/size/seeders on `ShowDownload`.
- `server/backend/src/activity.ts` — pass-through aggregate fields.
- `server/backend/src/types.ts` — `ActivityItem`, `ShowDownload`, new responses.
- `server/frontend/src/api/types.ts` — mirror backend types.
- `server/frontend/src/api/client.ts` — fetch helpers.
- `server/frontend/src/pages/MoviePage.tsx` — fast polling + stats.
- `server/frontend/src/pages/ShowPage.tsx` — live overlay + stats.
- `server/frontend/src/features/download/DownloadStats.tsx` (new).
- `server/frontend/src/lib/format.ts` (new).
- `server/frontend/src/features/library/LibraryGrid.tsx` — reuse format helpers.
- `docs/src/web-ui.md` — API + behaviour notes.
- Tests:
  - `server/backend/test/qbittorrent-activity.test.ts` — seeder aggregation.
  - `server/backend/test/qbittorrent-show.test.ts` — `ShowDownload` fields.
  - `server/backend/test/routes.test.ts` — fast endpoints return `ready: false`
    before detail and live download data afterwards (or focused new tests).

## Reuse

- `movieTorrentActivity()` and `buildQbittorrentActivity()` in
  `server/backend/src/qbittorrent-activity.ts`.
- `mapShowTorrentDownloads()` in `server/backend/src/qbittorrent-show.ts`.
- `formatDuration()` in `server/backend/src/torrent-progress.ts`.
- Existing `formatBytes`, `formatSpeed`, `formatEta` implementations in
  `MoviePage.tsx`, `ShowPage.tsx`, `LibraryGrid.tsx` (consolidate).
- Existing React Query cache keys `["movie", ...]` and `["show", ...]` for
  invalidation.
- Existing `loadQbittorrentTorrents` in `routes/shows.ts` (move to shared
  module).

## Steps

- [x] Add `live-downloads.ts` identity store + shared qBit download helpers.
- [x] Add seeder fields to backend activity/show download types.
- [x] Add fast movie and show download endpoints and populate identity caches.
- [x] Add frontend API types/client helpers.
- [x] Add shared formatting helpers and `DownloadStats`.
- [x] Switch `MoviePage` to fast polling and render detailed stats.
- [x] Switch `ShowPage` to fast polling, overlay episode downloads, render stats.
- [x] Update docs.
- [x] Add/adjust backend tests.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build` in `server/`.

## Verification

- `cd server && npm test && npm run typecheck && npm run build`.
- Unit coverage:
  - Multiple torrents sum connected and swarm seeders.
  - Undefined/negative seeder values are omitted rather than shown as `NaN`.
  - `mapShowTorrentDownloads` exposes speed, remaining bytes, and seeders.
  - Fast endpoints return `ready: false` without a cached identity and live
    data once the detail route has run.
- Manual:
  - Open a downloading movie; network tab should show
    `/api/library/movies/.../download` roughly every 500ms.
  - Speed, downloaded/total, connected/swarm seeders and ETA update live.
  - Open a downloading show; episode cards update at the same cadence, including
    season packs.
  - Grab a release from the chooser; the card appears without waiting for the
    next 10s detail refresh.
  - Cancel a download; the card disappears and polling slows to 2s.
  - Stop qBittorrent; the UI keeps the last known download instead of hiding it.
