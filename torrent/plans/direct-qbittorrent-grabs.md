# Direct qBittorrent grabs from selected release results

## Context

Selecting a release currently tells Sonarr/Radarr to re-search their indexers so
the arr can populate its in-memory release cache, then the arr grabs the matching
result. Sonarr's public release API has no single-indexer filter and can take over
100 seconds, which caused the recent timeout error. The user does not want a
second search: the exact torrent selected in churn must be the torrent that is
installed.

Decided architecture:

- Sonarr/Radarr provide metadata, indexer configuration, and release results.
- Prowlarr provides progressive per-indexer release search.
- qBittorrent receives the selected torrent directly and saves it into the
  Jellyfin media folders.
- Jellyfin and qBittorrent provide availability and download progress directly.
- Completed direct downloads are not imported or renamed by Sonarr/Radarr.

## Decisions

- Direct downloads work for every Prowlarr indexer, even when the indexer is not
  synced to Sonarr/Radarr.
- Movies and series use the existing Sonarr/Radarr folder path when available;
  fall back to `<Title (Year)>` for new titles.
- Single-season/episode downloads go to `Show folder/Season N`.
- Multi-season packs go to the show folder with qBittorrent `NoSubfolder`, so
  Jellyfin can group episodes by their `SxxExx` names.
- Movies save into the existing Radarr movie folder with `NoSubfolder`.
- Episode-picker releases also use the direct qBittorrent path.

## Current findings

- Prowlarr search results already include `downloadUrl` and sometimes
  `magnetUrl`. Prowlarr and qBittorrent share gluetun's network namespace, so
  qBittorrent can fetch Prowlarr's download URL.
- `server/backend/src/release-search.ts` currently drops `downloadUrl` and
  `magnetUrl` from `RawIndexerRelease` and snapshots.
- `server/backend/src/upstream/qbittorrent.ts` only supports listing and deleting
  torrents. It needs an add-torrent method.
- Show/movie grab routes currently resolve a Sonarr/Radarr release and POST to the
  arr. They never touch qBittorrent directly.
- Jellyfin libraries point at `/data/media/tv` and `/data/media/movies`.
  Real-time monitoring is enabled by the installer.
- Existing qBittorrent categories are `tv` and `movies`.
- `recoverCompletedShowDownloads` currently asks Sonarr to scan any completed
  untracked qBittorrent download. Direct downloads must be excluded because their
  files are already in the Jellyfin library.

## Approach

### 1. Keep the exact download source

- Extend `RawIndexerRelease` with optional `downloadUrl` and `magnetUrl`.
- Preserve both fields in `normalizeRelease` and persisted snapshots.
- Bump the release-snapshot version so old snapshots without download URLs are
  discarded and re-searched.
- Add a helper that chooses the first usable source:
  `magnetUrl` -> `downloadUrl` -> `guid` only when it is a magnet URL.
- Keep these URLs server-side; do not expose them in browser responses.

### 2. Add direct qBittorrent support

- Add `addTorrent` to `createQbittorrentClient`.
- POST to `/api/v2/torrents/add` as `application/x-www-form-urlencoded` with:
  - `urls`: selected magnet or Prowlarr/Sonarr download URL
  - `savepath`: resolved library folder
  - `category`: `tv` or `movies`
  - `tags`: `churn-direct`
  - `contentLayout`: `NoSubfolder`
  - `autoTMM`: `false`
- Add `tags` to `QbittorrentTorrent` so direct downloads can be identified.
- Handle both qBittorrent response formats: older `Ok.` text and qBittorrent
  5.2+ JSON (`success_count`, `pending_count`, `failure_count`) with HTTP 202
  for pending adds. Treat control errors as failures and use
  `upstreamResponseError` for non-2xx responses.
- Check for an existing torrent by info hash/title before adding to avoid duplicate
  clicks creating duplicate downloads.

### 3. Resolve the library save path

Create a small shared direct-grab module (for example
`server/backend/src/direct-grab.ts`) that:

- Resolves the target folder with Sonarr `getSeries` / Radarr `getMovie`.
- Reuses `path` when present.
- Falls back to `<Title (Year)>` under `/data/media/tv` or `/data/media/movies`.
- Adds `/Season N` for single-season and episode downloads.
- Uses the show folder without a season for multi-season packs.
- Sanitizes generated path segments.
- Passes the media kind, title, and save path back to the route.

### 4. Replace arr grabs in routes

