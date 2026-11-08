---
type: Runtime Workflow
title: Downloads, activity and library sync
description: How churn follows a download from Sonarr/Radarr or a direct qBittorrent grab through import, Jellyfin indexing and live activity reporting, including matching heuristics and retry timings.
tags: [downloads, qbittorrent, sonarr, radarr, jellyfin, library-scan, activity]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-b07d899573000c707b0ebf4a
    resource: repo://server/backend/src/activity-feed.ts
  - id: openwiki-source-31be5041183818beba0b0b39
    resource: repo://server/backend/src/download-import.ts
  - id: openwiki-source-63733c50861157c73e2265e1
    resource: repo://server/backend/src/library-scan.ts
  - id: openwiki-source-d048b4dc7fb0d80d6423f44a
    resource: repo://server/backend/src/live-downloads.ts
  - id: openwiki-source-7c34d1a911880859e6d3a7a2
    resource: repo://server/backend/src/metadata-wait.ts
  - id: openwiki-source-ec09746128bcc93707be54cd
    resource: repo://server/backend/src/qbittorrent-activity.ts
  - id: openwiki-source-bc983efd132559d1c8fb2f47
    resource: repo://server/backend/src/qbittorrent-show.ts
  - id: openwiki-source-3018ffeb0e60c3a87b15fc65
    resource: repo://server/backend/src/torrent-progress.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Downloads, activity and library sync

The dashboard separates three questions that look similar:

- **Is the download progressing?** Answered only by qBittorrent.
- **Has the arr imported it into the media folders?** Answered by Sonarr/Radarr history and queue data.
- **Is it playable in Jellyfin?** Answered by Jellyfin items and episodes.

Most of the complexity comes from keeping those three views consistent when downloads are direct (qBittorrent only), when arr queue rows disappear, or when Jellyfin has not scanned yet.

## The library-scan watcher

`createLibraryScanWatcher(config)` in `server/backend/src/library-scan.ts` starts with the backend (`buildServer`) and polls every 5 seconds. It is enabled only when Jellyfin has an API key and at least one of Sonarr, Radarr or qBittorrent is configured. Concurrency is guarded by a `polling` flag.

Each `pollOnce()`:

1. Processes completed direct downloads (below).
2. Fetches arr import history rows since a cursor.
3. Advances the cursor and deduplicates by history id.
4. Refreshes Jellyfin and waits for the imported item to become visible.

### Why the import event, not 100%

A finished torrent is not the same as an imported one: Sonarr/Radarr still has to move or hardlink the files into `/data/media`. A Jellyfin scan started too early indexes nothing. The watcher therefore keys on the arr's `downloadFolderImported` history event, emitted after the move.

`since` initially points 10 minutes into the past (`DEFAULT_RECENT_IMPORT_MS`), so a restart does not re-process the whole history. History queries overlap by 60 seconds (`SINCE_OVERLAP_MS`) because multiple rows can share the newest second; duplicates are removed by history id, and seen ids expire after an hour.

After a refresh the watcher polls Jellyfin for up to 90 seconds (`DEFAULT_RESOLVE_TIMEOUT_MS`, every 5 seconds) to check that the imported title actually appeared. If it did not, it refreshes once more and waits again, then gives up. A resolve error does not trigger a blind rescan.

### Direct downloads

Direct grabs are tagged `churn-direct` and never appear in arr history. For those, qBittorrent completion is the correct signal because the files were written straight into the library path. The watcher:

- considers only completed `churn-direct` torrents completed within the recent window,
- keys them by hash and completion time,
- asks Jellyfin to refresh every 15 seconds (`DEFAULT_DIRECT_REFRESH_MS`),
- stops after Jellyfin exposes the item or after the 10-minute retry window (`DEFAULT_DIRECT_RETRY_WINDOW_MS`),
- uses Jellyfin series/episode or movie data to prove visibility, with season information derived from the release name or content path.

## Recovering untracked completed downloads

`recoverCompletedShowDownloads` in `download-import.ts` handles a different failure: Sonarr loses the queue record while the torrent is still in qBittorrent (series deleted and re-added, Sonarr restarted, or a rejected duplicate add). The files exist but Sonarr never imports them.

The recovery path:

1. Selects episodes that are `missing` and either have no download or an `untracked` one.
2. Matches completed, non-direct torrents to those episodes by show title and season/episode markers.
3. Calls Sonarr's `DownloadedEpisodesScan` command for the torrent's `content_path`, at most once per minute per series/path.
4. Marks the fallback download rows as `importing` so the UI does not keep prompting.

Sonarr still performs its own file-to-episode matching, so an incorrect path is a no-op rather than a blind import.

## Live download status

`live-downloads.ts` keeps the 500 ms poll cheap. The full movie/show detail route remembers the title identity it just loaded (title, year, Radarr id, episode keys) in a `LiveDownloadStore` with a 5-minute TTL. The fast `/download` endpoints then only read qBittorrent and re-use that identity.

- `loadQbittorrentTorrents` uses a 2-second timeout and returns `[]` when no qBittorrent key is configured.
- `movieLiveDownload` delegates to `movieTorrentActivity`, which matches torrents by tag (`churn-movie-<radarrId>`), title + year, or the save-path folder when the torrent name is just a hash.
- `showLiveDownloads` maps torrents to episode keys with `mapShowTorrentDownloads` and suppresses an `importing` row once Jellyfin already has that episode.

## Torrent-to-title matching

Matching is intentionally tolerant but guarded against prefix collisions.

**Shows** (`qbittorrent-show.ts`):

- Tokenize the name and require the show title tokens to match exactly at the start.
- Require an `S01`/`S01E02` marker after the title.
- Permit only a year or a country qualifier (`US`, `UK`, `AU`, `CA`) between title and season marker.
- Derive seasons with `queueRecordSeasons`, including multi-season ranges such as `S01-S03`.

**Movies** (`qbittorrent-activity.ts`):

- The full movie title must match from the start, followed by either the movie's year or a known release marker (`1080p`, `bluray`, `web-dl`, `x265`, `proper`, ...).
- Otherwise fall back to the save-path folder for hash-named torrents.

**Explicit tag:** a `churn-movie-<id>` or `churn-series-<id>` tag links a torrent to an arr id even when the name is unhelpful.

## Activity aggregation

`GET /api/activity` uses `createActivityFeed`:

- A 400 ms snapshot TTL coalesces every open tab into one qBittorrent refresh.
- The Sonarr/Radarr catalog used for titles is cached for 5 minutes.
- `buildQbittorrentActivity` groups *active* torrents by catalog match and builds one `ActivityItem` per movie/series bucket.

Status precedence is `warning` > `downloading` > `queued`. Warnings come from qBittorrent states `error`/`missingfiles`, a stalled download, or a magnet that has not received metadata after 5 seconds. Aggregate progress is byte-weighted when sizes are known, speeds/seeders/size-left are summed, and ETA uses the minimum finite non-infinite eta.

`torrent-progress.ts` overlays qBittorrent's live size, progress, ETA and speed onto Sonarr/Radarr queue records when detail routes use arr queues, preserving the arr's import/warning state. Download ids are indexed by every hash variant (`hash`, `infohash_v1`, `infohash_v2`).

## Metadata waits

qBittorrent reports `metaDL` (and `has_metadata: false`) until a peer supplies the info dictionary. `metadata-wait.ts` defines the 5-second warning threshold and the user-facing message. This is what turns a dead magnet into a "cancel and pick another release" warning instead of an indefinitely queued download.

## What persists

Only the release caches, media metadata caches and auth state are written to disk. Download identities, seen history ids and activity snapshots are in-memory and disappear on restart; the watcher reconstructs its position from the recent-import window.

## Relevant tests

- `server/backend/test/library-scan.test.ts` — repeated history rows, season-pack coalescing, resolve retries, direct-download windows, `stop()`.
- `server/backend/test/activity.test.ts` — arr queue aggregation semantics.
- `server/backend/test/qbittorrent-activity.test.ts` — grouping, title matching, warning states, metadata warnings.
- `server/backend/test/qbittorrent-show.test.ts` — episode mapping and season extraction.
- `server/backend/test/download-import.test.ts` — untracked completed download recovery.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/release-discovery.md] link "/openwiki/dashboard/release-discovery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Release discovery and ranking](/openwiki/dashboard/release-discovery.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/library-and-requests.md] link "/openwiki/dashboard/library-and-requests.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Library browsing, search and requests](/openwiki/dashboard/library-and-requests.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/playback.md] link "/openwiki/dashboard/playback.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Playback and streaming](/openwiki/dashboard/playback.md)
