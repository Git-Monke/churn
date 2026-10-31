# Three-page UI + merged Library activity

## Context

The dashboard is one long page today: Services cards, Search, then the Jellyfin
Library. This change turns it into three focused pages — **Services**,
**Library**, and **Search** — and makes Library the single place to understand
media state:

- titles available in Jellyfin;
- titles Sonarr/Radarr are actively downloading or importing right now.

Movies stay simple: one card for the movie, with download progress when it is
active. Shows are represented once at show level; clicking a show opens a
detail view with a season selector and an episode list that shows availability
and per-episode download progress.

This stays within the existing stateless BFF design: no database, no history,
no new download-client integration, and no browser access to arr URLs/keys.

### Confirmed decisions

- Top tab navigation under the existing app header.
- Library shows only **active** queue items, not completed history.
- Duplicate Jellyfin + queue titles merge into one card using TMDB/TVDB ids.
  No matching id means two separate entries.
- Shows that exist only in the Sonarr queue still open a Sonarr-backed detail
  page.
- Show detail lists the union of Jellyfin and Sonarr episodes, including
  missing/upcoming Sonarr episodes.
- Sonarr season packs mark every episode in that season with the pack's
  download state/progress.
- Default detail season: first season with a Jellyfin episode, then first season
  with an active download, then first non-special season.

### Non-goals

- Queue delete/cancel/retry actions.
- Completed download history.
- Jellyfin playback controls.
- Movie detail pages.

## Approach

### 1. Backend: arr queue client

Extend `server/backend/src/upstream/servarr.ts` with typed queue support:

- `getQueue()` → `/api/v3/queue?page=1&pageSize=1000`; add
  `includeUnknownSeriesItems=true` for Sonarr.
- `getSeries(id)` → `/api/v3/series/:id`.
- `getMovie(id)` → `/api/v3/movie/:id`.
- `getEpisodes(seriesId)` → `/api/v3/episode?seriesId=:id`.

Add types for queue responses/records and Sonarr episodes. Queue records need
only the fields the UI uses: ids, status, tracked state/status, size/sizeleft,
timeleft, ETA, protocol, client, quality, season/episode ids, and status
messages.

Implement a shared active-item check used by activity and show detail:

```ts
// queued/downloading, or completed but still importing/import-blocked
isActiveQueueRecord(record)
```

Exclude failed, imported, and completed records that are not waiting on import.

### 2. Backend: `GET /api/activity`

New route in `server/backend/src/routes/activity.ts`, registered in `server.ts`.
Returns HTTP 200 with per-service states even when one arr is down.

```ts
interface ActivityResponse {
  checkedAt: string;
  services: Array<{
    id: "sonarr" | "radarr";
    state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
    detail?: string;
    count: number; // active queue records
  }>;
  items: ActivityItem[];
  total: number; // aggregated media items
  detail?: string;
}

interface ActivityItem {
  key: string;              // "movie:<tmdbId>" / "series:<tvdbId>" fallback ids
  service: "sonarr" | "radarr";
  kind: "movie" | "series";
  title: string;
  year?: number;
  overview?: string;
  network?: string;
  rating?: number;
  runtimeMinutes?: number;
  imageUrl?: string;        // existing /api/search/images/:service proxy
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  movieId?: number;
  seriesId?: number;
  seasons?: number[];
  queueCount: number;
  status: "queued" | "downloading" | "importing" | "warning";
  progress: number;         // 0–100
  sizeBytes?: number;
  sizeLeftBytes?: number;
  timeLeft?: string;
  estimatedCompletionTime?: string;
  downloadClients: string[];
  protocols: Array<"torrent" | "usenet">;
  quality?: string;
  statusMessages?: string[];
}
```

Processing per service:

1. Missing key → `unconfigured`; 401/403 → `unauthorized`; transport error →
   `unreachable`. Reuse `stateForError` / `errorMessage` from
   `upstream/states.ts`.
2. Fetch the queue and filter active records.
3. Resolve unique `seriesId` / `movieId` values with `Promise.allSettled` using
   `getSeries` / `getMovie`. Metadata failures fall back to the queue release
   title, no poster.
4. Aggregate queue records by media id:
   - series → one item per `seriesId`;
   - movies → one item per `movieId`.
5. Aggregate progress from bytes when available
   (`100 * (1 - sizeleft / size)`), otherwise from item progress.
6. Aggregate status priority: `warning` → `importing` → `downloading` →
   `queued`.
7. Merge unique seasons, download clients, protocols, quality names and status
   messages.
