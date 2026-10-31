# Search + media requests

## Context

The dashboard covers roadmap step 1: Jellyfin library and service health. Step 2
is the missing bridge between "I want to watch X" and the existing
Sonarr/Radarr automation: search metadata through both apps, then add a movie or
series so the existing pipeline (Prowlarr → qBittorrent → Jellyfin) starts on its
own.

This stays within the existing stateless BFF design:

- the browser only calls `/api/*`;
- Sonarr/Radarr URLs and API keys stay server-side;
- no database and no request history in v1;
- failure in one app never breaks the other.

### Confirmed decisions

- One search box queries Sonarr (series) and Radarr (movies) together.
- Debounced search-as-you-type (2+ characters, ~350 ms) with cached results.
- Request is one click using saved defaults, with a "Request options" panel to
  change quality profile, root folder, TV monitoring and search-on-add.
- Defaults: prefer the `HD - 720p/1080p` quality profile, fall back to
  `HD-1080p`, then the first available profile; monitor all seasons; start
  searching immediately.
- Results already present in Sonarr/Radarr are marked "Requested" and cannot be
  requested again. Jellyfin is not cross-referenced for this check.
- Defaults are persisted client-side in `localStorage`; no backend settings.

## Approach

### Backend API contract

All new routes live under `/api`, use the existing JSON error envelope, and keep
the same per-service resilience as `/api/status`.

#### `GET /api/requests/options`

Returns what is needed to build a valid add request:

```ts
{
  checkedAt: string;
  services: {
    sonarr: {
      id: "sonarr";
      state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
      detail?: string;
      qualityProfiles: Array<{ id: number; name: string }>;
      rootFolders: Array<{ path: string; accessible: boolean; freeSpace?: number }>;
      defaults: {
        qualityProfileId?: number;
        rootFolderPath?: string;
        monitor: "all";
        searchOnAdd: true;
      };
    };
    radarr: { /* same shape; monitor is absent */ };
  };
}
```

- Read `qualityprofile` and `rootfolder` for each app with `Promise.allSettled`.
- Only `accessible: true` root folders are used for defaults; all are returned so
  the UI can explain an inaccessible folder.
- Default profile picks `HD - 720p/1080p` by name (case-insensitive), then
  `HD-1080p`, then the first profile. This fallback is server-side so the
  frontend never has to guess.
- Missing keys are `unconfigured`; 401/403 is `unauthorized`; transport failures
  are `unreachable`. Return HTTP 200 with empty option lists so the UI can show
  per-service setup alerts.

#### `GET /api/search?q=<term>`

- Validate `q`: trimmed length 2–120, reject other shapes with 400.
- Run in parallel for both apps:
  - `GET /api/v3/series/lookup?term=<q>`
  - `GET /api/v3/series` (existing-library ids)
  - `GET /api/v3/movie/lookup?term=<q>`
  - `GET /api/v3/movie` (existing-library ids)
- If an app's lookup fails, keep the other app's results and report that app's
  state. If lookup succeeds but the existing-library list fails, still return
  results with `inLibrary` unknown and a warning detail.
- Map upstream resources to a small frontend contract:

```ts
interface SearchResult {
  key: string;                 // "movie:438631" | "series:371980"
  kind: "movie" | "series";
  service: "sonarr" | "radarr";
  title: string;
  year?: number;
  overview?: string;
  rating?: number;             // Sonarr ratings.value, Radarr imdb/tmdb value
  certification?: string;
  runtimeMinutes?: number;
  genres?: string[];
  network?: string;            // Sonarr network / Radarr studio
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  imageUrl?: string;           // backend-owned poster URL
  inLibrary: boolean | null;   // null when the library list could not be read
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>; // series only
}

interface SearchResponse {
  query: string;
  searchedAt: string;
  results: SearchResult[];
  services: Array<{
    id: "sonarr" | "radarr";
    state: "ok" | "unconfigured" | "unauthorized" | "unreachable";
    detail?: string;
    count: number;
  }>;
}
```

- Existing detection: compare `tvdbId` for series and `tmdbId` for movies with
  the library lists. Also treat upstream lookup results with a positive `id` as
  existing if the list check is unavailable.
