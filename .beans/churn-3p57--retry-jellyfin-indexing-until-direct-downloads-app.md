---
# churn-3p57
title: Retry Jellyfin indexing until direct downloads appear
status: completed
type: bug
priority: normal
created_at: 2026-11-05T00:41:13Z
updated_at: 2026-11-05T00:43:51Z
---

churn-direct downloads only trigger one Jellyfin refresh; if Jellyfin misses the new files it never retries. Also finished direct downloads still show an Importing overlay in the live show-download endpoint after Jellyfin indexes them.

## Tasks
- [x] Replace one-shot direct refresh with a 10-minute retry loop
- [x] Verify visibility from Jellyfin Series/Episode and Movie data
- [x] Filter stale importing rows from the live show-download endpoint
- [x] Update tests and docs

## Summary of Changes

- Finished `churn-direct` downloads are now tracked for up to 10 minutes and request a Jellyfin library refresh every 15 seconds until Jellyfin exposes the matching series episodes or movie.
- Jellyfin visibility uses the same Series/Episode and Movie data as the detail routes; the item path is only used to locate the download in the library.
- The live show-download endpoint now suppresses finished `importing` rows once the cached episode is available in Jellyfin or imported by Sonarr, matching the full detail route.
- Added library-scan retry/visibility tests, a live-download route regression test, and updated web UI docs.
- Verified with backend tests (297 passing), backend typecheck/build, and frontend typecheck.
