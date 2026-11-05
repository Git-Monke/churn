---
# churn-c6qj
title: Metadata-less magnets show as permanently queued hashes
status: completed
type: bug
priority: normal
created_at: 2026-11-05T03:21:03Z
updated_at: 2026-11-05T04:00:28Z
---

A grabbed magnet can stay in qBittorrent metaDL forever when no peer has the metadata. Churn then:
- shows the torrent hash as the posterless card with no title/title link
- shows "Queued" forever with no warning or timeout
- cannot match it to the movie, so the movie page offers release options again

Repro: grab Deep.Impact.1998.720p.BluRay.800MB.x264-GalaxyRG (TPB, 1 reported seeder, 0 actual) via Prowlarr magnetUrl. qBittorrent stays metaDL with 0 seeds and `has_metadata=false` (hash 0c844bcadda6d636501067091afb86d85c969bde).

## Plan
See `plans/magnet-metadata-linking.md`.

- [x] Tag direct grabs with `churn-movie-<radarrId>` / `churn-series-<sonarrId>`, and backfill tags when qBittorrent already has the torrent
- [x] Resolve tagged torrents to catalog metadata in activity and movie download endpoints
- [x] Match/cancel hash-named movie torrents by media tag and save-path fallback
- [x] Warn after 5s when `metaDL` still has no metadata
- [x] Add backend tests and frontend warning message
- [x] Run tests, typecheck, build

## Summary of Changes
- Added media tags (`churn-movie-<id>`, `churn-series-<id>`) to direct grabs and a qBittorrent `addTags` client call to backfill existing torrents on duplicate grabs.
- Activity matching now prefers the media tag, then catalog title matching, then a movie `save_path` fallback for hash-named untagged magnets.
- Movie download/cancel paths accept `radarrId` and follow the media tag, so a metadata-less magnet is visible and cancellable from the movie page.
- Added shared `metadata-wait.ts`: `metaDL`/`has_metadata=false` for 5s becomes `warning` with a "no peer is sharing it" message; earlier waits show "Waiting for qBittorrent to fetch torrent metadata."
- Show downloads use the same metadata warning logic.
- Library cards now render warning status messages.
- Tests added/updated for tags, backfill, save-path fallback, 5-second warning, movie fast download/cancel, and show warning.
- Verified: backend 324 tests pass, backend/frontend typecheck, frontend and backend builds.