- Sort each app's results in the app's relevance order. The merged `results`
  array interleaves by upstream rank so the "All" tab is not dominated by one
  app; frontend tabs still split Movies/Series.
- Image mapping: use the first `images[]` entry with `coverType === "poster"` and
  map its relative `url` (`/MediaCoverProxy/...`) to
  `/api/search/images/<service>?path=<encoded path>`.
- Cache-control: `no-store` on search/options responses.

#### `GET /api/search/images/:service?path=<relative-path>`

- `service` must be `sonarr` or `radarr`.
- `path` must match an allowlist for arr media covers:
  `^/MediaCoverProxy/[A-Za-z0-9]+/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$`.
  Reject anything else with 400; never proxy arbitrary URLs.
- Fetch `${service.url}${path}` with the service API key, forward the upstream
  content type, send `cache-control: public, max-age=86400`, and return 404 for
  missing images.
- Reuse the validation/streaming shape of `/api/library/images/:itemId`.

#### `POST /api/requests`

Body:

```ts
{
  kind: "movie" | "series";
  tmdbId?: number;             // required for movie
  tvdbId?: number;             // required for series
  options?: {
    qualityProfileId?: number;
    rootFolderPath?: string;
    monitor?: "all" | "firstSeason" | "future" | "none"; // series only
    searchOnAdd?: boolean;
  };
}
```

Server flow:

1. Validate the body shape and positive integer ids.
2. Resolve the target app (`movie` → Radarr, `series` → Sonarr) and require its
   API key.
3. Re-fetch canonical metadata upstream by id (`term=tmdb:<id>` /
   `term=tvdb:<id>`) and verify the returned id matches. Never trust
   client-supplied titles or metadata.
4. Fetch the app's current library list; if the id is already there, return
   `{ status: "already_exists", service, title }` with HTTP 200 (idempotent, no
   duplicate add).
5. Resolve options against live data:
   - `qualityProfileId` must exist in `/api/v3/qualityprofile`;
   - `rootFolderPath` must be present and `accessible` in `/api/v3/rootfolder`;
   - fall back to the same defaults as `/api/requests/options`.
6. Add:
   - Movie: `POST /api/v3/movie` using the lookup resource with
     `qualityProfileId`, `rootFolderPath`, `monitored: true`,
     `minimumAvailability: "released"`, and
     `addOptions: { searchForMovie: searchOnAdd }`.
   - Series: `POST /api/v3/series` using the lookup resource with
     `qualityProfileId`, `rootFolderPath`, `monitored: true`,
     `seasonFolder: true`, adjusted `seasons` monitoring, and
     `addOptions: { monitor, searchForMissingEpisodes: searchOnAdd }`.
   - Monitoring mapping: `all` monitors every season, `firstSeason` only season 1,
     `future` monitors no existing seasons, `none` monitors nothing. `future`
     uses Sonarr's `monitor: "future"`; `none` uses `"none"`.
7. Return `{ status: "added" | "already_exists", service, title, year?, id? }`.
8. Upstream 400 validation messages from Sonarr/Radarr are surfaced as a concise
   error (parsed from the arr error array when available), not the generic
   "HTTP 400". Never include API keys or upstream URLs in the response.

### Backend structure

Extend the existing shared client rather than creating parallel adapters:

```
server/backend/src/
  upstream/servarr.ts       # + lookups, library lists, profiles, root folders,
                            #   add series/movie, media-cover fetch
  routes/search.ts          # /api/search + /api/search/images/:service
  routes/requests.ts        # /api/requests/options + POST /api/requests
  types.ts                  # + search/request response types
  server.ts                 # register new routes
```

`http.ts` gets a small `postJson` helper (or a `jsonRequest` refactor) so GET/POST
share timeout and error handling. `servarr.ts` gets a non-JSON fetch helper for
poster bytes.

### Frontend

Add a Search section between the service cards and the library: status first,
then search/requests, then the Jellyfin library. It contains:

