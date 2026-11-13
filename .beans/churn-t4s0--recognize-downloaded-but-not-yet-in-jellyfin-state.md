---
# churn-t4s0
title: Recognize downloaded-but-not-yet-in-Jellyfin state before showing Pick a Version
status: in-progress
type: bug
created_at: 2026-11-13T10:12:44Z
updated_at: 2026-11-13T10:12:44Z
---

When a movie or TV season finishes downloading but Jellyfin is still indexing it, the UI shows the Pick a Version screen. We need to recognize the in-between state (download complete, Jellyfin import/scan pending) and not show the version picker then.

## Plan

User steer: qBittorrent says finished + not yet scanned into Jellyfin ⇒ treat as the "Jellyfin is scanning" state, not the picker.

Live-confirmed on this machine (2026-11-13 02:11): The Matrix torrent complete, mp4 already in `/data/media/movies/The Matrix (1999)/`, Radarr `hasFile=false`, Jellyfin not indexed; page shows the picker because `movieTorrentActivity` filters completed torrents out (`qbittorrent-activity.ts` `isActiveTorrent`), so `download=undefined` and `jellyfinId=undefined`.
Show side already recognizes the window end to end: completed torrent → "importing" rows (`qbittorrent-show.ts` `torrentDownload`) → season picker suppressed; after Sonarr import → `ShowEpisode.imported` → EpisodeRow "Waiting for Jellyfin" (verified live: Parks and Recreation S04, 22/22 `hasFile`).

1. `server/backend/src/qbittorrent-activity.ts` — `movieTorrentActivity`: include matched COMPLETED torrents and map them to status "importing" (reuse `isCompletedTorrent` from download-import.ts). Messages mirrored from qbittorrent-show.ts: direct torrent → "Download finished in qBittorrent. Jellyfin has not indexed it yet."; else "…Radarr has not imported it yet.". New option `indexed?: boolean` — when true (Jellyfin item already known, e.g. jellyfin-source page or an upgrade behind a playable item), keep excluding completed torrents so a seeding old torrent never claims "not indexed yet".
2. `server/backend/src/live-downloads.ts` — `MovieDownloadIdentity` gains `indexed?: boolean`; `movieLiveDownload` passes it through. Detail routes remember it: jellyfin source → true; radarr source → whether the Jellyfin lookup found the item.
3. `server/backend/src/routes/movies.ts` — `loadRadarrMovie`: when the movie has a file OR a download is in flight (completed torrent present), look it up in Jellyfin by tmdbId (new helper `findJellyfinMovieByTmdb(config, tmdbId)` using `listItemsByType("Movie")` + provider match, same approach as `isDirectDownloadIndexed`). Found → set `jellyfinId` (page flips playable) and drop an "importing" download. Not found and `hasFile` → response gains `imported: true`. No new Library/Refresh calls — library-scan.ts's background watcher already refreshes Jellyfin on arr `downloadFolderImported` events and churn-direct completions. Radarr `hasFile` is only set after import, so gating the lookup on it alone left a completed-but-unimported movie stuck on "importing" (see Summary).
4. `server/backend/src/types.ts` — `MovieDetailResponse` gains `imported?: boolean` ("Radarr imported the file, Jellyfin has not indexed it yet").
5. `server/frontend/src/pages/MoviePage.tsx` — `showPicker` guarded by `!imported`; while `download.status === "importing"` the existing downloading pill gets label "Importing"; when `imported` and no download (torrent removed before indexing) render a new `TitleAction` kind "importing": dot + "Waiting for Jellyfin" (EpisodeRow wording). Menu unchanged (Cancel request stays reachable).
6. Tests — qbittorrent-activity: completed + not indexed → "importing" with direct/arr message variants; completed + indexed → excluded; active torrents unchanged.

Non-goal (deferred): Sonarr-sourced show page never looks Jellyfin up, so it shows "Waiting for Jellyfin" until the user navigates away and back; library links switch to the jellyfin source once indexed, which heals it. Separate bean if it bothers.

## Todos

