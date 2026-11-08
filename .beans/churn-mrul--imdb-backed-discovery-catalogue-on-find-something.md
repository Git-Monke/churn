---
# churn-mrul
title: IMDb-backed discovery catalogue on Find something new
status: todo
type: feature
priority: normal
tags:
    - discovery
    - search
    - frontend
    - backend
    - dataset
created_at: 2026-11-07T06:44:28Z
updated_at: 2026-11-07T06:50:59Z
---

## Goal

A "Use IMDb data" toggle on **Find something new** (`#/search`) that swaps the
live Sonarr/Radarr lookup for a local, offline IMDb-derived catalogue of
well-rated movies and shows. Purpose: browsing when you don't know what you
want — filter by category/type/year/rating, then request a title through the
existing pipeline.

## Data source

IMDb non-commercial bulk datasets (`https://datasets.imdbws.com/`, daily gz TSV,
personal/non-commercial licence). Only two files are needed:

- `title.basics` (219 MB gz / 1.07 GB raw, 12.9 M titles) — tconst, titleType,
  primaryTitle, startYear, runtimeMinutes, genres (max 3), isAdult
- `title.ratings` (8 MB gz / 28 MB raw, 1.7 M titles) — averageRating (already
  IMDb's weighted average), numVotes

### Measured scope (today's snapshot)

Scope = `movie|tvMovie|tvSeries|tvMiniSeries|tvShort` ∩ `numVotes >= 100`:

| | rows |
|---|---|
| movie | 147,994 |
| tvSeries | 35,391 |
| tvMovie | 16,304 |
| tvMiniSeries | 8,419 |
| tvShort | 509 |
| **total** | **208,617** |

~18.8 MB raw TSV, roughly 3–4 MB gzipped. At `numVotes >= 1000`: 65,879 rows.
For comparison, all movies with any rating = 351,372.

No plot, poster, keyword, cast, or episode data in these datasets.

## Confirmed decisions

- **minVotes = 100, build-time constant.** Non-user-facing: a `const MIN_VOTES:
  u32 = 100` in the ingest code, not a query param, not a filter chip. Changing
  it means rebuilding the artefact.
- **Artefact is generated at download/setup time**, by the `churn` installer
  when the user sets up churn. Not committed to the repo, not baked into the
  dashboard image, never fetched at request time.
- **Artefact location: `${DATA_DIR}/catalog/`**, so `churn migrate` relocates it
  with the rest of the data for free and `churn uninstall` keeps it (DATA_DIR is
  never deleted).
- **Artwork (option 1): Servarr lookup per visible card.** The IMDb datasets have
  no images at all (verified: no image column in any of the 7 files, and TMDB's
  free daily ID export carries only `adult/id/original_title/popularity/video` —
  no `poster_path`, no `imdb_id`). So a discovery card resolves its `tconst`
  through `Radarr /api/v3/movie/lookup?term=imdb:tt…` /
  `Sonarr /api/v3/series/lookup?term=imdb:tt…` and reuses `mediaCoverUrl()` +
  the existing `/api/search/images/:service` proxy. `image.tmdb.org` is already
  in `ARTWORK_HOSTS`, so this needs no new credential, no new proxy, and no new
  allowlist entry.
  - Lazy-hydrate only rendered cards (~20/page), cached like `media-cache.ts`.
    **Never bulk-prefetch**: ~209k posters is ~209k TMDB requests and several GB.
  - Cards must render with no poster (some catalogue entries have no artwork).
  - TMDB direct (`/find/{tconst}?external_source=imdb_id`) is the later upgrade
    if we want overview/backdrop/keywords; it also unlocks `with_keywords` for
    real "theme" filters, which the IMDb datasets cannot support.

## Plan

- [ ] Ingest step in the Rust installer (`churn setup`): download `title.basics`
      + `title.ratings`, stream-filter to scope + `MIN_VOTES`, write one compact
      artefact to `${DATA_DIR}/catalog/`. Reuse the existing progress/`LiveLog`
      UI conventions; tolerate the download failing (setup continues, the toggle
      just reports "catalogue not built").
- [ ] Artefact format: compact NDJSON/JSON loaded once into backend memory on
      first `/api/discover` (~209k rows ≈ 25 MB raw; in-process filtering is
      sub-millisecond). Avoid SQLite: the image is `node:22-bookworm-slim` with
      no native deps, and `node:sqlite` still needs `--experimental-sqlite`
      there. Only introduce SQLite if the artefact outgrows memory.
- [ ] Catalogue mount: the dashboard service is `read_only: true` and does not
      currently mount DATA_DIR, so add `- "${DATA_DIR}/catalog:/app/catalog:ro"`
      plus a new `CHURN_CATALOG_DIR` env var, in `server/docker-compose.yml`,
      which `src/assets.rs` rewrites on every install/rerun.
- [ ] `churn update`: keep an existing artefact, rebuild it only when missing
      (defer any staleness/refresh policy to a follow-up).
- [ ] Backend `GET /api/discover` — params: `q`, `types`, `genres`,
      `yearMin/yearMax`, `minRating`, `sort` (rating / votes / year), page
      pagination; returns the same card shape the search page already renders.
      `minVotes` is not a parameter.
- [ ] Genre list in the discover response metadata (the distinct genre set from
      the artefact), rather than a separate endpoint.
- [ ] Poster hydration: batch `imdb:` lookups for the visible page only, through
      the existing proxied image path; missing artwork falls back to a
      placeholder card.
- [ ] Frontend: "Use IMDb data" toggle on Find something new; off (default)
      keeps today's Sonarr/Radarr-as-you-type search, on switches to
      `/api/discover` with filter chips for type + genre, year range, min rating.
- [ ] Request path for a local result: resolve `tconst` → `imdb:tt…` in
      Radarr/Sonarr lookup, then reuse the existing request flow unchanged.
- [ ] Mark titles already in library or already requested (reuse the existing
      Requested/Library check).
- [ ] Empty state + "no results for these filters" guidance; keep the toggle
      state in `localStorage`.
- [ ] Unit tests for the filter/paging query + the ingest constant; typecheck,
      tests, build.

## Still open

- **Scope**: include `tvMovie` and `tvShort`, or restrict to `movie` +
  `tvSeries` + `tvMiniSeries`? (tvShort is only 509 rows at ≥100 votes, so it is
  close to free either way.)
- **Refresh policy** for the artefact after setup day.

## Risks / notes

- IMDb IDs don't map to Sonarr/Radarr's native IDs (TVDB/TMDB), so every request
  and every poster depends on the `imdb:` lookup-prefix path being reliable in
  both apps.
- One Arr lookup per visible card means the discover grid needs both Arr services
  up to look right; text-only cards must degrade gracefully when one is down.
- The bulk datasets are a subset: they cannot back a keyword/"theme" filter.
- Ratings-only membership means a well-known title that nobody has rated is
  absent by definition.