- `SearchSection` heading, search input (`Input` + search icon), settings button.
- `RequestOptionsPopover`:
  - Sonarr: quality profile select, root folder select, TV monitoring select,
    search-on-add switch.
  - Radarr: quality profile select, root folder select, search-on-add switch.
  - Disabled with explanatory text when a service is not ready.
  - Values load from `/api/requests/options`, fall back to server defaults, and
    persist in `localStorage` under `churn.requestDefaults.v1`.
- `useDebouncedValue` hook (`src/hooks/use-debounced-value.ts`) with 350 ms.
- `useQuery` for search, enabled for 2+ trimmed characters, keyed by the
  debounced query, `placeholderData: keepPreviousData` to avoid flicker.
- `SearchResultGrid` with tabs All / Movies / Series and result counts:
  - poster, title, year, type badge, rating, certification, runtime, network;
  - `Request` button, pending state per result, disabled "Requested" state when
    `inLibrary` is true;
  - a short "All seasons" / monitor summary for series.
- States:
  - initial empty state (search prompt) using `Empty`;
  - loading skeleton grid;
  - no results `Empty`;
  - per-service `Alert` strips for unconfigured/unauthorized/unreachable apps;
  - request success/duplicate/failure via `sonner` toast.
- Optimistic feedback: on a successful add, update the cached search result to
  `inLibrary: true` and invalidate the search query; invalidate status too.
- Use existing shadcn composition and semantic tokens only. Add only the missing
  primitives, likely `input`, `select`, `switch`, `label`, `popover` (or
  `dialog`) via the shadcn CLI, keeping the generated `cn` import style.

Suggested files:

```
server/frontend/src/
  hooks/use-debounced-value.ts
  features/search/SearchSection.tsx
  features/search/SearchResultGrid.tsx
  features/search/SearchResultCard.tsx
  features/search/RequestOptionsPopover.tsx
  features/search/use-request-defaults.ts
  api/client.ts               # + search, options, createRequest, postJson
  api/types.ts                # + search/request types
  App.tsx                     # render SearchSection
```

### Docs

- `server/README.md`: new API table rows, request defaults/behavior, roadmap
  step 2 marked done.
- `docs/src/web-ui.md`: search/request section, options, duplicate handling.
- `README.md`: short mention that the dashboard can search and request media.
- `docs/src/server.md`: mention requests flow to the arrs.
- No `.env.example` changes (no new settings required).

## Files to modify / create

- `server/backend/src/upstream/servarr.ts` — extend the arr client.
- `server/backend/src/http.ts` — shared JSON/POST helper and arr error parsing.
- `server/backend/src/routes/search.ts` — new.
- `server/backend/src/routes/requests.ts` — new.
- `server/backend/src/types.ts` — search/request contracts.
- `server/backend/src/server.ts` — route registration.
- `server/backend/test/routes.test.ts` — new route tests.
- `server/backend/test/servarr.test.ts` — new mapping/default tests.
- `server/frontend/src/App.tsx` — render the search section.
- `server/frontend/src/api/client.ts`, `src/api/types.ts` — new calls/types.
- `server/frontend/src/features/search/**` — new UI.
- `server/frontend/src/hooks/use-debounced-value.ts` — new.
- `server/frontend/src/components/ui/{input,select,switch,label,popover}.tsx` —
  shadcn-generated as needed.
- `server/README.md`, `docs/src/web-ui.md`, `docs/src/server.md`, `README.md`.

## Reuse

- `server/backend/src/http.ts` — `fetchJson`, `fetchWithTimeout`, normalized
  upstream errors/timeouts.
- `server/backend/src/errors.ts` — `UpstreamError`, `ApiError`, error envelope.
- `server/backend/src/upstream/servarr.ts` — existing `createArrClient`,
  `X-Api-Key` header and `/api/v3/system/status` pattern.
- `server/backend/src/routes/library.ts` — query validation, per-state responses
  and image-proxy pattern.
- `server/backend/src/routes/status.ts` — per-service state mapping and
  `Promise.all` probing.