- [x] movieTorrentActivity includes completed torrents as importing with indexed gate
- [x] MovieDownloadIdentity.indexed plumbed through live-downloads + detail routes
- [x] loadRadarrMovie Jellyfin tmdbId lookup → jellyfinId or imported flag
- [x] MovieDetailResponse.imported type
- [x] MoviePage: picker guard, Importing pill label, Waiting for Jellyfin action
- [x] vitest coverage for movieTorrentActivity states
- [x] Radarr detail: Jellyfin lookup runs while a torrent is in flight (fixes stuck "importing" on The Matrix page)
- [x] Route regression tests: finished radarr download stays importing until Jellyfin lists the movie; then drops and sets jellyfinId
- [ ] Live UI check of The Matrix page after reload (user-side; session auth blocks curl)

## Summary of Changes

Backend:
- `server/backend/src/qbittorrent-activity.ts` — `QbittorrentActivityOptions.indexed?: boolean`; `movieTorrentActivity` now maps matched completed torrents (`isCompletedTorrent`) to an "importing" activity (progress 100) with message "Download finished in qBittorrent. Jellyfin has not indexed it yet." (direct/tagged) or "…Radarr has not imported it yet." (arr import path). When `indexed` is true/undefined, completed torrents stay excluded as before.
- `server/backend/src/live-downloads.ts` — `MovieDownloadIdentity.indexed?: boolean` plumbed into `movieLiveDownload`.
- `server/backend/src/routes/movies.ts` — `loadRadarrMovie`: the Jellyfin tmdbId lookup (`findJellyfinMovieByTmdb`, provider-id match like `routes/library.ts`) runs when Radarr reports `hasFile` OR a download exists for the movie. Found → `jellyfinId` on the response and an "importing" download is dropped (page flips playable). Not found and `hasFile` → `imported: true`. Downloads are requested with `indexed: false` on this path so completed torrents surface as "importing" while the lookup decides. The detail route remembers `indexed: jellyfinId !== undefined` so the lean download endpoint stays consistent between polls. Fixes the stuck state on The Matrix page: Radarr's `hasFile` only flips after import, so gating the lookup on it alone left a finished-but-unimported torrent stuck on "importing" with no Jellyfin id ever set. Accepted cost: one `listItemsByType("Movie")` per 10s detail poll while a torrent is in flight and not indexed. No new Library/Refresh calls — the `library-scan.ts` watcher already refreshes Jellyfin on arr import events and churn-direct completions.
- `server/backend/src/types.ts` — `MovieDetailResponse.imported?: boolean`.

Frontend:
- `server/frontend/src/features/title/TitlePrimaryAction.tsx` — new `TitleAction` kind `"importing"` (pulsing dot + "Waiting for Jellyfin"); downloading pill accepts optional `label` ("Importing").
- `server/frontend/src/pages/MoviePage.tsx` — `imported` from the detail response: `showPicker` requires `!imported` (the file is chosen, only indexing is pending); downloading pill shows "Importing" while `download.status === "importing"`; when the torrent is gone but Jellyfin has not indexed yet, the title action shows "Waiting for Jellyfin" instead of "Not downloaded yet". Playback type named `TitlePlayback` per style rule.
- `server/frontend/src/api/types.ts` — mirrored `imported?: boolean`.

Tests: `server/backend/test/qbittorrent-activity.test.ts` +3 cases (completed→importing with both message variants; completed stays hidden when indexed; active torrent preferred over completed). `server/backend/test/routes.test.ts` +2 regression cases on the Radarr detail route: a finished download with Jellyfin not listing the movie stays `importing` (no `jellyfinId`); once Jellyfin lists it (Tmdb 438631) the download is dropped and `jellyfinId` is set. Full suites green: backend 405 tests / 31 files, frontend 48 tests / 7 files, `tsc --noEmit` clean on both, `vite build` succeeds (a root-owned stale `node_modules/.vite-temp` from the running service blocked the first build attempt; removed the empty temp dir). Live UI verification of The Matrix page still pending: the running backend auto-reloads via `tsx watch`, but `/api/*` needs a session so it cannot be curled from here, and the Jellyfin apiKey is unreadable to the probe user (server/.env is root-only), so the live Jellyfin path is covered only by the mocked route tests.

