---
# churn-d40y
title: Remove TorrentDownload from default Prowlarr indexers
status: completed
type: task
priority: normal
created_at: 2026-11-05T04:00:22Z
updated_at: 2026-11-05T04:00:28Z
---

TorrentDownload reports inflated seeder counts (e.g. 100+ seeders when the torrent has none), causing dead magnets to be grabbed. Remove `torrentdownload` from the default `PROWLARR_INDEXERS` lists while keeping it available as an opt-in override.

## Todo
- [x] Update torrent/docker-compose.yml default
- [x] Update prowlarr-init.sh default and comments
- [x] Update README and docs/src/torrent.md
- [x] Verify no stale default lists remain

## Summary of Changes
- Removed `torrentdownload` from the default `PROWLARR_INDEXERS` value in `torrent/docker-compose.yml` and `torrent/scripts/prowlarr-init.sh`.
- Updated the prowlarr-init header comment, README default list, README example, and `docs/src/torrent.md`.
- Kept the `torrentdownload` key in `prowlarr-init.sh` so users can still opt in via `PROWLARR_INDEXERS=...,torrentdownload`.
- Verified the shell script with `sh -n`.
- Existing installs keep TorrentDownload enabled until it is disabled/removed in Prowlarr or the indexer list is overridden; init does not delete previously enabled indexers.
