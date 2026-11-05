---
# churn-bhfb
title: Skip intros and credits using IntroDB segment data
status: in-progress
type: feature
priority: normal
tags:
    - playback
    - shows
created_at: 2026-11-05T18:26:10Z
updated_at: 2026-11-05T18:39:17Z
---

## Goal

Give the player a **Skip intro** (and later **Skip recap** / next-episode at the
credits) affordance without a Jellyfin plugin, using crowdsourced segment
timestamps from IntroDB.

## Data source: IntroDB

Public, read-only, no API key for reads (keys are only for submissions):

```
GET https://api.introdb.app/segments?imdb_id=tt0903747&season=1&episode=1
```

200 returns `{ imdb_id, media_type, is_movie, season, episode,
intro|recap|outro|post_credits: { start_ms, end_ms, start_sec, end_sec,
confidence, submission_count } | null, ... }`. 404 means "no data for this
episode". Reads are rate limited, so every request is cached.

`confidence` is IntroDB's own 0–1 score for how much its community submissions
agree. It is informational only: Churn stores the validated ranges and ignores
confidence and submission counts. There is no "hide weak data" rule — a range
either parses and is used, or it is dropped.

## Design: warm on grab, read at playback

The whole pipeline runs when a season or episode is requested for download, not
when the player opens:

1. `POST /api/library/shows/:source/:id/releases/grab` succeeds in
   `grabShowRelease` (`server/backend/src/routes/shows.ts`).
2. Fire-and-forget `introDb.warmFromGrab(seriesId, seasonNumber, episodeNumber?)`.
3. Resolve the series **IMDb id** from `mediaCache.getSeries(seriesId)`; if the
   show was added outside Churn, fall back to Sonarr `GET /api/v3/series/:id`
   and write the metadata back into the media cache.
4. Episode set:
   - episode grab → just that `(season, episode)`;
   - season grab → Sonarr `GET /api/v3/episode?seriesId=` filtered to that
     season, deduped and sorted.
5. For each episode, sequentially `GET /segments` and write the result to
   `server/cache/releases/introdb/<imdbId>.json` (or the writable fallback cache root). No concurrency limiter, no queue, no
   TTL sweep: it runs in the background while the torrent downloads.
6. `GET /api/playback/items/:itemId` resolves the series IMDb id from the
   Jellyfin series item (`ProviderIds.Imdb`, cached in-process for an hour) and
   reads the JSON. It never calls IntroDB.

Fail-open everywhere: no IMDb id, 404, timeout, 429 or malformed data means the
episode simply has no `segments`. A grab failure never depends on IntroDB, and
playback never waits on it.

### Cache format

One file per IMDb id, versioned, written atomically:

```json
{
  "version": 1,
  "imdbId": "tt0903747",
  "episodes": {
    "s1e2": {
      "fetchedAt": "2026-09-12T21:03:17.409Z",
      "segments": {
        "intro": { "startSec": 2.5, "endSec": 58 },
        "outro": { "startSec": 3300, "endSec": 3500 }
      }
    }
  }
}
```

Only `intro`, `recap`, `outro` and `postCredits` ranges that pass validation
(integer ms, `0 <= start < end`, under 24h) are stored. Re-grabbing a season
overwrites its entries with fresh IntroDB data.

### Playback API contract

`PlaybackItem` (backend `server/backend/src/playback.ts` and frontend
`server/frontend/src/api/types.ts`) gains:

```ts
segments?: {
  intro?: { startSec: number; endSec: number };
  recap?: { startSec: number; endSec: number };
  outro?: { startSec: number; endSec: number };
  postCredits?: { startSec: number; endSec: number };
};
```

The player consumes this in the next step: show **Skip intro** while inside the
intro range, and let `churn-daog` start its next-episode countdown at
`outro.startSec`.

## What is implemented

- `INTRODB_URL` / `INTRODB_TIMEOUT_MS` config and docs.
- `server/backend/src/introdb.ts` — client, URL building, validation and
  seconds mapping.
- `server/backend/src/introdb-cache.ts` — atomic per-series JSON cache.
- `server/backend/src/introdb-warm.ts` — IMDb resolution, season enumeration and
  sequential warm-up.
- Grab hook in `routes/shows.ts`, wiring in `server.ts`.
- `segments` attached to the playback metadata response (Jellyfin series IMDb
  lookup cached in-process).
- Backend tests: client/mapping, cache persistence/corruption, single-episode
  and season warm-up, playback route segments.
- `server/README.md` and `docs/src/web-ui.md`.

## Remaining

- Player UI: `Skip intro` / `Skip recap` overlay in `PlayPage`.
- Optional: warm a season when a show page opens for shows downloaded outside
  Churn (Sonarr-native downloads will otherwise have no cached segments).
- Feed `outro.startSec` into `churn-daog`'s countdown (tracked there).

## Todos

- [x] Add `INTRODB_*` config, timeouts and docs
- [x] Add the IntroDB client + persistent per-series cache
- [x] Resolve the series IMDb id from the media cache or Sonarr and cache it
- [x] Warm every episode of the grabbed season, or the single grabbed episode, in the background
- [x] Map segments into `PlaybackItem` (backend + frontend types)
- [x] Playback reads the cache only; never calls IntroDB
- [x] Backend tests for client, cache, warm-up and playback route
- [ ] Add the Skip intro / Skip recap overlay to `PlayPage`
- [ ] Expose `segments.outro.startSec` so `churn-daog` can trigger its countdown at the credits
