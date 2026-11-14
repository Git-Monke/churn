---
# churn-6ito
title: Backfill IntroDB segments on demand and make the release cache writable
status: completed
type: bug
priority: normal
created_at: 2026-11-13T23:20:23Z
updated_at: 2026-11-13T23:26:53Z
---

Two defects found on the local Docker stack while S4 of Parks and Recreation had no intro/outro markers.

## What was wrong

1. Warm-up only fired from a churn grab (`server/backend/src/routes/shows.ts:401`). A season imported before v0.2.6, or any cache lost on restart, never got segments: IntroDB had data, churn never asked.
2. `resolveReleaseCacheDir` silently fell back to `/tmp`. With `PUID=0` the dashboard runs as `0:0` while `/app/.churn-cache` and `/app/state` ship as `1000:1000`, and `cap_drop: [ALL]` removes DAC_OVERRIDE, so the volumes were unwritable: the cache landed in tmpfs and `auth-state.json`/`media-attribution.json` writes failed with EACCES.

## Changes

- `server/backend/src/introdb-warm.ts`: `warmFromGrab` is now `warm` (grab trigger), and `segmentsFor` backfills a cold cache on demand — it waits at most `onDemandWaitMs` (2 s) for one episode, then returns undefined while the fetch finishes in the background. One warm per episode/season at a time (`inFlight`), so playback retries and the grab warm cannot double-fetch a rate-limited API.
- `server/backend/src/routes/playback.ts`, `server/backend/src/routes/shows.ts`: call sites follow the renamed/reshaped service.
- `server/backend/src/server.ts`: `resolveReleaseCacheDir(serverDir, warn)` logs a warning naming both persistent candidates and the tmpdir fallback, instead of degrading silently.
- `server/docker-compose.yml`: new one-shot `cache-init` service chowns `churn-cache`/`churn-state` to `PUID:PGID`; the dashboard waits for `service_completed_successfully`.
- Docs: `docs/src/web-ui.md`, `docs/src/server.md`, `server/README.md`, `README.md`.

## Verification

- `server/backend`: `npx tsc -p tsconfig.json --noEmit` clean; `npx vitest run` 407 passed, including new "backfills a cold cache while playback waits" and "stops waiting for a slow backfill instead of stalling playback" in `server/backend/test/introdb.test.ts`.
- Live: `segmentsFor("tt1266020", 4, 1)` against the real IntroDB returned `intro 93–113 s, recap 0–28 s, outro 1281–1287 s` in 532 ms and wrote the cache file — the exact S4 scenario that had no data.
- Live stack: after chowning `server_churn-cache`/`server_churn-state` and restarting, `/app/.churn-cache/releases` is created and `/app/state/auth-state.json` persists; no EACCES across a second restart.
- `cargo test --offline`: all pass. `docker compose config` validates the new service.
