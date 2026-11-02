# Import-triggered Jellyfin scans with a resolution check

## Context

The first scan trigger used qBittorrent's `completion_on`: 1-second poll, one
Jellyfin refresh per completed torrent (`plans/library-scanning.md`). That fires
**before** Sonarr/Radarr has moved the files into the library, which for a
season pack takes minutes. The scan then finds an empty or half-written folder,
indexes nothing, and — because the trigger is one-shot — never runs again.

Observed on a Parks and Recreation season pack: the refresh ran at 11:45:28
while Sonarr was still hardlinking episodes (last one written 11:45), so the
show only appeared after a manual scan. That manual scan then left a second
problem: Jellyfin had created the season against the series' pre-identification
key, so the series had no child seasons/episodes afterwards.

## Decisions

- Trigger on the arr, not the download client: poll
  `GET /api/v3/history/since?date=<cursor>&eventType=downloadFolderImported`
  every 5 seconds on Sonarr and Radarr. That event is written after the import.
- Cursor semantics: `history/since` is exclusive, so each poll re-reads from 60
  seconds before the newest row and dedupes by history row id.
- At startup the cursor starts 10 minutes back, so a backend restart does not
  lose a recent import.
- One refresh per poll, however many episodes imported.
- After the refresh, verify the item is visible in Jellyfin:
  - series must resolve by TVDB id and have at least one season **and** one
    episode (a series row without children is the half-indexed state above);
  - movie must resolve by TMDB id and have a `Path`.
- If it is not visible within 90 seconds (polled every 5 seconds), refresh once
  more and give up. Real-time monitoring is the safety net after that.
- A failed lookup is not treated as "missing": only a successful lookup that
  comes back empty counts.
- Non-Jellyfin failures stay best-effort and silent, as before.

## Installer

`Jellyfin::ensure_libraries` also enables `EnableRealtimeMonitor` on the Movies
and Shows libraries, so Jellyfin watches the media folders itself. The update
round-trips the whole `LibraryOptions` object, because
`POST /Library/VirtualFolders/LibraryOptions` replaces it.