8. Use `mediaCoverUrl()` from `server/backend/src/search.ts` for posters.

Cache-control: `no-store`.

### 3. Backend: provider ids on Jellyfin items

Extend `server/backend/src/upstream/jellyfin.ts`:

- Add `ProviderIds?: Record<string, string>` to `JellyfinItem`.
- Request `ProviderIds` in the library `Fields`.
- Map case-insensitive `Tmdb`, `Tvdb`, and `Imdb` ids into `LibraryItem`.
- Add `getItem(itemId)`, `getSeasons(seriesId)`, and `getEpisodes(seriesId)` for
  show detail. Episode fields: `ParentIndexNumber`, `IndexNumber`, `Name`,
  `Overview`, `PremiereDate`, `RunTimeTicks`, `ImageTags.Primary`,
  `ProviderIds`.

Extend `LibraryItem` in `server/backend/src/types.ts` and the frontend API type
with `tmdbId?`, `tvdbId?`, and `imdbId?`.

### 4. Backend: `GET /api/library/shows/:source/:id`

New route in `server/backend/src/routes/shows.ts`. `source` is `jellyfin` or
`sonarr`; `id` is a Jellyfin item id or positive Sonarr series id.

```ts
interface ShowDetailResponse {
  source: "jellyfin" | "sonarr";
  state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
  detail?: string;
  warnings?: string[];       // e.g. Sonarr unavailable while Jellyfin worked
  series: {
    title: string;
    year?: number;
    overview?: string;
    network?: string;
    rating?: number;
    imageUrl?: string;
    tvdbId?: number;
    tmdbId?: number;
    imdbId?: string;
  };
  defaultSeason?: number;
  seasons: Array<{
    seasonNumber: number;
    name: string;
    episodeCount: number;
    availableCount: number;
    downloadingCount: number;
  }>;
  episodes: Array<{
    key: string;             // "s01e02"
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    overview?: string;
    airDate?: string;
    runtimeMinutes?: number;
    imageUrl?: string;
    monitored?: boolean;
    availability: "jellyfin" | "sonarr" | "missing" | "upcoming";
    download?: {
      status: "queued" | "downloading" | "importing" | "warning";
      progress: number;
      timeLeft?: string;
      estimatedCompletionTime?: string;
      sizeBytes?: number;
      downloadClient?: string;
      protocol?: "torrent" | "usenet";
      quality?: string;
      seasonPack?: boolean;
      statusMessages?: string[];
    };
  }>;
}
```

Jellyfin source flow:

1. Fetch Jellyfin series item, seasons and episodes.
2. Read `ProviderIds.Tvdb`; if present and Sonarr is configured, find the Sonarr
   series by `tvdbId` from `listSeries()`.
3. If matched, fetch Sonarr episodes and active queue in parallel. If either
   fetch fails, keep the Jellyfin data and add a warning.
4. Merge Jellyfin and Sonarr episodes by `season:episode`.
5. Availability precedence:
   - Jellyfin episode exists → `jellyfin`;
   - Sonarr episode `hasFile` → `sonarr` (“In Sonarr”, imported but not yet in
     Jellyfin);
   - future `airDateUtc` → `upcoming`;
   - otherwise → `missing`.

Sonarr source flow:

1. Require the Sonarr key.
2. Fetch series, episodes and active queue.
3. Build the same union shape without Jellyfin availability.

Download overlay:

- Per-episode queue record → map `episodeId` through the Sonarr episode list.
- Season pack (`seasonNumber` present, no episode id) → apply the same status,
  progress, client and ETA to every episode in that season and set
  `seasonPack: true`.
- If multiple records hit an episode, prefer downloading → importing → queued,
  then the highest progress.
- Episode image: Jellyfin episode image when present, otherwise the show poster.

Error handling:

- Jellyfin/Sonarr unconfigured, unauthorized or unreachable returns HTTP 200
  with the state and empty data, matching `/api/library`.
- A missing Jellyfin item or Sonarr series returns 404.
- Unexpected errors bubble to the existing Fastify error handler.

### 5. Frontend: route shell and pages

Add a tiny hash router without a dependency:
`server/frontend/src/hooks/use-hash-route.ts`.

Routes:

```text
#/services
#/library
#/library/show/jellyfin/<itemId>
#/library/show/sonarr/<seriesId>
#/search
```

- Empty/unknown hash → `#/services`.
- `useHashRoute()` listens to `hashchange` and returns the parsed route.
- Navigation uses real `<a href="#/...">` links so pages are deep-linkable and
  openable in a new tab.

