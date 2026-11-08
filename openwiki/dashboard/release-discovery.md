---
type: Subsystem Design
title: Release discovery and ranking
description: How churn searches every enabled Prowlarr indexer in parallel, parses and filters release names through the arr parser, groups results by quality tier, persists snapshots, and sends a chosen release straight to qBittorrent.
tags: [releases, prowlarr, sonarr, radarr, qbittorrent, search, caching]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-a15098abbd4c7b959a0a3115
    resource: repo://server/backend/src/direct-grab.ts
  - id: openwiki-source-96d9fa0153d90aa9e299d91c
    resource: repo://server/backend/src/download-recovery.ts
  - id: openwiki-source-ab7b2e6fda7ed36b45679083
    resource: repo://server/backend/src/release-events.ts
  - id: openwiki-source-c6137cccef7a27eb30b2df94
    resource: repo://server/backend/src/release-name.ts
  - id: openwiki-source-3fab279402668ddba60abed3
    resource: repo://server/backend/src/release-pick.ts
  - id: openwiki-source-2267e8b47b7fbabe9272e9d1
    resource: repo://server/backend/src/release-search.ts
  - id: openwiki-source-08d979fb68c2f8ab874c35bd
    resource: repo://server/backend/src/releases.ts
  - id: openwiki-source-1ada2f5dc40bec3783a5f577
    resource: repo://server/backend/src/routes/activity.ts
  - id: openwiki-source-441b6e63fde745a15bdbde34
    resource: repo://server/backend/src/routes/movies.ts
  - id: openwiki-source-4e348f361b78462a80f8e2bb
    resource: repo://server/backend/src/routes/shows.ts
  - id: openwiki-source-01fe9ce3efac2bdf7c808e2a
    resource: repo://server/backend/src/swarm-watch.ts
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Release discovery and ranking

Release discovery is Prowlarr-first. Opening a movie or season starts one search per enabled Prowlarr indexer and returns progressive results as each indexer settles. Churn's own parser and matching logic decides which results are relevant, and a chosen result is sent **directly to qBittorrent** — there is no second Sonarr/Radarr release search or arr grab on the current grab routes.

This differs from the legacy `release-cache.ts` / `release-options.ts` / `toShowReleases` path, which was built around Sonarr/Radarr release lists. Those modules remain in the tree but are not imported by the current release-search service or its routes; the active pipeline lives in `release-search.ts` + `release-name.ts` + `releases.ts` + `direct-grab.ts`.

## Search job lifecycle

`createReleaseSearchService` (in `release-search.ts`) keeps jobs in memory keyed by target:

- movie: `{ kind: "movie", movieId }`
- series season: `{ kind: "series", seriesId, seasonNumber }`

`startJob` returns an existing in-flight job for the same key, so opening the same season twice does not launch duplicate indexer searches. Episode views reuse the season search and filter it client-side (`getSeriesEpisode`), rather than searching again.

For a new job the service:

1. Loads media metadata from the media cache, falling back to Radarr/Sonarr and caching the result.
2. Builds a query: `"Title Year"` for movies, `"Title S01"` for seasons; categories `2000` (movies) and `5000` (TV).
3. Lists Prowlarr's enabled indexers.
4. Creates one `JobIndexer` per indexer with `pending` state.
5. Runs all indexers in parallel.

If Prowlarr has no API key, no enabled indexers, or cannot list indexers, the job completes immediately with an error string rather than hanging.

### Per-indexer execution

Each indexer search uses a 30-second minimum timeout (`RELEASE_SEARCH_TIMEOUT_MS`), marks `searching`, collects raw results, normalizes them with at most 8 concurrent arr parses, and marks `finished` with a count or `error` with a detail. A job is finished only when every indexer is settled **and** the snapshot has been written; the response reports `state: "searching"` until then.

The response's `progress` object lists every indexer with its state and count, which is what the UI uses for "5/9 indexers finished" and per-indexer chips.

### Snapshot persistence

When a job settles, it writes `SNAPSHOT_VERSION = 2` JSON under the release cache directory:

```
<cache>/movie-<id>.json
<cache>/series-<id>/season-<n>.json
```

Writes go through a temporary file and `rename`. `state: "ready"` promises that the snapshot is on disk. A later open reads the snapshot instead of searching again; explicit `refresh*` calls ignore the completed job and start a fresh search seeded with the old snapshot. At most 100 jobs are retained in memory, pruning oldest completed jobs first.

`invalidateMovie` / `invalidateSeries` delete both the in-memory jobs and the cached snapshots plus cached media metadata; title cancellation uses these.

### Background warm-up

- `warmMovie(movieId)` starts a search only if no job exists.
- `warmSeries(seriesId, seasons)` queues seasons in ascending order, one at a time, skips seasons Sonarr reports as complete, skips seasons that already have a snapshot, and waits for an existing in-flight season instead of starting a second search.
- Explicitly opening a season can jump the queue; the queue keeps running in the background.

Requests trigger warm-up without starting a download.

## Release names and relevance

`createReleaseParser` asks the matching arr (`Sonarr /parse` for series, `Radarr /parse` for movies) to parse each title. Parsed entries are cached with an LRU-like cap, and duplicate in-flight parses for the same title are coalesced.

