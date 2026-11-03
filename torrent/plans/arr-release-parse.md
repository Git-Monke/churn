# Use Sonarr/Radarr `/api/v3/parse` for release-name parsing

## Context

The progressive Prowlarr release search currently normalizes and filters every
indexer result with a custom parser in
`server/backend/src/release-name.ts`. That duplicates release-name logic that
Sonarr and Radarr already provide through:

```http
GET /api/v3/parse?title=<release-title>
X-Api-Key: ...
```

Both local instances expose it and return authoritative data:

- Sonarr `parsedEpisodeInfo`: series title/year, quality, season number,
  episode numbers, `fullSeason`, `isMultiSeason`, `releaseType`.
- Radarr `parsedMovieInfo`: `movieTitles`, `movieTitle`/`primaryMovieTitle`,
  year, quality.

Replace the custom parser with an arr-backed parser. Keep only:

1. A small in-memory cache so repeated release titles do not re-hit the arr.
2. Multi-season range expansion, because Sonarr reports only the first season
   for a pack such as `S01-07` (`seasonNumber: 1`, `isMultiSeason: true`).

No title prefilter: every Prowlarr result is parsed through the target arr.

## Approach

Add `parseTitle(title)` to the existing Servarr client and build a release-title
parser around it. Instantiate it once per release search service and share it
across indexers/searches.

For each Prowlarr result:

1. Call Sonarr `/parse` for series or Radarr `/parse` for movies.
2. Convert the arr response into the existing `ParsedReleaseName` shape.
3. For series multi-season packs, expand the release title's season range with
   the existing season-range helper.
4. Match the parsed title/year/season/episode against the requested media.
5. Keep the current grouping, labels, quality tiers and snapshot persistence.

If `/parse` fails, fail that indexer with the arr error. Do not silently drop
results and do not fall back to the old custom parser; parsing is now part of
the search and the error should be visible in the per-indexer chip.

### Cache

- Key: `${kind}:${title}`.
- Value: successful `ParsedReleaseName` plus an in-flight promise map so
  concurrent duplicate titles share one request.
- Max entries: 500, FIFO eviction (`Map` insertion order).
- Do not cache failures.
- Cache is process-local; snapshots already persist parsed results.

### Concurrency

Parse all releases for one indexer with bounded concurrency of 8 using the
existing `mapWithConcurrency` helper in
`server/backend/src/concurrency.ts`. This avoids firing hundreds of arr requests
at once while still parsing every result.

### Arr mapping

- **Series:** use `parsedEpisodeInfo.seriesTitleInfo.titleWithoutYear` (fallback
  `seriesTitle`/`title`) as the title, `year` from `seriesTitleInfo.year`,
  `seasonNumber`, `episodeNumbers`, `fullSeason`, `isMultiSeason`.
- **Series multi-season:** if `isMultiSeason` is true, replace the single season
  with the expanded range from the release title. Export the existing private
  `seasonsFromTitle` regex helper from `activity.ts`, rename it
  `seasonRangeFromTitle`, and use it from both places.
- **Movies:** use `parsedMovieInfo.primaryMovieTitle`/`movieTitle` as the title
  and retain `movieTitles` as aliases for matching. Use
  `parsedMovieInfo.year`.
- **Quality:** derive tier from `quality.quality.resolution` (2160 → 3,
  1080 → 2, 720 → 1, ≤576 → 0) and preserve the current quality label format
  (`2160p`, `1080p`, `720p`, `480p`).
- **Season pack:** true when `fullSeason` is true, `releaseType` is
  `seasonPack`, or there are no episode numbers.

### Matching

Keep the current match rules, but operate on parsed arr fields instead of raw
title text:

- Movie: requested title matches the primary title or one of `movieTitles`;
  when both years exist they must agree.
- Series: requested title matches the parsed series title (still allowing a
  trailing year/country qualifier such as `US`), and requested season is in the
  expanded season list. If an episode is requested, accept a season pack or a
  matching episode number.

## Files to modify

- `server/backend/src/upstream/servarr.ts`
  - Add `ServarrParseResponse` / parsed episode/movie types.
  - Add `parseTitle(title)` calling `/api/v3/parse`.
- `server/backend/src/release-name.ts`
  - Replace `parseReleaseName` with `createReleaseParser` backed by the arr.
  - Keep `releaseEpisodeLabel`, `releaseSeasonLabel`, `releaseSearchQuery`,
    `releaseSearchCategory`.
  - Convert match helpers to accept `ParsedReleaseName` instead of raw strings.
- `server/backend/src/release-search.ts`
  - Instantiate the parser once in `createReleaseSearchService`.
  - Make `normalizeRelease` async and parse all results with bounded
    concurrency.
  - Remove the raw-title parse/match calls.
- `server/backend/src/activity.ts`
  - Export/rename the existing multi-season range helper for reuse.
- `server/backend/test/release-name.test.ts`
  - Rewrite around arr response fixtures, matching, range expansion and cache
    behavior.
- `server/backend/test/release-search.test.ts`
  - Add `/api/v3/parse` handlers to fetch mocks; cover multi-season expansion.
- `server/backend/test/routes.test.ts`
  - Add parse responses to the shared `installShowReleaseFetch` helper and the
    movie/Prowlarr handlers.
- Docs that currently say churn uses its own release-name parser:
  `server/README.md`, `docs/src/server.md`, `docs/src/web-ui.md`.

## Reuse

- `server/backend/src/concurrency.ts` — `mapWithConcurrency`.
- `server/backend/src/activity.ts` — existing multi-season regex/range logic in
  `seasonsFromTitle` / `queueRecordSeasons`.
- `server/backend/src/upstream/servarr.ts` — existing `createArrClient`,
  `get`/`fetchJson`, `UpstreamError` handling and service config.
- `server/backend/src/release-search.ts` — existing snapshot validation and
  `RawIndexerRelease.parsed` shape.

## Steps

- [x] Add arr parse response types and `parseTitle(title)` to the Servarr client.
- [x] Export the multi-season range helper from `activity.ts`.
- [x] Replace the custom parser in `release-name.ts` with the cached arr-backed
      parser and arr-field matching.
- [x] Update `release-search.ts` to parse all Prowlarr results with concurrency
      8 before matching/grouping.
- [x] Update release-name, release-search and routes tests with `/parse`
      fixtures and cache/range assertions.
- [x] Update the docs passages that name churn's own parser.

## Verification

- `cd server && npm run typecheck`
- `cd server/backend && npx vitest run`
- `cd server && npm run build`
- Manual check against the local stack:
  - Open a movie and a show season; confirm indexer progress still streams.
  - Confirm unrelated releases are rejected and quality/season/episode labels
    still render.
  - Confirm a multi-season pack such as `S01-07` is accepted for season 4 and
    expands the grab/monitor range.
  - Confirm repeated searches do not repeat `/api/v3/parse` calls for the same
    title (inspect backend/request logs or add a temporary counter).
