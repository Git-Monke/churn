# Retry Jellyfin indexing until the media appears

## Context

Two related problems appeared after a churn-direct season pack download
(Parks and Recreation S2):

1. qBittorrent reported the torrent complete, churn asked Jellyfin to refresh
   once, but Jellyfin did not index the new season. A manual Jellyfin scan fixed
   it. `createLibraryScanWatcher()` in `server/backend/src/library-scan.ts`
   handles finished `churn-direct` torrents by requesting exactly one
   `Library/Refresh`; it never verifies whether Jellyfin actually saw the files
   and never retries.
2. After the manual scan indexed the episodes, the show page showed an episode
   as **Available** *and* **Importing** at the same time. The full show detail
   route already suppresses that stale overlay (`staleImport` in
   `server/backend/src/shows.ts`), but the fast live-download endpoint
   (`/api/library/shows/:source/:id/downloads` → `showLiveDownloads()` →
   `mapShowTorrentDownloads()`) returns the raw finished qBittorrent row and
   the frontend overlays it again.

Intended outcome: a completed direct download keeps triggering Jellyfin
refreshes for up to 10 minutes (stopping early once Jellyfin exposes the
media), and once Jellyfin has it, the live download overlay no longer
contradicts the Available badge while the torrent is still seeding.

## Decisions

- Apply retry-until-visible only to `churn-direct` downloads; leave the
  Sonarr/Radarr import path as it is.