`App.tsx` becomes a route shell:

- keeps the global status query for the header timestamp and Services page;
- renders `AppHeader` with top-tab nav;
- renders one page component at a time;
- keeps `Toaster`;
- header refresh refetches active queries via React Query and shows success/error
  toast; spinner comes from `useIsFetching()`.

`AppHeader` adds the Services / Library / Search links under the title. The
Show detail route highlights Library.

### 6. Frontend: page split

- `pages/ServicesPage.tsx` → existing `ServiceStatusGrid`, fed by the status
  query. No search/library requests while on this page.
- `pages/SearchPage.tsx` → existing `SearchSection` unchanged except it is now
  the only content on the Search page.
- `pages/LibraryPage.tsx` → merged Jellyfin + activity view.
- `pages/ShowPage.tsx` → show detail.

### 7. Frontend: Library merge

Add API types/client:

- `fetchActivity()` → `GET /api/activity`.
- `fetchShowDetail(source, id)` → `GET /api/library/shows/:source/:id`.

`LibraryPage` queries:

- `["library"]` — existing `/api/library`, 60s refetch;
- `["activity"]` — new `/api/activity`, 10s refetch;
- both render independently, so a broken arr or Jellyfin does not hide the other
  side.

Add `features/library/library-entries.ts`:

```ts
interface LibraryEntry {
  key: string;
  type: "Movie" | "Series";
  library?: LibraryItem;
  activity?: ActivityItem;
  status: "available" | "downloading" | "both";
}
```

Merge rules:

- Match movies by `tmdbId`; match series by `tvdbId`.
- No provider id → no cross-merge; use fallback keys.
- Entry order: active downloads first, then available-only, then alphabetical.
- Type tabs stay: All / Movies / Series, with counts including downloads.

Card behaviour:

- **Movie**
  - available only → existing poster card + “Available” badge;
  - downloading only → poster + “Downloading 42%”/“Queued” badge, progress bar,
    size/ETA, client/protocol;
  - both → same card with both badges and progress.
- **Series**
  - show once; aggregate badge e.g. “2 downloading” or “Downloading 42%”;
  - show season hint when activity has one/few seasons;
  - card links to show detail:
    - Jellyfin entry → `#/library/show/jellyfin/<id>`;
    - activity-only → `#/library/show/sonarr/<seriesId>`;
    - merged → Jellyfin route (backend finds Sonarr by TVDB).
  - hover/focus affordance and a chevron indicate it opens.
- Keep existing poster fallback icons, ratings, year and runtime.

Empty/error states:

- No Jellyfin media and no active downloads → Library empty state.
- Jellyfin setup/key/unreachable notices reuse the existing `LibraryStateNotice`.
- Per-arr activity failures show a small alert with the service name and detail,
  but the rest of Library still renders.
- Loading skeleton only while neither side has data.

Add a small accessible `components/ui/progress.tsx` progress bar for cards and
episode rows.

### 8. Frontend: show detail page

`ShowPage` reads source/id from the route and queries `["show", source, id]`
with a 10s refetch while open.

Layout:

- Back link to Library.
- Poster/title/year/network header.
- Season selector using the existing `Select`.
- Episode list sorted by season/episode:
  - `S01E02`, title, air date/runtime;
  - availability badge: Available / In Sonarr / Missing / Upcoming;
  - active download badge: Queued / Downloading 42% / Importing / Warning;
  - progress bar, size/ETA, client/protocol/quality when downloading;
  - season-pack note when applicable;
  - overview line clamp;
  - if an episode is both available and re-downloading, show both chips.
- Select `defaultSeason` from the API; fall back to first season with episodes.
- Skeleton while loading.
- Source setup/error alert with Open Jellyfin/Sonarr action.
- “Download status unavailable” warning when Sonarr metadata failed but Jellyfin
  episodes loaded.

### 9. Search invalidation

After a successful request, invalidate `["search"]`, `["status"]`, and the new
`["activity"]` query so a newly requested title appears in Library immediately.
No Library change is needed until Jellyfin indexes the file.

## Files to modify

Backend:

- `server/backend/src/upstream/servarr.ts` — queue/detail/episode methods and types.
- `server/backend/src/upstream/jellyfin.ts` — provider ids, item/seasons/episodes.
- `server/backend/src/types.ts` — activity/show/library types.
- `server/backend/src/activity.ts` (new) — active filter, queue mapping,
  aggregation, progress helpers.
- `server/backend/src/shows.ts` (new) — Jellyfin/Sonarr episode union and queue
  overlay helpers.
