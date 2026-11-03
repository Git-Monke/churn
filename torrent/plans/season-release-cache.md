# Cached movie/season release browsing

## Context

Automatic torrent selection is unreliable. Today `POST /api/requests` can add a
title and immediately run a seeders-aware pick that grabs a release. A dead or
wrong pick is worse than no pick: for Parks and Recreation Sonarr's automatic
search finds nothing, but an explicit season search returns plenty of good
torrents.

The new flow separates **adding** from **downloading**:

1. Requesting a movie/show only adds it to Radarr/Sonarr, unmonitored, with no
   search command.
2. The backend searches indexers in the background and caches the raw releases:
   one search for a movie, one search per regular season (excluding specials)
   for a show.
3. Clicking a title shows cached options grouped by quality tier. Only tiers
   with at least one release are shown, and releases inside a tier are ordered
   by seeders (highest first), then size.
4. A multi-season pack such as `S01-05` appears under every season it covers,
   even if Sonarr only returned it for the first season's search.
5. The user picks a release; only then does churn grab it and enable monitoring
   for the affected season(s) or movie.

Confirmed decisions:

- Cache persists to `server/cache/releases` and survives backend restarts.
- Automatic smart-pick/swarm re-pick is removed from the request path. All
  downloads start from an explicit user choice.
- New requests warm the cache in the background. Titles already in the arr
  search lazily when first opened, then stay cached.
- Season cache is per season; the existing on-demand per-episode picker stays
  available for repairing one episode.
- Show every tier the indexers return, even outside the arr quality profile.
  Picking an out-of-profile release grabs with an override.
- Below 50 seeders, show a "may be stale — refresh recommended" warning and a
  refresh button. Options are not hidden.
- Adding leaves titles unmonitored. Picking a movie or season enables the
  corresponding monitoring before the grab.

## Approach

### Backend release cache

Add `server/backend/src/release-cache.ts`.

Cache raw `ServarrRelease` objects server-side only. The browser never sees
GUIDs, magnets or indexer ids; it receives the existing opaque `releaseId`.

Storage model:

- `server/cache/releases/movie-<movieId>.json`
- `server/cache/releases/series-<seriesId>/s<searchSeasonNumber>.json`

Each file stores the result of **one search**:

```ts
interface CachedSearchFile {
  version: 1;
  kind: "movie" | "series";
  movieId?: number;
  seriesId?: number;
  searchSeasonNumber?: number;
  fetchedAt: string;
  releases: Array<{ release: ServarrRelease; searchSeasonNumber?: number }>;
}
```

Keeping one file per Sonarr season search is important: a multi-season pack is
returned by only one search, but it must be visible for every covered season.
`getSeriesSeason(seriesId, seasonNumber)` reads all cached search files for that
series and merges every release whose `releaseSeasonNumbers()` includes the
requested season, deduping by `releaseId`. Refreshing season 2 only replaces
the season-2 search file; packs found under season 1 remain visible.

Cache module API:

```ts
createReleaseCache({ cacheDir, now? })
  getMovie(movieId): CachedReleaseView
  getSeriesSeason(seriesId, seasonNumber): CachedReleaseView
  warmMovie(movieId, fetch): Promise<void>
  warmSeriesSeason(seriesId, seasonNumber, fetch): Promise<void>
  warmSeries(seriesId, seasons, fetch): Promise<void>   // concurrency 2
  isRefreshing(target): boolean
  findRelease(target, releaseId): CachedRelease | undefined
  invalidateMovie(movieId): Promise<void>
  invalidateSeries(seriesId): Promise<void>
```

Implementation notes:

- Lazy-load a file on first read; ignore corrupt/unreadable files and overwrite
  them on the next successful search.
- Atomic writes: write `<file>.tmp`, then rename.
- Deduplicate concurrent warm requests per target with an in-flight map, so
  opening a season while the add-time warm is running does not spawn a second
  indexer search.
- No automatic expiry: results stay until refreshed. The response carries
  `fetchedAt` so the UI can show cache age. A manual refresh is the escape
  hatch, matching the 50-seeder warning decision.