- Retry window: **10 minutes** from first seeing the completed torrent.
- Determine visibility using the same Jellyfin data the frontend uses: a Series
  must have episodes (for the torrent's season) and a Movie must be present in
  Jellyfin. Use the Jellyfin item's `Path` only to locate the item for the
  torrent; do not treat a filesystem path alone as proof of indexing.
- Request a refresh every ~15 seconds per pending torrent window, and check
  visibility every scan poll so the retry loop stops as soon as Jellyfin
  catches up. Jellyfin will not run overlapping library scans, so a faster
  request rate is safe.
- Filter the stale `importing` overlay in the backend live-download endpoint,
  not in the frontend, so every client sees consistent data.

## Approach

### 1. Track pending direct downloads instead of one-shot `seenDirect`

In `server/backend/src/library-scan.ts`:

- Replace the `seenDirect: Set<string>` marker with a
  `pendingDirect: Map<string, DirectPending>` where each entry stores:
  - the latest `QbittorrentTorrent`,
  - `firstSeenAt`,
  - `lastRefreshAt`.
- On each poll, add completed `churn-direct` torrents whose
  `completion_on`/`added_on` is within `recentImportMs`, keyed the same way as
  today (`hash:completedAt`). Update the stored torrent row on later polls.
- For each pending entry:
  - Drop it when it is older than the new 10-minute
    `DEFAULT_DIRECT_RETRY_WINDOW_MS`.
  - Drop it when `isDirectDownloadIndexed(config, torrent)` returns true.
  - Otherwise request a Jellyfin refresh when `lastRefreshAt` is older than
    `DEFAULT_DIRECT_REFRESH_MS` (15s).
- Keep pending entries even if the torrent disappears from qBittorrent, so a
  deleted-after-completion torrent still gets its files indexed within the
  10-minute window.
- Keep the existing arr import watcher (`runScan`, `findUnresolved`) unchanged.

Add injectable options for tests, e.g. `resolveDirect?: (torrent) => Promise<boolean>`,
`directRetryWindowMs?`, `directRefreshMs?`.

### 2. Implement the Jellyfin visibility check

Add an exported helper (name TBD, e.g. `isDirectDownloadIndexed`) in
`library-scan.ts` using `createJellyfinClient()`:

- Prefer the torrent category (`movies` → Movie, otherwise Series) to decide
  which `listItemsByType()` call to make.
- Find the Jellyfin item whose `Path` overlaps the torrent's `content_path`
  (either item folder contains the content path, as for a Series, or the file
  is inside the content path, as for a Movie). Pick the longest/most specific
  match.
- If no item or no `Id`, return false.
- For a Series, call `getEpisodes(item.Id)` and require an episode for the
  torrent's season. Derive seasons with the existing
  `seasonRangeFromTitle()` / `seasonNumberFromTitle()` helpers from
  `server/backend/src/activity.ts` and `server/backend/src/qbittorrent-show.ts`.
  If the torrent name has no season marker, require at least one episode.
- For a Movie, require the matched item to have a `Path`.
- A Jellyfin transport failure means "not verified yet": keep the pending
  entry and try again next poll, but do not start a blind scan loop.

### 3. Filter stale importing rows from the live show-download endpoint

In `server/backend/src/live-downloads.ts`:

- Extend `ShowEpisodeIdentity` with the same fields the full detail already
  knows: `availability: ShowAvailability` and `imported?: boolean`.
- In `showLiveDownloads()`, after `mapShowTorrentDownloads()`, drop a download
  when its status is `"importing"` **and** the cached episode is already
  `availability === "jellyfin"` or `imported === true`. Keep active
  (`downloading`) rows so an upgrade/replacement still shows beside a playable
  episode. This mirrors `staleImport` in `server/backend/src/shows.ts`.

In `server/backend/src/routes/shows.ts`, include those two fields when calling
`downloads.rememberShow(...)`.

## Files to modify

- `server/backend/src/library-scan.ts` — pending direct retries + visibility check.
- `server/backend/src/live-downloads.ts` — stale importing filter.
- `server/backend/src/routes/shows.ts` — cache availability/imported in the live identity.
- `server/backend/test/library-scan.test.ts` — 15s retry scheduling, early stop,
  timeout.
- `server/backend/test/routes.test.ts` or a focused live-downloads test — stale overlay filtered.
- `docs/src/web-ui.md` — describe the retry window and the overlay rule.

## Reuse

- `refreshJellyfinLibrary()` / `createLibraryScanWatcher()` in
  `server/backend/src/library-scan.ts`.
- `isDirectDownloadTorrent()` in `server/backend/src/direct-grab.ts`.
- `isCompletedTorrent()` in `server/backend/src/download-import.ts`.
- `createJellyfinClient().listItemsByType()` / `getEpisodes()` / `refreshLibrary()`
  in `server/backend/src/upstream/jellyfin.ts`.
- `seasonRangeFromTitle()` in `server/backend/src/activity.ts` and
  `seasonNumberFromTitle()` in `server/backend/src/qbittorrent-show.ts`.
- `staleImport` rule in `server/backend/src/shows.ts` (currently only applied to
  the full detail response).
- `createLiveDownloadStore()` / `showLiveDownloads()` in
  `server/backend/src/live-downloads.ts`.

## Steps

- [ ] Add direct retry constants and pending-direct state to `library-scan.ts`.
- [ ] Replace the one-shot `seenDirect` refresh with the retry/visibility loop.
- [ ] Add `isDirectDownloadIndexed()` with the Jellyfin Series/Episode and Movie checks.
- [ ] Extend the injectable watcher options and keep existing arr behavior intact.
- [ ] Add availability/imported to `ShowEpisodeIdentity` and populate it in `routes/shows.ts`.
- [ ] Filter stale `importing` downloads in `showLiveDownloads()`.
- [ ] Update `library-scan` tests: retries after a failed check, stops on visible,
      respects the 15s refresh throttle, gives up after 10 minutes.
- [ ] Add a route/unit test proving a finished direct torrent does not appear in
      live downloads once the cached episode is available.
- [ ] Update `docs/src/web-ui.md`.
- [ ] Run backend tests, typecheck, frontend build.

## Verification

- `cd server/backend && npm test`
- `cd server/backend && npm run typecheck`
- `cd server/frontend && npm run build` (or the repo's usual frontend check)
- Manual: finish a churn-direct season pack, confirm churn issues multiple
  `Library/Refresh` requests only until Jellyfin returns the episodes, then
  confirm the show page stops showing **Importing** while the torrent seeds.
