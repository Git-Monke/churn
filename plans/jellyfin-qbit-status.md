# Jellyfin + qBittorrent as the UI status source

## Context

Churn currently mixes four concepts:

- the local catalog of titles added to Sonarr/Radarr;
- played/available media in Jellyfin;
- active downloads in Sonarr/Radarr queues;
- live qBittorrent progress overlaid onto those queue records.

That coupling produces stale UI: an arr queue can lag behind qBittorrent, a
completed download can linger as “downloading”, and a deleted title can remain
in Jellyfin. The desired split is:

- **Sonarr/Radarr** remain the local library catalog and the search/grab/import
  broker. They still add titles, filter/rank releases, grab through their
  download clients, and import completed downloads.
- **Jellyfin** is the only source of “playable / available”.
- **qBittorrent** is the only source of “currently downloading”.
- No new local request database is introduced. `/api/library/requested` remains
  the local catalog of titles added to Sonarr/Radarr, so a show/movie is still
  visible for release selection before anything has downloaded.
- Show pages keep Sonarr episodes so missing episodes can still be selected, but
  Sonarr `hasFile`/queue state no longer determines playability or download
  progress.
- Title deletion remains arr-backed, but also cleans up matching qBittorrent
  torrents and stale Jellyfin entries.

## Decisions

- Keep Sonarr/Radarr as grab/import brokers; do not send torrents directly to
  qBittorrent.
- Keep the existing requested-library rows as the local catalog.
- Library status:
  - **Available** only when a matching Jellyfin item exists.
  - **Downloading** only when a matching active qBittorrent torrent exists.
  - **Requested** when only the local arr catalog row exists.
  - **Scanning** may remain as a transitional state when the arr has imported
    files but Jellyfin has not indexed them yet. It is never labelled Available
    and never becomes a play link.
- Search results: Available comes from Jellyfin; Requested comes from the arr
  catalog.
- Show page: union Jellyfin + Sonarr episodes, but playability is Jellyfin-only.
  Sonarr `hasFile` becomes a non-playable “waiting for Jellyfin” hint. Downloads
  come from qBittorrent only.
- Delete keeps the current arr-backed title removal and adds qBittorrent cleanup.

## Approach

### 1. Define the new status semantics in types

Update `server/backend/src/types.ts` and
`server/frontend/src/api/types.ts`:

- Keep `RequestedLibraryItem`, but document `available` as an arr import hint
  used only for scanning/prefetch. It must not drive the Available badge or play
  links.
- Change `ActivityServiceState.id` to support `"qbittorrent"` (the activity feed
  now reports qBittorrent health, not arr queue health).
- Make `ActivityItem`’s arr-specific fields (`service`, `movieId`, `seriesId`)
  optional or remove them where unused. Keep `key` so matched downloads merge
  with the local catalog.
- Add an explicit show-episode hint such as `imported?: boolean` if needed to
  distinguish “Sonarr has a file, Jellyfin does not yet” from “missing”.
- Keep `ShowAvailability` values meaningful: Jellyfin can play, missing, or
  upcoming. Do not use a `"sonarr"` availability to imply playability.

### 2. Replace `/api/activity` with a qBittorrent-only feed

Add a pure qBittorrent activity mapper (for example
`server/backend/src/qbittorrent-activity.ts`) and simplify
`server/backend/src/activity-feed.ts`.

- Fetch only active qBittorrent torrents. A torrent is active while
  `progress < 1` and its state is not a terminal error/missing-files state.
  Completed seeding torrents are not “currently downloading” and should not
  appear.
- Load Sonarr/Radarr **catalogs** (`listSeries()` / `listMovies()`) only to match
  torrents to the local library. Do not read `/api/v3/queue`.
- Cache the catalogs for the existing metadata TTL so the 500 ms UI poll remains
  cheap.
- Match torrents to catalog titles:
  - TV category or an `SxxExx` marker → series title matching; reuse/export the
    title-token and season-marker logic from
    `server/backend/src/qbittorrent-show.ts`.
  - Movie category → title + optional year matching.
  - Prefer the longest/most specific title match to avoid prefix collisions.
- Group multiple torrents for the same catalog title into one `ActivityItem`.
  Unmatched torrents remain generic qBittorrent items keyed by hash so they are
  still visible.
- Map status from qBittorrent state/progress only:
  - queued/paused/metaDL → `queued`;
  - downloading/stalledDL → `downloading` (with a status message for stalled);
  - error/missingFiles → `warning`.
- Map progress, size, size-left, speed, ETA and season hints directly from the
  torrent. Report `downloadClients: ["qBittorrent"]` and
  `protocols: ["torrent"]`.
- Keep the snapshot cache/single-flight behavior in `activity-feed.ts`. Report a
  single `qbittorrent` service state; a missing key is `unconfigured`, an
  upstream failure is `unreachable`.

### 3. Keep the requested-library catalog but stop using arr availability

`/api/library/requested` continues to return titles added to Sonarr/Radarr.
Minimal changes:

- Keep enough metadata and `arrId` for release selection, deletion and links.
- Do not use arr `available` for the Available badge or play links.
- Keep the existing background release prefetch; it may still use the internal
  `isSeriesAvailable` / `isMovieAvailable` helpers to decide which seasons need
  searches.
- Do not add a new request store.

### 4. Make search availability Jellyfin-backed

Update `server/backend/src/routes/search.ts` and `search.ts`.

- Fetch the signed-in user’s Jellyfin library (reuse `client.listLibrary`) and
  index it by TVDB/TMDB ids.
- `SearchResult.available` is true only when a matching Jellyfin item exists.
- Keep `inLibrary` from the Sonarr/Radarr catalog so the UI can still show
  **Requested** for added-but-not-playable titles.
- Stop using `isSeriesAvailable` / `isMovieAvailable` for search result
  availability. Those helpers remain for request prefetching.
- If Jellyfin is unavailable, leave availability unknown/undefined rather than
  falling back to arr file state.

### 5. Rework show detail to use Jellyfin + qBittorrent only

Update `server/backend/src/routes/shows.ts`, `server/backend/src/shows.ts`, and
frontend show types.

- Jellyfin source: load the Jellyfin series/seasons/episodes as today. Match
  Sonarr by TVDB id only to fetch episodes for missing/release-selection context
  and to run release searches. Do not fetch or use the Sonarr queue.
- Sonarr-only source: still supported for catalog titles not yet in Jellyfin;
  use Sonarr metadata/episodes plus qBittorrent downloads. Do not fetch the
  Sonarr queue.
- Fetch qBittorrent torrents once and pass only those into `buildShowDetail`.
  Remove `queueRecords`/`downloadOverlay` from the show-building path.
- Use `mapShowTorrentDownloads` for all episode candidates, not only missing
  episodes, so an active upgrade/replacement is visible alongside a playable
  episode.
- Availability:
  - `jellyfin` when Jellyfin has the episode;
  - `upcoming` from air date metadata;
  - otherwise `missing`.
  - If Sonarr says `hasFile` but Jellyfin does not, expose a non-playable hint
    (`imported`) so the UI can show “Waiting for Jellyfin” and suppress duplicate
    release prompts.
- Keep `recoverCompletedShowDownloads` as the import trigger; it still asks
  Sonarr to scan completed qBittorrent payloads. It no longer supplies status.
- Episode cancellation: keep the existing Sonarr-backed cancel when a queue
  record exists. If the download is only known from qBittorrent, add a fallback
  that removes the matched qBittorrent torrent (without deleting files) so
  qBittorrent-only downloads remain cancellable.

### 6. Movie detail

`server/backend/src/routes/movies.ts` stays mostly as-is:

- Jellyfin movie detail determines playability.
- Radarr is used to match the movie for release search/grabbing.
- Radarr-only movies still open a detail page for release selection, but are
  never labelled playable without a Jellyfin item.
- No queue-status overlay is added.

### 7. Frontend status merge

Update `LibraryPage.tsx`, `library-entries.ts`, `LibraryGrid.tsx`,
`SearchResultCard.tsx`, and `ShowPage.tsx`.

- Library still merges Jellyfin items, requested catalog items and qBittorrent
  activity items by the existing provider-id keys.
- `Available` badge/play link only when `entry.library` exists.
- `Downloading`/`both` when `entry.activity` exists.
- `Requested` when only `entry.requested` exists.
- Keep `scanning` only for the “arr imported, Jellyfin not indexed yet” state;
  keep the timeout/scan-problem UI.
- Activity notices now refer to qBittorrent, not Sonarr/Radarr.
- Search cards show Available from Jellyfin and Requested from the arr catalog.
- Show page uses qBittorrent download rows and Jellyfin play links; Sonarr
  episodes are still listed for missing-episode release selection.
- Keep polling fast while qBittorrent activity exists and while a Jellyfin scan
  is in flight; slow down when idle.

### 8. Delete cleanup

Keep `DELETE /api/library/requested/:service/:id` arr-backed, then harden it:

- Before deleting the arr title, fetch its title and, for series, its episodes.
- Match qBittorrent torrents by the same title/episode helpers used by the
  activity feed.
- After the arr delete succeeds, remove matched qBittorrent torrents with
  `deleteFiles=true`. Do not remove qBittorrent torrents if the arr delete
  failed.
- Invalidate the release cache and refresh Jellyfin as today.
- Request one follow-up Jellyfin refresh after a short delay so a scan that
  started mid-delete does not leave stale episodes behind (the current
  Parks-and-Recreation failure mode).

## Files to modify

Backend:

- `server/backend/src/types.ts`
- `server/backend/src/activity-feed.ts`
- `server/backend/src/activity.ts` (only where shared helpers remain useful)
- `server/backend/src/qbittorrent-show.ts`
- new `server/backend/src/qbittorrent-activity.ts` (or equivalent)
- `server/backend/src/routes/activity.ts`
- `server/backend/src/routes/requested.ts`
- `server/backend/src/routes/search.ts`
- `server/backend/src/search.ts`
- `server/backend/src/routes/shows.ts`
- `server/backend/src/shows.ts`
- `server/backend/src/routes/movies.ts` (small type/status cleanup)
- `server/backend/test/activity-feed.test.ts`
- `server/backend/test/activity.test.ts`
- new qBittorrent activity tests
- `server/backend/test/qbittorrent-show.test.ts`
- `server/backend/test/routes.test.ts`
- `server/backend/test/shows.test.ts`

Frontend:

- `server/frontend/src/api/types.ts`
- `server/frontend/src/pages/LibraryPage.tsx`
- `server/frontend/src/pages/ShowPage.tsx`
- `server/frontend/src/pages/MoviePage.tsx`
- `server/frontend/src/features/library/library-entries.ts`
- `server/frontend/src/features/library/LibraryGrid.tsx`
- `server/frontend/src/features/search/SearchResultCard.tsx`
- `server/frontend/src/features/search/SearchSection.tsx` (only invalidation/status text)
- `server/frontend/src/features/show/CancelEpisodeDownloadDialog.tsx` (only if qBittorrent fallback changes wording)

Docs:

- `README.md`
- `docs/src/web-ui.md`
- `server/README.md` if configuration/status behaviour is described there

## Reuse

- `server/backend/src/qbittorrent-show.ts` — existing title tokenization,
  season/episode markers and `mapShowTorrentDownloads`.
- `server/backend/src/torrent-progress.ts` — duration formatting and progress
  helpers.
- `server/backend/src/upstream/qbittorrent.ts` — typed torrent list, existing
  `removeTorrent`.
- `server/backend/src/upstream/jellyfin.ts` — `listLibrary`, `listItemsByType`,
  `getSeasons`, `getEpisodes`, `refreshLibrary`.
- `server/backend/src/upstream/servarr.ts` — `listSeries`, `listMovies`,
  `getSeries`, `getEpisodes`, release search/grab, delete and queue removal.
- `server/backend/src/search.ts` — `mapSeriesResource`, `mapMovieResource`,
  `isSeriesAvailable`, `isMovieAvailable`.
- `server/backend/src/activity.ts` — `ActivityItem` aggregation patterns,
  `queueRecordSeasons`/season parsing and status labels where still applicable.
- `server/backend/src/library-scan.ts` — import watcher and
  `refreshJellyfinLibrary`.
- `server/frontend/src/features/library/library-entries.ts` — existing merge and
  scan-state pipeline.

## Steps

- [x] Update shared activity/requested/show types for the new source-of-truth
      semantics.
- [x] Build the qBittorrent-only activity mapper and tests.
- [x] Rewrite `activity-feed.ts` to read qBittorrent + arr catalogs, not queues.
- [x] Update `/api/activity` service state and Library notices to qBittorrent.
- [x] Switch search availability to Jellyfin while keeping arr Requested markers.
- [x] Remove Sonarr/Radarr queue input from show detail; use qBittorrent only.
- [x] Add the `imported`/waiting-for-Jellyfin hint and adjust show UI actions.
- [x] Update Library merge/status so only Jellyfin sets Available/play.
- [x] Keep scanning only as a non-playable transition state.
- [x] Add qBittorrent cleanup to title deletion and the follow-up Jellyfin
      refresh.
- [x] Add qBittorrent fallback for episode cancel if needed by the new overlay.
- [x] Update tests and documentation.
- [x] Run typecheck, tests, production build and manual checks.

## Verification

Automated:

```bash
cd server
npm test
npm run typecheck
npm run build
```

New/updated tests should cover:

- completed/seeding torrents are excluded from active activity;
- active torrents map to series/movies by title and season markers;
- unmatched torrents still appear with a qBittorrent-only key;
- multiple torrents for one title aggregate progress/speed/ETA;
- Sonarr/Radarr queue failures do not affect activity or Library status;
- search Available is true only for Jellyfin matches, while `inLibrary` still
  marks requested titles;
- show detail marks Jellyfin episodes playable, keeps Sonarr missing episodes,
  and takes download status only from qBittorrent;
- title delete removes matched qBittorrent torrents and refreshes Jellyfin.

Manual:

1. Add a show in Search but do not download anything. Confirm it appears as
   **Requested** in Library and its show page can still select releases.
2. Start a torrent. Confirm Library and the show page show live qBittorrent
   progress/speed/ETA without waiting for a Sonarr/Radarr queue update.
3. Let it import. Confirm the qBittorrent download disappears, the card becomes
   **Scanning** briefly, then **Available** with a play link once Jellyfin sees
   it.
4. Stop Sonarr/Radarr. Confirm Jellyfin Library cards stay available/playable and
   active qBittorrent downloads still show; only release-search/request actions
   report arr errors.
5. Stop qBittorrent. Confirm Jellyfin titles remain playable and only the
   qBittorrent download notice appears.
6. Delete a title with an active/seeding torrent. Confirm the arr entry, matching
   qBittorrent torrent, files and Jellyfin episodes are removed after the
   follow-up scan.