- `invalidateSeries` removes the season directory; `invalidateMovie` removes the
  movie file. Call these from title deletion.

### Release mapping and quality groups

Extend the existing mapping rather than creating a parallel release model:

- Add `tier?: number` and `tierLabel?: string` to `ShowRelease` / the shared
  release option type, using `releaseTier()` from `release-pick.ts`.
- Add a `ReleaseGroup` shape:
  ```ts
  interface ReleaseGroup {
    tier: number;          // 0 = 480p/SD, 1 = 720p, 2 = 1080p, 3 = 2160p, 99 = other
    label: string;         // "480p" | "720p" | "1080p" | "2160p" | "Other"
    maxSeeders?: number;
    lowSeeders: boolean;   // maxSeeders < 50
    releases: ShowRelease[]; // seeders desc, then size asc, then age
  }
  ```
- One shared function in `releases.ts` maps raw releases and produces sorted
  groups, used by both movie and season endpoints.
- Groups are ordered by tier (`480p` → `2160p`, `Other` last). The frontend
  defaults to the highest available tier and lets the user switch.
- Keep the existing `recommended` field on `ShowRelease` for compatibility, but
  do not use it to auto-select anything.

### Warming searches

- After a successful movie add: `void warmMovie(movieId, () =>
  client.getMovieReleases(movieId))`.
- After a successful series add: derive regular seasons from the added
  `resource.seasons` (fallback `client.getSeries(id)`), drop season 0, and
  `void warmSeries(seriesId, seasons, (season) =>
  client.getSeasonReleases(seriesId, season))`.
- Return the add response immediately; warming runs after it. Suppress errors
  into the cache's `lastError` state so the UI can retry.
- On a cache read with no search file for that target/season, kick off the same
  background warm and return `state: "searching"` instead of blocking a request
  for the 30-second indexer timeout.

### API contract

New shared response for cached browsing:

```ts
interface CachedReleasesResponse {
  kind: "movie" | "series-season";
  service: "radarr" | "sonarr";
  targetId: number;          // movieId or seriesId
  seasonNumber?: number;
  state: "ready" | "searching" | "error";
  refreshing: boolean;
  detail?: string;           // last search error, when state is "error"
  fetchedAt?: string;
  releaseCount: number;
  groups: ReleaseGroup[];
}
```

Routes:

- `GET /api/library/movies/:id/releases` — cached movie releases. Starts a
  background search and returns `searching` on a cold cache.
- `POST /api/library/movies/:id/releases/refresh` — re-run the movie search.
- `GET /api/library/shows/:source/:id/releases?season=N` — source must be
  `sonarr`. With no `episode` parameter, serve the cached/merged season view
  instead of running a search. The `scope=all` merge view is no longer needed;
  packs are already expanded across seasons.
- `POST /api/library/shows/:source/:id/releases/refresh?season=N` — re-run just
  that season search.
- `GET /api/library/shows/:source/:id/releases?season=N&episode=E` — unchanged:
  direct Sonarr episode search for the episode picker.
- `POST /api/library/shows/:source/:id/releases/grab` — same body, but resolve
  the release from the series cache first (`findRelease`), then fall back to a
  fresh `getSeasonReleases` if the cache no longer has it.
- `POST /api/library/movies/:id/releases/grab` — new; body
  `{ releaseId: string }`. Resolve from the movie cache, fall back to
  `getMovieReleases`.
- `GET /api/library/movies/:source/:id` — movie detail for the new movie page.
  `source` is `radarr` (direct `getMovie` + `requestedMovieItem`) or `jellyfin`
  (load the Jellyfin item, match Radarr by `tmdbId` via `listMovies`, and expose
  the matched `radarrId`). A Jellyfin-only movie with no Radarr match returns
  metadata plus no release target.

All new/changed routes keep `cache-control: no-store`, the existing JSON error
envelope and id validation.

### Request behaviour

Simplify `POST /api/requests` and the request options:

- Keep `qualityProfileId` and `rootFolderPath` validation/resolution.
- Remove `searchOnAdd`, `smartPick`, `minSeeders` and the series `monitor` input
  from the backend contract and frontend request-options panel.