- `server/backend/src/routes/activity.ts` (new).
- `server/backend/src/routes/shows.ts` (new).
- `server/backend/src/routes/library.ts` — provider-id mapping through shared
  mapper.
- `server/backend/src/server.ts` — register routes.
- `server/backend/test/routes.test.ts` and/or new activity/show test files.

Frontend:

- `server/frontend/src/App.tsx`
- `server/frontend/src/components/AppHeader.tsx`
- `server/frontend/src/components/ui/progress.tsx` (new)
- `server/frontend/src/hooks/use-hash-route.ts` (new)
- `server/frontend/src/pages/ServicesPage.tsx` (new)
- `server/frontend/src/pages/SearchPage.tsx` (new)
- `server/frontend/src/pages/LibraryPage.tsx` (new)
- `server/frontend/src/pages/ShowPage.tsx` (new)
- `server/frontend/src/features/library/LibrarySection.tsx` — remove/replace by
  page content; keep state notices reusable.
- `server/frontend/src/features/library/LibraryGrid.tsx` — add status/progress,
  clickable series cards.
- `server/frontend/src/features/library/library-entries.ts` (new) — merge logic.
- `server/frontend/src/features/library/ActivityCard` additions or shared card
  components.
- `server/frontend/src/api/client.ts`, `server/frontend/src/api/types.ts`
- `server/frontend/src/features/search/SearchSection.tsx` — activity invalidation.

Docs:

- `README.md`
- `server/README.md`
- `docs/src/web-ui.md`
- `docs/src/server.md`

## Reuse

- `createArrClient` GET/auth/image handling in
  `server/backend/src/upstream/servarr.ts`.
- `mediaCoverUrl()` and allowed media-cover path in
  `server/backend/src/search.ts`.
- `stateForError()` / `errorMessage()` in
  `server/backend/src/upstream/states.ts`.
- Existing `/api/search/images/:service` and `/api/library/images/:itemId`
  proxies for every poster/episode image.
- Existing Jellyfin error-state pattern in `routes/library.ts`.
- Existing `LibraryGrid`, `LibraryCard`, `LibraryStateNotice`, `StatusBadge`,
  `Tabs`, `Select`, `Card`, `Badge`, `Alert`, `Empty`, `Skeleton`.
- Existing `AppHeader` refresh and React Query invalidation patterns.
- Existing `useDebouncedValue` only for Search; no changes needed.

## Steps

- [x] Add arr queue, series/movie-by-id and episode methods/types.
- [x] Add Jellyfin provider-id and item/season/episode methods/types.
- [x] Add activity mapping helpers + unit tests for active filtering, progress,
      aggregation and season packs.
- [x] Implement `/api/activity` with per-service resilience and tests.
- [x] Implement `/api/library/shows/:source/:id` union/overlay logic with tests.
- [x] Extend `/api/library` provider ids and tests.
- [x] Add hash router and page shell; move header to tab navigation.
- [x] Split Services and Search into their pages.
- [x] Build merged Library entries, cards, progress, filters and notices.
- [x] Build Show detail page with season selector and episode download UI.
- [x] Invalidate activity after search requests.
- [x] Update docs/API tables/roadmap.
- [x] Run typecheck, backend tests, production build and browser smoke tests.

## Verification

Backend:

- `/api/activity` returns aggregated active movies/shows with progress, ETA,
  client/protocol and posters.
- Failed/imported records are excluded; importing/import-blocked remain active.
- One arr down still returns the other service’s items and a service state.
- Missing keys report `unconfigured`, not a 500.
- `/api/library` exposes TMDB/TVDB ids from Jellyfin `ProviderIds`.
- Jellyfin show + Sonarr match by TVDB returns unioned seasons/episodes.
- Sonarr-only show detail returns episodes without Jellyfin.
- Per-episode queue mapping and season-pack fan-out are covered.
- Partial Sonarr failure still returns Jellyfin episodes plus a warning.
- Existing search/request/library tests continue to pass.

Frontend/manual:

- `#/services`, `#/library`, `#/search` and both show-detail route forms render.
- Top tabs highlight the correct page; unknown hash falls back to Services.
- Library merges a duplicate by TMDB/TVDB into one card.
- Download card shows progress, state, ETA and client; queued items show 0%.
- A show card opens detail; season selector defaults to the first available
  season and switches correctly.
- Episode rows distinguish available, in-Sonarr, missing, upcoming and
  downloading, including season-pack progress.
- Refresh button updates whichever page is active; search request makes the new
  download appear in Library.
- Typecheck, tests and production build pass.
