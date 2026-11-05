# Link grabbed magnets to media + warn when metadata never arrives

Bean: `churn-c6qj`

## Problem

A release grabbed from Prowlarr as a magnet can stay in qBittorrent `metaDL`
forever when no peer has the torrent metadata. While it does, qBittorrent
reports:

- `name` = the infohash
- `has_metadata = false`
- `state = metaDL`
- `seeds = 0`

Churn currently:

1. maps `metaDL` to the `queued` activity status, so the UI says "Queued"
   indefinitely;
2. shows the infohash as the activity title with no poster and no media link;
3. cannot title-match the torrent to the movie/show, so the media page falls
   back to the release chooser as if nothing was grabbed;
4. cannot cancel it from the media page, because cancel also matches by title.

Deep Impact on `100.90.93.111` is the repro: hash
`0c844bcadda6d636501067091afb86d85c969bde`, `churn-direct`, 0 seeds, 3 peers all
at 0%.

## Approach

### 1. Durable media link via qBittorrent tags

qBittorrent tags are stored with the torrent, survive Churn restarts, and are
already read by the activity feed. Use them as the explicit link:

- `churn-movie-<radarrId>` for movie grabs
- `churn-series-<sonarrId>` for series grabs

Implementation:

- In `direct-grab.ts`:
  - add `mediaDownloadTag(kind, arrId)` and `parseMediaDownloadTag(tags)`.
  - `DirectGrabTarget` already has `kind` and `arrId`; apply the media tag
    alongside `churn-direct` whenever Churn adds a torrent.
  - when `findExistingTorrent()` finds a duplicate already in qBittorrent,
    backfill the media tag so retries link existing/direct grabs too.
- Add `addTags(hashes, tags)` to `upstream/qbittorrent.ts`
  (`POST /api/v2/torrents/addTags`).
- Tags are internal Churn identifiers; no title text goes into them.

Series gets an activity-level link from the tag. Per-episode mapping for shows
stays on the existing title/season matching path; linking hash-named episode
torrents to an exact episode is out of scope for this bug.

### 2. Resolve tagged torrents in activity and movie pages

Activity (`qbittorrent-activity.ts`):

- Change matching order in `buildQbittorrentActivity`:
  1. explicit media tag -> look up the catalog entry by kind + arr id;
  2. existing name/category match;
  3. save-path fallback for hash-named movie torrents (below);
  4. generic torrent item.
- A tagged torrent gets the catalog title, TMDB/TVDB ids, poster, movie/series
  id, and the normal `movie:<tmdb>` / `series:<tvdb>` key, even while its name
  is an infohash.
- If the tagged arr id is gone, still bucket it as
  `movie:radarr:<id>` / `series:sonarr:<id>` and use the media tag for cancel.

Movie detail:

- Extend `MovieDownloadIdentity` with `radarrId?`.
- `rememberMovie()` stores `detail.radarrId` when known.
- `movieLiveDownload()` matches active torrents by `churn-movie-<id>` OR the
  existing title/year match. A hash-named magnet therefore appears on the movie
  page as a waiting download instead of re-offering releases.
- `loadMovieDownload()` passes `movie.id` through.

Cancel:

- `cancelMovieDownload()` / `cancelMovieTorrents()` accept `radarrId` and include
  torrents carrying `churn-movie-<id>`.
- This makes "Cancel download" work for a hash-named `metaDL` torrent, so the
  user can remove the dead release and pick another one.

Save-path fallback (covers untagged arr-managed magnets too):

- When a torrent name looks like a 40-character hex infohash, try the last
  segment of `save_path` as a movie title for catalog matching.
  Example: `/data/media/movies/Deep Impact (1998)` -> `Deep Impact (1998)`.
- Only used as a fallback; explicit media tags win.

### 3. Warning state after 5 seconds without metadata

Do not add a new status. Use the existing `warning` status so every current badge
and dialog already says "Needs attention".

- Add `has_metadata?: boolean` to `QbittorrentTorrent`.
- Add a shared helper (e.g. in `qbittorrent-activity.ts`):
  - `isAwaitingMetadata(torrent)` = `state === "metadl"` or
    `has_metadata === false`.
  - `metadataWaitExpired(torrent, now)` = awaiting metadata and
    `now - added_on * 1000 >= 5_000`.
- `METADATA_WARNING_AFTER_MS = 5_000`.
- Activity status:
  - before 5s: `queued` with "Waiting for qBittorrent to fetch torrent
    metadata";
  - after 5s: `warning` with "qBittorrent has not received torrent metadata
    after 5 seconds. No peer is sharing it; cancel this download and pick
    another release."
- Apply the same rule in `qbittorrent-show.ts` for show downloads.
- Thread `now` through `buildQbittorrentActivity` / `mapShowTorrentDownloads`
  options so tests are deterministic.
- `added_on` is used as the start time; qBittorrent always supplies it. If it is
  missing, do not warn (avoid false positives).

### 4. Frontend

- `LibraryGrid` now shows `activity.statusMessages` under the progress bar, at
  least for `warning`, so the library card explains why it is stuck. Movie and
  show pages already render `statusMessages`.
- No new status/label components are needed; `warning` already renders
  "Needs attention" / destructive styling.

## Files expected to change

- `server/backend/src/direct-grab.ts`
- `server/backend/src/upstream/qbittorrent.ts`
- `server/backend/src/qbittorrent-activity.ts`
- `server/backend/src/qbittorrent-show.ts`
- `server/backend/src/live-downloads.ts`
- `server/backend/src/routes/movies.ts`
- `server/frontend/src/features/library/LibraryGrid.tsx`
- Tests:
  - `server/backend/test/qbittorrent-activity.test.ts`
  - `server/backend/test/qbittorrent.test.ts`
  - `server/backend/test/qbittorrent-show.test.ts`
  - `server/backend/test/direct-grab` coverage if present
  - `server/backend/test/routes.test.ts` for movie download + cancel via tag

## Tests

1. Tagged `metaDL` magnet with hash name:
   - activity item uses the catalog movie title/poster/key;
   - after 5s status is `warning` with the no-metadata message;
   - before 5s it is not `warning`.
2. `movieLiveDownload` finds a hash-named torrent via `churn-movie-<id>`.
3. `cancelMovieTorrents` removes a hash-named torrent via
   `churn-movie-<id>`.
4. Existing duplicate grab backfills the media tag (`addTags`).
5. Save-path fallback matches an untagged hash-named movie torrent.
6. Existing title/category matching tests keep passing.

## Verification

```bash
cd server
npm test -w backend
npm run typecheck
npm run build
```

Manual check on the server after deploy:

1. Re-grab Deep Impact (or any release) and confirm the torrent carries
   `churn-direct` + `churn-movie-3`.
2. Point-grab a dead magnet and confirm:
   - the library card shows Deep Impact with a poster;
   - after ~5s it flips to "Needs attention" with the no-peer message;
   - the movie page shows the waiting download and a working Cancel button.

## Immediate remediation (not part of the code change)

The existing `0c844…` torrent is dead and untagged. After approval, remove it
from qBittorrent and grab a seeded release (YTS 1080p, ~100 seeds) so Deep Impact
is actually downloaded.