- Movie add:
  - `monitored: false`
  - `addOptions: { searchForMovie: false }`
- Series add:
  - `monitored: false`
  - every season `monitored: false`
  - `addOptions: { monitor: "none", searchForMissingEpisodes: false }`
- Response is `added` with `searching: true` when a background warm was
  started. Remove `downloads` from the request response.
- Remove `smartPickMovie`, `smartPickSeasons` and the request-time
  `scheduleSwarmWatch` path. The old `swarm-watch`/`release-events` modules can
  stay in place for now but are no longer invoked by requests; the Library
  re-pick notice will simply have no events.

### Grab behaviour

- Series grab:
  - Find the raw release in the series cache.
  - If missing from the cache, search the release's `searchSeasonNumber` (or the
    requested season) and find it as today.
  - Use `seasonPackSeasons` to find all covered seasons; call
    `monitorSeriesSeasons` before grabbing a multi-season pack. For a
    single-season pack, monitor that season.
  - Override when `releaseNeedsOverride` is true. For Sonarr still require
    mapped episode ids before an override, as today.
- Movie grab:
  - Find the raw release in the movie cache (fallback fresh `getMovieReleases`).
  - Add `updateMovie(id, { ...movie, monitored: true })` to the arr client;
    monitor before grabbing so Radarr imports the file.
  - Override when `releaseNeedsOverride` is true.
- The frontend must show rejection reasons and a "needs override" hint so a
  manual pick is informed. Out-of-profile tiers are expected to use overrides.

### Frontend

#### Movie detail page

- Add route `#/library/movie/:source/:id` (`source` = `jellyfin` | `radarr`) to
  `use-hash-route.ts` and `App.tsx`.
- New `pages/MoviePage.tsx`:
  - fetches `GET /api/library/movies/:source/:id`;
  - shows poster/metadata;
  - shows a **Play** button when a Jellyfin id is available;
  - renders the shared release chooser for the matched `radarrId`.
- `LibraryGrid` changes movie links to the movie detail page instead of directly
  to `#/play/...`. Playback remains one click away inside the page.

#### Shared release chooser

Refactor the release UI into a reusable chooser used by both movie and show
pages:

- `features/releases/ReleaseChooser.tsx` (or a generalized `ReleasePicker`)
  receives `kind`, `id`, optional `seasonNumber`, and fetches the cached
  endpoint.
- States:
  - `searching` / `refreshing`: spinner and "Searching indexers…";
  - `ready`: quality chips/tabs for only the tiers in `groups`, defaulting to
    the highest available tier;
  - `error`: message plus refresh.
- Tier view lists releases sorted by seeders descending, then size ascending.
  Each row shows title, size, seeders, indexer, quality, age, coverage
  (`Season 1`, `Seasons 1–5`), rejection reasons and override hint.
- `group.lowSeeders` shows a banner: "The best option here has fewer than 50
  seeders; these results may be stale." with a **Refresh** button calling the
  refresh route.
- A refresh button and cache age (`fetchedAt`) are always visible, including
  when results exist.
- Grab mutation calls the matching grab endpoint, then invalidates `activity`,
  `requested-library`, `show`, and the cached release query.

`ShowPage`:

- **Choose release** shows the cached season chooser for the selected season.
- Remove the **All seasons** scope toggle; multi-season packs are already
  expanded into every season.
- Keep the episode-level **Choose release** dialog on missing episodes, using
  the existing direct episode search path.
- Reword the current "No automatic download for this season" alert to prompt
  choosing a season release.

`SearchSection`:

- Request still adds the title, but the success toast says it is searching for
  releases in the background and offers a **View releases** action to the new
  detail page.
- Remove the automatic `ReleasePickerDialog` opening after adding a show.
- Remove the now-unused release-selection state.

`RequestOptionsPopover` / `use-request-defaults.ts`:

- Keep quality profile and root folder.
- Remove Prefer smaller files, Search on add, Seeders-aware pick, Minimum
  seeders and Episodes to monitor.
- Bump the localStorage key so old stored values are ignored. Defaults come from
  the server (`qualityProfileId`, `rootFolderPath`).