- Rewrite `grabShowRelease` in `server/backend/src/routes/shows.ts`:
  - Prowlarr season results: use `findRelease`, then direct qBittorrent add.
  - Episode-picker results: use the Sonarr release's `downloadUrl`/`magnetUrl`
    and direct qBittorrent add.
  - Remove the arr release re-search, arr indexer sync check, monitoring, override
    handling, and arr grab POST.
- Rewrite `grabMovieRelease` in `server/backend/src/routes/movies.ts` similarly.
- Keep Sonarr/Radarr for episode lookup, metadata, and request creation.
- Return `{ status: "grabbed", title }` as before so the frontend contract stays
  stable.
- Remove `arrIndexerId` / `arrIndexersKnown` / `resolveArrIndexer` usage from the
  release search path. Results are grabbable when they have a download source.

### 5. Adjust qBittorrent completion handling

- Tag direct grabs `churn-direct`.
- Skip `recoverCompletedShowDownloads` for `churn-direct` torrents; their files
  are already in the Jellyfin library.
- Update the show-page qBittorrent overlay so a completed direct torrent says it
  is waiting for Jellyfin to index the files, not that Sonarr has not imported it.
- Keep the existing arr queue/recovery behavior for older arr-managed downloads.

### 6. Frontend removal of arr-sync language

- Remove "Indexer not in arr" / "Matched" badges from `ReleaseChooser`.
- Remove the "no arr" indexer badge.
- Change success toast to indicate the torrent was sent to qBittorrent.
- Keep `canGrab` based on whether a usable download URL exists.

## Files to modify

- `server/backend/src/release-search.ts`
- `server/backend/src/upstream/qbittorrent.ts`
- `server/backend/src/direct-grab.ts` (new)
- `server/backend/src/routes/shows.ts`
- `server/backend/src/routes/movies.ts`
- `server/backend/src/qbittorrent-show.ts`
- `server/backend/src/download-import.ts`
- `server/backend/src/types.ts` (only if response/progress fields change)
- `server/frontend/src/features/releases/ReleaseChooser.tsx`
- `server/frontend/src/features/show/ReleasePicker.tsx` (toast wording if needed)
- `server/frontend/src/api/types.ts` (only if response/progress fields change)
- Backend tests for release retention, qBittorrent add, direct grabs, and recovery
  skipping.
- README/docs sections describing arr grabs, indexer sync, and download flow.

## Reuse

- `createArrClient` in `server/backend/src/upstream/servarr.ts` for folder paths.
- Existing `findRelease` lookup in `server/backend/src/release-search.ts`.
- Existing qBittorrent auth/error handling in
  `server/backend/src/upstream/qbittorrent.ts`.
- Existing show progress mapping in `server/backend/src/qbittorrent-show.ts`.
- Existing Jellyfin real-time monitoring and library refresh support.

## Steps

- [x] Retain `downloadUrl` / `magnetUrl` in release results and snapshots; bump
      snapshot version and update snapshot validation.
- [x] Add qBittorrent `addTorrent` plus `tags` on torrent records; unit test the
      form payload and response handling.
- [x] Add shared save-path resolution and direct-grab helper.
- [x] Rewrite show season, episode, and movie grab routes to add to qBittorrent
      directly and never search/grab through Sonarr/Radarr.
- [x] Remove arr indexer-sync gating from release search responses and frontend
      badges.
- [x] Tag direct grabs and exclude them from Sonarr scan recovery.
- [x] Update completed-download status text for direct downloads.
- [x] Update route/release-search/qBittorrent tests and frontend types.
- [x] Update documentation to describe direct qBittorrent downloads and direct
      library folders.

## Verification

- Unit tests:
  - Prowlarr result keeps `downloadUrl`/`magnetUrl`; old snapshots are rejected.
  - qBittorrent add sends the exact URL, save path, category, tag, and
    `NoSubfolder`.
  - Show/movie grab routes do not call Sonarr/Radarr release search or grab.
  - Unsynced Prowlarr indexers remain grabbable.
  - Multi-season packs use the show root; single seasons use `Season N`.
  - Direct-tagged completed torrents do not trigger Sonarr scan recovery.
- `npm run typecheck`, `npm test`, and `npm run build` in `server/`.
- Manual end-to-end:
  - Select a season release and confirm qBittorrent contains exactly that
    torrent under the expected show/season path.
  - Select a movie release and confirm the exact torrent is added under the
    movie folder.
  - Confirm Jellyfin indexes the completed files without a Sonarr/Radarr import.
  - Confirm the show page shows qBittorrent progress and then Jellyfin
    availability.
