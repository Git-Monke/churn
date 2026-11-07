---
# churn-6d4k
title: Report watch progress every second and right after a scrub
status: completed
type: task
priority: normal
tags:
    - playback
    - frontend
created_at: 2026-11-07T02:37:31Z
updated_at: 2026-11-07T02:44:41Z
---

The player only tells Jellyfin where it is every 10s, on pause, and on stop, so a killed tab loses up to 10s of position and a seek is only persisted on the next tick.

## Todos
- [x] Drop REPORT_INTERVAL_MS to 1s
- [x] Skip periodic reports when the playhead has not moved or the previous report is still in flight (no queue build-up)
- [x] Report an immediate progress update ~500ms after a seek settles
- [x] Clear the pending seek timer on item change/unmount/pagehide
- [x] Typecheck and frontend tests pass

## Summary of Changes

- `REPORT_INTERVAL_MS` 10s → 1s in `server/frontend/src/pages/PlayPage.tsx`.
- Periodic ticks are skipped when the playhead has not moved since the last report or when a previous report is still in flight, so a slow Churn → Jellyfin round trip cannot queue up stale progress.
- `seeked` now schedules a single report 500ms later (debounced), so a scrub is persisted once the user stops dragging instead of on the next tick. Periodic ticks are suppressed while a scrub is in progress so intermediate scrub positions are never sent.
- New `currentTicks()` helper reads the live media clock, so seek, `pagehide`, and unmount stops report the position the user actually chose rather than the last `timeupdate` sample.
- Pending seek timers are cleared on item change, `pagehide`, and unmount; the stop report supersedes them.
- All reporting stays fire-and-forget (`void … .catch()`), so nothing awaits the network on the playback path.
- Verified: `npm run typecheck`, `npm run build`, `npx vitest run` (48 tests) in `server/frontend`.

## Benchmark: cost of one progress report

Measured against the live local Jellyfin (8096) with the service API key, on the admin/service user's copy of one item, position restored to its original value afterwards (verified: `PlaybackPositionTicks: 0`, `Played: false`, no `LastPlayedDate`).

| Path | mean | p50 | p95 | max |
|---|---|---|---|---|
| Jellyfin user-data write (`POST /Users/:u/Items/:i/UserData`) | 3.30 ms | 3.32 ms | 4.74 ms | 5.18 ms |
| Same write, 4 concurrent clients | 18.04 ms | 2.74 ms | 155.42 ms | 304.86 ms |
| Jellyfin item read (same item) | 7.26 ms | 7.10 ms | 8.30 ms | 8.34 ms |
| Churn Fastify hop (rejected request, no Jellyfin call) | 1.26 ms | 0.68 ms | 1.34 ms | — |
| `POST /Sessions/Playing/Progress` with API key | 0.44 ms | 0.41 ms | 0.64 ms | 0.69 ms |

Caveats and findings:

- With an API key, `Sessions/Playing{,\/Progress,\/Stopped}` returns 204 but writes nothing — Jellyfin only persists playback position for a real user session token. So the 0.44 ms row is the handler no-op, not the real path; the write cost above is the `UserDataManager.SaveUserData` work both paths end in. Exact session-path cost needs a logged-in user token.
- A full report therefore costs roughly 3–5 ms upstream plus one local Fastify hop. At 1/s that is ~3600 reports/hour and ~0.4% of one core per actively playing client, and nothing when paused.
- The 4-way concurrency result matters more than the mean: Jellyfin serialises user-data writes, so simultaneous progress reports from several TVs can stack to 150–300 ms. The in-flight guard added in this bean is what keeps Churn from queueing more of them; a slow write drops a tick instead of piling up.
- Watch item per-second writes cause one SQLite user-data write plus an item-updated event per second per stream; plugins that listen to playback-progress events (webhooks, playback reporting) will see 10x the events.