## Files to modify

Backend:

- `server/backend/src/release-cache.ts` — new cache, disk store, warming,
  grouping helpers.
- `server/backend/src/releases.ts` — tier fields, shared mapping/grouping/sort.
- `server/backend/src/routes/requests.ts` — add unmonitored, remove auto-grab,
  background warm, simplified input.
- `server/backend/src/routes/shows.ts` — cached season reads, refresh route,
  cache-first grab; keep episode search.
- `server/backend/src/routes/movies.ts` — new movie detail, cached releases,
  refresh and grab routes.
- `server/backend/src/routes/requested.ts` — invalidate cache on delete.
- `server/backend/src/upstream/servarr.ts` — add `updateMovie`.
- `server/backend/src/types.ts` — cached release/group/movie detail and
  simplified request contracts.
- `server/backend/src/server.ts` — create the cache instance, register movie
  routes, pass the cache to request/show/movie routes.
- `server/backend/test/release-cache.test.ts` — new.
- `server/backend/test/releases.test.ts`, `routes.test.ts` — update/add coverage.

Frontend:

- `server/frontend/src/api/types.ts`, `src/api/client.ts` — new endpoints/types.
- `server/frontend/src/features/releases/ReleaseChooser.tsx` — new shared
  chooser; keep an episode variant for the existing dialog.
- `server/frontend/src/features/show/ReleasePicker.tsx`,
  `ReleasePickerDialog.tsx` — split/refactor into season cached chooser and
  episode direct-search picker.
- `server/frontend/src/pages/MoviePage.tsx` — new.
- `server/frontend/src/pages/ShowPage.tsx` — season chooser wiring.
- `server/frontend/src/features/library/LibraryGrid.tsx` — movie detail links.
- `server/frontend/src/features/search/SearchSection.tsx`,
  `RequestOptionsPopover.tsx`, `use-request-defaults.ts` — simplified requests.
- `server/frontend/src/hooks/use-hash-route.ts`, `src/App.tsx` — movie route.

Docs:

- `README.md`, `server/README.md`, `docs/src/web-ui.md`,
  `docs/src/server.md` — replace the smart-pick/auto-grab sections with the
  cached chooser flow and new API routes.

## Reuse

- `server/backend/src/releases.ts` — `releaseId`, `findRelease`,
  `releaseSeasonNumbers`, `releaseMatchesSeason`, `seasonPackSeasons`,
  `monitorSeriesSeasons`, `toShowReleases`, `mappedEpisodeIds`,
  `releaseNeedsOverride`, `buildReleaseGrabPayload`.
- `server/backend/src/release-pick.ts` — `releaseTier`, `qualityTierFromName`.
- `server/backend/src/concurrency.ts` — `mapWithConcurrency` for per-season
  prefetch.
- `server/backend/src/upstream/servarr.ts` — `getSeasonReleases`,
  `getMovieReleases`, `grabRelease`, `getSeries`, `updateSeries`, add
  `updateMovie` alongside `getMovie`.
- `server/backend/src/routes/shows.ts` / `requested.ts` / `activity.ts` —
  existing show mapping, `requestedMovieItem`, `movieMetadata`,
  `seriesMetadata`.
- `server/backend/src/errors.ts`, `upstream/states.ts` — `ApiError`,
  `errorMessage`, `stateForError`.
- `server/frontend/src/features/show/ReleasePicker.tsx` — existing release row
  layout and grab mutation patterns.
- `server/frontend/src/features/library/LibraryGrid.tsx`,
  `library-entries.ts` — card links and entry merging.
- Existing shadcn primitives (`Card`, `Badge`, `Button`, `Tabs`, `Alert`,
  `Progress`, `Skeleton`, `Dialog`).

## Steps

- [x] Add `release-cache.ts` with disk persistence, lazy load, atomic writes,
  in-flight dedupe, per-search-season files and merge-on-read.
- [x] Add shared release tier/group mapping and seeders-first sorting in
  `releases.ts`, with unit tests for 480/720/1080/2160/other groups and
  multi-season expansion.