`mapArrParseResponse` produces a `ParsedReleaseName` containing:

- primary title, title tokens and alternate movie titles,
- years,
- season numbers (including expanded multi-season ranges),
- episode numbers,
- `seasonPack` when the release is a full season with no episode list,
- quality label and tier (`0` SD, `1` 720p, `2` 1080p, `3` 2160p).

Filtering rules:

- **Movies:** at least one parsed title (or alias) tokenizes to the requested title; if the release carries a year, it must match the requested year. Missing years are not a rejection.
- **Series:** the series title must match, the release must include the requested season, and when an episode is requested the release must either list that episode or be a season pack.
- **Episode narrowing:** a season search that is later filtered for an episode uses `releaseCoversEpisode`, which accepts episode lists or season packs.

### Deduplication and grouping

Within a job, releases are deduplicated by lowercased `infoHash`, falling back to `indexerId:guid`, keeping the copy with more seeders. Results can be grabbed when `directDownloadSource` finds a magnet or torrent URL; results without one remain visible but disabled with a "refresh the search" detail.

`groupShowReleases` groups by tier (`99` for unknown quality), sorts groups ascending, and sorts members by seeders then size. A group's `lowSeeders` flag is set when its best release has fewer than 50 seeders, which drives the UI's "may be stale" warning and refresh button.

## Quality and seeder policy

`release-pick.ts` defines the ranking policy used by the arr-release mapping path and the swarm watcher:

- `DEFAULT_MIN_SEEDERS = 5`.
- Approved releases that clear the seeder gate are preferred at the requested tier; if that tier is dead, the picker may climb exactly one tier.
- Quality-only rejections may be overridden; language, mapping, indexer and other rejections never are.
- If nothing clears the gate, the least-bad approved release at the requested tier is still returned so a request has a target.
- Usenet releases bypass the seeder gate.

`qualityTierFromName` resolves combined profile names such as "HD - 720p/1080p" to the *smaller* tier so the picker only climbs when the smaller tier is genuinely dead.

## Direct grabbing

`grabTorrentDirect` sends the chosen Prowlarr result to qBittorrent:

1. Requires `QBITTORRENT_API_KEY`.
2. Prefers `magnetUrl`, then `downloadUrl`, then a `magnet:` GUID. A plain HTTP GUID landing page is not a download source.
3. Chooses a save path:
   - the arr title's folder when Sonarr/Radarr returns an absolute `path`;
   - otherwise `/data/media/movies/<Title (Year)>` or `/data/media/tv/<Title (Year)>`;
   - single-season downloads go into `<series folder>/Season N`;
   - multi-season or season-less packs go into the series folder.
4. Adds the torrent with category `movies`/`tv`, tags `churn-direct` and `churn-<kind>-<arrId>`, `contentLayout: "NoSubfolder"` and `autoTMM: false`.
5. If the torrent already exists (hash match before adding, title match after a failed add), tags it and returns `alreadyDownloading` instead of failing. This makes a double click behave like a single click.

The `churn-<kind>-<arrId>` tag is what lets the activity and show pages attach hash-named magnets to the right title.

After a successful grab, the show route warms IntroDB for the episode or season in the background; it is not awaited.

## Swarm watching and duplicate recovery (not wired)

Two substantial modules exist with tests but no production call sites in the current tree:

- `swarm-watch.ts` can watch a queue record, sample connected seeds/speed/progress, and re-pick a better-seeded release. Its default policy is 3 s start delay, 30 s to find the queue record, 60 s warm-up, 15 s sampling, 4 samples, 2 unhealthy samples, a 300 KiB/s speed floor, a 25% progress ceiling, and at most one re-pick. `pickRepickRelease` never downgrades tier, never exceeds `preferredTier + 1`, and requires at least 1.5× the current reported seeders.
- `download-recovery.ts` can repair Sonarr/Radarr's misleading "qBittorrent connection failure" by removing the duplicate torrent without deleting files, waiting for it to disappear and retrying the arr grab.

`release-events.ts` provides the in-memory ring that `/api/activity` exposes as `repicks`, but no current route records events into it, so the feed is empty in production unless a caller is added.

Treat these as available building blocks rather than active behaviour when describing the installed system.

## Relevant tests

- `server/backend/test/release-search.test.ts` — per-indexer progress, episode narrowing, multi-season packs, direct grabbability, snapshot persistence/versioning, warm queues, complete-season skipping.
- `server/backend/test/release-name.test.ts` — parse mapping, title/year/season matching, labels and queries.
- `server/backend/test/release-pick.test.ts` — tier preference, dead-tier upgrade, quality-only overrides, usenet handling.
- `server/backend/test/releases.test.ts` — grouping and release mapping.
- `server/backend/test/direct-grab.test.ts` — tags, sources, save paths and duplicate adds.
- `server/backend/test/swarm-watch.test.ts` and `download-recovery.test.ts` — the latent helpers described above.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/downloads-and-sync.md] link "/openwiki/dashboard/downloads-and-sync.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Downloads, activity and library sync](/openwiki/dashboard/downloads-and-sync.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/library-and-requests.md] link "/openwiki/dashboard/library-and-requests.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Library browsing, search and requests](/openwiki/dashboard/library-and-requests.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