- `server/backend/src/server.ts` — central route registration/error handling.
- `server/frontend/src/api/client.ts` — `getJson`/`ApiClientError`.
- `server/frontend/src/features/library/LibraryGrid.tsx` — poster card/grid and
  skeleton patterns; reuse the visual language rather than inventing new cards.
- `server/frontend/src/features/library/LibrarySection.tsx` — tabs, empty,
  loading and service-state notices.
- Existing shadcn primitives: `Card`, `Badge`, `Button`, `Alert`, `Empty`,
  `Skeleton`, `Tabs`, `Tooltip`, `Separator`, `sonner`.

## Steps

- [x] Extend `http.ts` with a POST/JSON request helper and safe arr error parsing.
- [x] Extend `servarr.ts` with `lookupSeries`, `lookupMovie`, `listSeries`,
  `listMovies`, `getQualityProfiles`, `getRootFolders`, `addSeries`, `addMovie`
  and `getMediaCover`.
- [x] Add search mapping/default-selection helpers with unit tests.
- [x] Implement `/api/requests/options` with per-service states and defaults.
- [x] Implement `/api/search` with parallel lookup/library calls, existing
  detection and merged results.
- [x] Implement `/api/search/images/:service` with strict path allowlisting.
- [x] Implement `POST /api/requests` with upstream re-lookup, live option
  validation, duplicate check and arr-specific payloads.
- [x] Register the new routes in `server.ts`.
- [x] Add backend route tests for success, partial failure, unconfigured keys,
  invalid query/body, duplicate, option validation and image path rejection.
- [x] Add frontend API types/client calls and debounce hook.
- [x] Add shadcn input/select/switch/label/popover primitives.
- [x] Build the search section, result grid/cards, settings popover and persisted
  defaults.
- [x] Wire request mutations, optimistic requested state and toasts into `App`.
- [x] Update README/docs and roadmap.
- [x] Run typecheck, tests, production build and manual smoke test.

## Verification

Automated:

```bash
cd server
npm run typecheck
npm test
npm run build
```

Manual against the running local stack:

```bash
cd server
npm run dev
# UI:  http://127.0.0.1:5173
# API: http://127.0.0.1:4000
```

```bash
curl -s 'http://127.0.0.1:4000/api/requests/options' | jq
curl -s 'http://127.0.0.1:4000/api/search?q=severance' | jq
curl -s 'http://127.0.0.1:4000/api/search?q=dune' | jq
```

Expected on the current machine:

- options returns Sonarr/Radarr `ok`, `HD - 720p/1080p` as the default profile,
  `/data/media/tv` and `/data/media/movies` as root folders;
- search for `severance` returns a Sonarr series with a proxied poster;
- search for `dune` returns Radarr movies with proxied posters;
- no API key or upstream URL appears in browser network responses;
- a non-existent query returns empty results, not an error;
- stopping one arr container makes only that app's search/options state
  `unreachable` while the other still returns results.

End-to-end request check (choose a title you actually want):

1. Search for a movie or show, open Request options, keep or change the defaults.
2. Click Request; the toast confirms the add and the card switches to
   "Requested".
3. Confirm the title appears in Sonarr/Radarr and a search/download starts.
4. Click Request on the same card again after a refresh; the button stays
   disabled and the API returns `already_exists` if called directly.
5. Confirm the title eventually appears in the Jellyfin library and dashboard
   after the next Jellyfin scan.

## Risks / notes

- **Quality-profile defaults are name-based.** `HD - 720p/1080p` and `HD-1080p`
  are fallbacks; if neither exists the first profile is used. The user can
  always override in the options panel.
- **Existing detection is metadata-id based.** Sonarr `tvdbId` / Radarr `tmdbId`
  matching is reliable; Jellyfin-only titles are intentionally not considered
  "requested".
- **Searches hit both apps while typing.** Debounce and TanStack Query caching
  limit traffic; results may be slightly stale after adding a title, so the
  search cache is invalidated on success.
- **Requests are immediate.** The one-click path starts a real download search
  as soon as it is pressed; the customize panel is the guard for users who want
  to change quality or monitoring first.
- **No request history.** This plan does not add a queue/activity view; that is
  roadmap step 3.