- [x] Add `updateMovie` to the arr client.
- [x] Simplify `POST /api/requests`: unmonitored adds, no search command, no
  auto-grab, background warm for movie/all regular seasons, simplified options.
- [x] Add movie detail, cached movie releases, refresh and grab routes.
- [x] Change show season release GET to cached mode; add refresh; make grabs
  cache-first; keep episode search unchanged.
- [x] Invalidate cache on title delete.
- [x] Add backend tests for cache persistence/merge/refresh, add-time warming,
  unmonitored adds, cold-cache `searching`, cache-first grabs, delete
  invalidation and movie matching.
- [x] Add frontend API types/client calls.
- [x] Build the shared cached release chooser with quality groups, seeders sort,
  low-seeder warning, cache age and refresh.
- [x] Add `MoviePage` + route; update `LibraryGrid` movie links.
- [x] Update `ShowPage` to use the cached season chooser; keep the episode
  picker.
- [x] Simplify `RequestOptionsPopover`/defaults and the post-request toast.
- [x] Update docs and run typecheck, tests and production build.

## Verification

Automated:

```bash
cd server
npm run typecheck
npm test
npm run build
```

Unit/route expectations:

- Adding a movie posts `monitored: false` and `addOptions.searchForMovie: false`;
  no `/api/v3/release` or `/api/v3/command` grab/search is issued.
- Adding a series posts every season unmonitored with `monitor: "none"`;
  background season searches then fill the cache.
- A cold `GET .../releases` returns `state: "searching"` and later `ready`.
- A multi-season pack cached by the season-1 search appears in the season-2 and
  season-5 views after the merge.
- A refresh of one season replaces only that search file and keeps packs from
  sibling searches.
- Cache files still produce options after a fresh `buildServer`/restart.
- Grabbing a cached release does not run a second indexer search; deleting the
  title removes its cache files.
- Groups only contain populated tiers and each group is seeders-descending.
- `lowSeeders` is true when a group's best release has fewer than 50 seeders.

Manual against the local stack:

1. Add Parks and Recreation. Confirm it appears in Sonarr unmonitored and that
   no download starts; watch `server/cache/releases/series-<id>/` fill with one
   file per regular season.
2. Open the show, choose season 2. Confirm quality chips appear only for
   populated tiers, options are seeders-sorted, and a multi-season pack found
   under another season is listed.
3. Pick a release. Confirm Sonarr starts the download, the season becomes
   monitored, and the Library/Activity views update.
4. Add a movie. Confirm no download starts, then open the movie detail page,
   switch quality tiers, and pick a release. Confirm Radarr starts the download
   and the movie becomes monitored.
5. Restart the backend and reopen the same movie/season. Confirm options load
   from disk immediately without a new indexer search.
6. Force a low-seed result (or mock one) and confirm the stale warning plus
   Refresh button appear; Refresh updates the cache.
7. Confirm a Jellyfin-only movie opens the detail page with Play and, when a
   Radarr match exists by TMDB id, release options.

## Risks / notes

- **Out-of-profile imports.** Manual grabs use `shouldOverride` when the arr
  rejected the release, but an import can still be rejected by Sonarr/Radarr
  for reasons beyond the grab decision. The UI shows rejection reasons so the
  user can avoid obviously wrong releases.
- **Indexer load.** Add-time warming of every season is many searches. Use
  concurrency 2, dedupe in-flight work, and skip specials. Failures are
  per-season and retryable from the UI.
- **Disk growth.** Cache files hold raw release objects. Delete them when a
  title is deleted, ignore corrupt files, and keep the format versioned. No
  automatic eviction in this change.
- **Stale seeders.** Tracker counts drift. The 50-seeder warning and refresh
  button are the explicit remedy; there is no automatic background expiry.
- **Monitoring semantics.** Titles stay unmonitored until picked, so Sonarr RSS
  cannot auto-download new episodes first. Picking a season or movie enables
  monitoring. A user who wants RSS behaviour can monitor the show manually in
  Sonarr.
- **Jellyfin-only movies.** Without a Radarr match there is no release target;
  the movie page still supports playback and explains that no release options
  are available.
