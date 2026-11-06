# Title header + version picker — implementation plan

Spec: the title-page redesign brief in the task message. Reference mock:
`~/Pictures/Screenshots/Screenshot From 2026-11-05 15-21-30.png`.

**Frontend only.** No backend route changes; the fields the backend cannot answer
today are left out of the UI rather than faked (see "Backend gaps"). Presentation
is a rewrite: every release-search behaviour stays — Prowlarr-first parallel
search, streaming results, the snapshot cache, "Search again", direct-to-qBittorrent
grabs and the `churn-direct` tag.

**shadcn only.** No hex/px values in components. The spec's palette maps onto the
existing dark theme (`bg-background`, `bg-card`, `bg-secondary`, `bg-muted`,
`text-muted-foreground`, `bg-primary`/`text-primary-foreground`, `border-border`,
`border-input`) and sizes onto Tailwind's scale + shadcn component sizes — the
same convention the library redesign used. **Theme rounding stays square**
(`--radius: 0rem`; user decision) so the page renders as a squared-off version of
the mock.

## Decisions (confirmed with the user)

1. **No radius change.** Keep `--radius: 0rem`; use the same shadcn radius
   classes (`rounded-lg`, `rounded-xl`) without touching `index.css`.
2. **Real data only, no mock module.** Content rating is omitted (the spec allows
   leaving fields out). Movie resume comes from the real playback endpoint.
   Show-level resume/watched state does not exist yet → shows always show
   `Play S1 · E1`. **Attribution must work for shows too**, taken from the
   existing library/requested lists.
3. **Show page = header swap only.** The season selector, episode list and old
   `ReleaseChooser` keep working exactly as today, untouched visually.
4. **No friendly release label.** The best-match panel shows the *full release
   name*, truncated with an ellipsis (`title` attribute for the whole string), on
   the line where the mock has `Blu-ray · Remastered`. The separate monospace raw
   line is dropped. Alternative rows likewise show one truncated release name.
   → `plans` spec's release-label builder, `scope`-aware label prefixes and their
   unit test are dropped; so is the "scope prefix" extension point.

## Context

`server/frontend` is React 19 + Vite + Tailwind v4 + shadcn (radix-nova style)
behind the Fastify BFF. Both detail pages have bespoke headers
(`MovieHeader`, `ShowHeader`): poster, source badge, metadata chips, a plain play
link. The movie page mounts the old `ReleaseChooser` card (quality tabs, one
release visible, indexer chips, a floating "Cancel request" link, a separate
"Downloading now" card with live stats).

The redesign consolidates that into two shared components and wires them into the
movie page (both) and the show page (header only).

## Findings that shape the plan

**Pages**
- `src/pages/MoviePage.tsx` already classifies the four states: downloading
  (live `fetchMovieDownload`, 500 ms poll while active), playable (`jellyfinId`),
  arr-request-only (`radarrId` → picker), unmatched (alert). `awaitingDownload`
  covers the gap between a grab and qBittorrent reporting the torrent.
- `src/pages/ShowPage.tsx` exposes `series`, `seasons`, `episodes` (with
  `availability` + `jellyfinId`) and `sonarrId`; it owns the season select,
  episode rows and the season `ReleaseChooser`.

**Release search (keep as-is, extract hooks)**
- `src/features/releases/ReleaseChooser.tsx` holds the query
  (`["movie-releases", movieId]` / `["season-releases", seriesId, season,
  episodeNumber ?? null]`, `staleTime: 30_000`, 1 s polling while
  `state === "searching" || refreshing`), the refresh mutation (starts the
  Prowlarr-first parallel search and seeds the cache with the returned snapshot)
  and the grab mutations (`grabMovieRelease`, `grabShowRelease`, which invalidates
  `activity`, `show`, `movie`, `requested-library`, the release key and calls
  `onGrabbed`).
- `CachedReleasesResponse` carries everything the new footer needs: `state`
  (`ready|searching|error`), `refreshing`, `fetchedAt`, `releaseCount`,
  `groups[]` (already sorted 480p→2160p with `Other` last; releases sorted by
  seeders desc then size asc) and `progress` (`finished`, `total`,
  `indexers[] { name, state, count, detail }`) — `progress` is present in every
  state, so "Searched 8 of 8 sources · 20 hours ago" and the per-indexer popover
  are real data. `detail` is filled for `state === "error"` (typically "all
  indexers failed") and per indexer for failures (e.g. a 451 block message).
  `ShowRelease` has `title`, `indexer`, `sizeBytes`, `seeders`, `ageHours`,
  `quality`, `tier`, `canGrab`, `rejected` reasons.
- Tier numbers: `0 = 480p`, `1 = 720p`, `2 = 1080p`, `3 = 2160p`, `99 = Other`.
  Current default order is `[2, 1, 0, 3]`; this spec changes it to
  `1080p → 720p → 2160p → 480p → Other`.

**Playback / resume**
- `fetchPlayback(itemId, quality)` → `PlaybackItem { positionTicks,
  runtimeTicks, played, … }`; `PlayPage` already resumes from it and keys the
  query as `["playback", id, readPlaybackQuality()]`. The header reuses that key
  so visiting the page warms the player's cache.
- Shows have no per-episode user data (`ShowEpisode` has no played/position —
  bean `churn-icdh`), so no show resume/rewatch state.

**Attribution** (needed for shows per decision 2)
- `addedBy` (`{id, name}`) is on `LibraryItem` (`/api/library`) and
  `RequestedLibraryItem` (`/api/library/requested`) — both already fetched by
  `LibraryPage` with query keys `["library"]` and `["requested-library"]`.
  Matching on those keys reuses the cache. Both payloads carry
  `tmdbId`/`tvdbId`/`name`/`year`; `MovieDetailResponse` exposes
  `movie.tmdbId`, and `ShowSeriesSummary` exposes `tvdbId`/`tmdbId`.
- `normalizeTitle()` already exists (private) in
  `src/features/library/library-entries.ts` for fuzzy title matching.

**Actions / endpoints (all existing, unchanged)**
- "Delete from library": `cancelJellyfinLibraryItem(itemId)` —
  `DELETE /api/library/jellyfin/:itemId` removes the Jellyfin item, and the
  backend finds the matching Sonarr/Radarr title and removes its files,
  queue entries and attribution. For a Sonarr-only show there is no Jellyfin
  item, so the same menu item calls `cancelLibraryItem("sonarr", sonarrId)`.
- "Cancel request": `cancelLibraryItem(service, arrId)` (existing
  `CancelRequestDialog`).
- "Cancel download": `cancelMovieDownload(source, id)` (existing
  `CancelMovieDownloadDialog`).
- Grabs: `grabMovieRelease(movieId, { releaseId })` — untouched.

**UI kit available now** (no new dependencies needed): `button`, `card`,
`dialog`, `dropdown-menu`, `popover`, `progress` (radix, `h-1`, `bg-muted`
track, `bg-primary` indicator), `skeleton`, `toggle`, `toggle-group`, `tabs`,
`badge`, `alert`, `empty`, `input-group`, `tooltip`, `separator`. `Button`
variants: `default` (primary), `outline`, `secondary`, `ghost`, `destructive`,
`link`; sizes include `sm` (`h-7`), `default` (`h-8`), `lg` (`h-9`), `icon`.

**Tests**: vitest, source-adjacent `*.test.ts`. Only `use-hash-route.test.ts`
exists today; no DOM/component test tooling is installed, so new tests target
pure helpers.

**Stack is live**: API `:4000`, Vite `:5173`, Jellyfin `:8096`, Prowlarr `:9696`.

## Backend gaps (deliberately omitted, not mocked)

| Wanted | Status | Plan |
|---|---|---|
| Content rating (movie/show) | not exposed on the detail routes (`LibraryItem.officialRating` is, but detail is not) | omit the field entirely |
| `addedBy` on detail routes | only on the library/requested lists | match client-side against those lists (works for movies *and* shows) |
| Show resume / "everything watched" / next-unwatched | no user-data per episode (bean `churn-icdh`) | play the first playable episode; no resume label |
| Movie resume | **available** via `fetchPlayback` | use it |
| Download ETA | available (`timeLeft`/`estimatedCompletionTime`) | "about 20 min" pill |
| Release source/flags (Blu-ray, HDR, …) | arr parser only returns tier/quality | full release name instead of a label |

## Approach

### 1. Shared formatting helpers (`src/lib/format.ts`)

- `formatRuntime(minutes)` — move the duplicated copy out of `MoviePage` and
  `ShowPage` (`1h 32m`).
- `formatRelativeAge(iso)` — `just now` / `12 minutes ago` / `20 hours ago` /
  `3 days ago`, for the picker footer (move `ReleaseChooser`'s private
  `formatAge`).
- `formatEtaAbout(value)` — qBittorrent/Sonarr `timeLeft` (`1h 32m`, `20m`,
  `45s`) → `about 1 hr 30 min` / `about 20 min` / `a few seconds`; returns
  `undefined` when unparseable. Shares wording with
  `DownloadStats.downloadEta` rather than replacing it.

### 2. TitleHeader (`src/features/title/`)

**`TitleHeader.tsx`** — one presentational component, driven by a props object
(pages do the data mapping):

```
poster: { imageUrl?, alt }
title, backHref + backLabel ("Library")
metadata: string[]            // already-formatted, joined with a gap, no dots
synopsis?: string             // clamped, "More" toggle
dimmed: boolean               // nothing playable → opacity-70 on the poster
action: ReactNode             // primary action, rendered by the page
menu?: ReactNode              // the ⋯ dropdown (or a slot)
attribution?: ReactNode       // "Added by …" / "Requested by …"
```

Layout: `flex flex-wrap items-end gap-x-10 gap-y-6` — poster `w-55` (220 px,
`aspect-[2/3]`, `sm:` only; `w-35` = 140 px below `sm`), content column
`flex-[999_1_480px] min-w-0 flex-col gap-4.5`, action row
`flex flex-wrap items-center gap-3`. Title is
`font-heading text-[2rem] leading-[1.05] tracking-[-0.02em] sm:text-5xl`
(Tailwind scale, not raw px). Metadata row: `flex flex-wrap gap-x-3.5 text-sm
text-muted-foreground`. Synopsis: `text-sm leading-relaxed text-muted-foreground
max-w-[62ch]` — `text-pretty`, `line-clamp-4` when collapsed.

**`Synopsis.tsx`** (small, in the same folder) — renders `line-clamp-4` and only
shows a "More"/"Less" `Button variant="link"` when the text actually overflows
(measure `scrollHeight` vs `clientHeight` with a `ResizeObserver` on the clamped
element). `aria-expanded` on the toggle.

**Primary actions** — a `TitlePrimaryAction` helper renders one of:

- accent (`Button` default / `primary`) with `PlayIcon`: `Resume` +
  `<span className="opacity-75">9 min left</span>` for movies with a real resume
  position; `Play` otherwise.
- shows: `Play S1 · E1` using the first playable, non-special episode
  (`episodes` sorted by season/episode, `availability === "jellyfin"`).
- not downloaded: a non-interactive `span` pill — 8 px `rounded-full bg-primary`
  dot + `Not downloaded yet`, `border border-primary/45`, transparent bg, `h-12`
  to match the 48 px height of the primary button.
- downloading: non-interactive pill `Downloading · about 20 min` with
  `DownloadStats`-style ETA and a 6 px `Progress` (`h-1.5 bg-muted`, primary
  indicator) underneath. Without a usable ETA → `Downloading`.

All primary buttons are `h-12` (`Button` with `className="h-12 px-5"`); the ⋯
button is `Button variant="outline" size="icon-lg"` (36 px visual box, `size-12`
override) with `aria-label="More actions"`. Sizes are expressed with Tailwind's
spacing scale (`h-12`, `size-12`, `h-10`), not arbitrary px where a scale value
matches.

**`TitleMenu.tsx`** — `DropdownMenu` + `DropdownMenuItem`s rendered from a small
`items` prop so the same component serves movie and show:

| State | Items |
|---|---|
| Playable movie | "Download a different version" (toggles the inline picker), "Delete from library" |
| Not-downloaded movie | "Cancel request" |
| Downloading movie | "Cancel download", "Cancel request" |
| Show | "Delete from library" |

`Delete from library` opens a new **`DeleteTitleDialog.tsx`** (mirrors
`CancelRequestDialog`: `Dialog` naming the title, `destructive` confirm,
`toast.success`, invalidates `library`/`movie`/`show`/`requested-library`/
`activity`, then `window.location.hash = "#/library"`). It picks
`cancelJellyfinLibraryItem(jellyfinId)` when a Jellyfin id exists and
`cancelLibraryItem("sonarr", sonarrId)` for a Sonarr-only show. Existing
`CancelRequestDialog`/`CancelMovieDownloadDialog` are reused unchanged, so
"Cancel request" stops being a floating link and moves into the menu.

**`attribution.ts`** (+ hook `useTitleAttribution`) — given
`{ kind, tmdbId?, tvdbId?, title, year, playable }`, find the `addedBy` name:
provider id match first (tmdb for movies, tvdb→tmdb for series), then
normalised title + year (±1 for series). Prefer the `/api/library` item for a
playable title, the `/api/library/requested` item for a request; fall back to
the other. Reuses `mergeLibraryEntries`/`normalizeTitle` (export
`normalizeTitle` from `library-entries.ts`). Queries reuse the
`["library"]`/`["requested-library"]` keys with `staleTime: 60_000` and
`refetchInterval: false` so a detail page never adds polling.

**`use-title-playback.ts`** — `useQuery(["playback", jellyfinId,
readPlaybackQuality()])`, enabled only with a Jellyfin id, `retry: false`,
`staleTime: 30_000`. Derives `{ resumable, positionSeconds, remainingMinutes }`
(mirrors `PlayPage`'s rule: not played and not within 30 s of the end). Remaining
minutes round up; `< 1 min` renders `less than a minute left`.

### 3. VersionPicker (`src/features/releases/`)

**`use-release-search.ts`** — extracted verbatim from `ReleaseChooser`:

```
useReleaseSearch(target: {kind:"movie", movieId} | {kind:"season", seriesId, seasonNumber, episodeNumber?})
  → { query, data, groups, progress, refresh(), refreshing, grab, grabbingId, grabError }
```

Same query keys, `staleTime`, polling interval, invalidation list and
`onGrabbed` behaviour. `ReleaseChooser` is refactored to consume it (no visual
change) so the search logic lives in one place; the season path keeps working
for `ShowPage`.

**`VersionPicker.tsx`** props (extension points as specified):

```
title?: ReactNode          // default "Pick a version"
subtitle?: ReactNode       // default the movie copy
primaryLabel?: string      // default "Download" (seasons: "Download season")
footerExtra?: ReactNode    // slot after the alternatives toggle
onClose?: () => void       // renders the "Close" text button in the heading row
onGrabbed?: () => void
scope: "movie" | "season"  // selects the search target + grab call
movieId?: number
seriesId?: number; seasonNumber?: number; episodeNumber?: number
```

Search states:

| State | Render |
|---|---|
| `searching` & no results | heading row + skeleton best-match panel (`Skeleton` blocks on `bg-card`, no shimmer) + footer `Searching… {done} of {total} sources` with a thin `Progress`; quality tiers hidden |
| `searching` & results | full UI, live-updating; a tier the user picked stays picked (`tierPinned`) |
| `ready` | full UI + `Searched {done} of {total} sources · {relative age}` |
| snapshot (`fetchedAt` set, not refreshing) | same as ready, relative age from the snapshot |
| no results (`state === "ready"`, zero groups) | `No versions found.` + `Sources sometimes miss older or less common titles. Try again later.`; no tiers/panel; "Search again" stays |
| all sources failed (`state === "error"`, zero groups) | `Couldn't reach any sources.` + `Check that the torrent stack and VPN are running.`; per-indexer detail in the footer popover |

Card shell: `Card` (`rounded-xl bg-card`) with `p-6` and `gap-5.5` stack, `h2`
`font-heading text-xl font-semibold`, subtitle `text-sm text-muted-foreground`.
Heading row is `flex flex-wrap items-start justify-between gap-3`; right side is
the optional "Close" `Button variant="link"` plus the **Search again** button
(`variant="outline"`, `RefreshCwIcon`, `disabled` + `Searching…` while running).

**Quality selector** — `ToggleGroup type="single"` (gives real buttons with
`aria-pressed`, the accessible equivalent of the spec's `aria-pressed`), item
`h-14 min-w-30 rounded-lg border px-4 text-left` with a two-line label (name
`text-sm font-medium`, hint `text-xs text-muted-foreground`). Selected item:
`bg-secondary border-primary`; unselected: `border-secondary bg-transparent`.
Tier metadata lives in **`release-tiers.ts`**:
`{ tier, name, hint }` for 480p/720p/1080p/2160p/Other, plus
`defaultTier(groups)` (`2 → 1 → 3 → 0 → 99`, then first group) and
`TIER_ORDER`. Groups with zero results are already absent from `groups`.

**Best-match panel** (`bg-muted`/`bg-secondary` panel, `border border-primary/45`,
`rounded-lg`, `p-4.5`, wrap row): left column (`flex-[999_1_360px]`, `gap-2`):

1. `BEST MATCH` — `text-xs font-semibold tracking-[0.02em] text-primary`.
2. **Full release name** — `text-base font-medium`, single line `truncate`,
   `title` = full name (decision 4).
3. Metadata row `flex flex-wrap gap-x-4.5 text-sm`:
   `formatBytes(sizeBytes)` · availability dot+label · `indexer · {age}` in
   `text-muted-foreground` (age via `formatAgeHours`, keep the existing helper).

Right: accent **Download** button (`h-12`, `DownloadIcon`, `primaryLabel`).

**Alternatives** — collapsed by default (`aria-expanded`, `aria-controls`), lists
the selected tier's remaining results in backend ranking order: first 20, then a
`Show all {N}` text button (local state) that reveals the rest. Row: `py-3.5`
`border-t border-border`, wrapping flex — release name (truncated, `flex-[999_1_320px]`),
size (`w-18`), availability (`w-57.5` → `sm:w-[230px]`… expressed as
`w-0 sm:w-56` to stay on the Tailwind scale), secondary Download button `h-10`.

**Footer** — `flex flex-wrap items-center justify-between gap-3`.
Left: `Button variant="link" className="underline"` toggling alternatives
(`Show {n} more versions` / `Show fewer`, singular "version"), or the muted
non-interactive `No other versions at this quality`; `footerExtra` renders next
to it. Right: the status text as a `Popover` trigger (`Button variant="link"
className="text-muted-foreground text-xs"`), popover listing each indexer with
`count` (`finished`), `failed` (`error`), or `blocked (451)` when
`detail` contains 451, plus a `pending/searching` spinner row. The
`aria-live="polite"` status line lives here and only changes when
`progress.finished` changes.

**Download action** — `grabMutation` from the hook; local `pendingReleaseId`
drives the per-button "Starting…" + `Loader2Icon` spinner while every other
Download button is disabled; `grabError` renders inline under the best-match
panel or under the clicked alternative row
(`Couldn't start that download. Try another version.`), cleared on retry. The
success path keeps the existing toast and calls `onGrabbed` (page then polls
`fetchMovieDownload` and switches state). No toast on error (spec wants inline).

**`availability.ts`** — `AVAILABILITY_EXCELLENT_SEEDERS = 200`,
`AVAILABILITY_GOOD_SEEDERS = 50`, and
`releaseAvailability(seeders): { label, dotClass, textClass }`:
`Excellent · {n} seeders` (`bg-emerald-300`/`text-foreground`-ish token), `Good ·
{n} seeders`, `Low · {n} seeders · may stall` (`text-destructive`). Colours come
from theme utilities (`bg-primary`, `bg-muted-foreground`,
`text-destructive`/`bg-destructive`), never hex; dot is a `size-2 rounded-full`
span. Undefined seeders → `Unknown · seeders unknown` (muted, grey dot).

### 4. Movie page (`src/pages/MoviePage.tsx`)

Rewrite the composition (keep both queries, `awaitingDownload`, `cancelReady`,
refetch intervals and invalidations):

```
<MovieHeader/>  →  <TitleHeader … />  (+ 40px gap)  <VersionPicker … />  (conditional)
alerts: service-unavailable states only (drop the "Release search is limited" one)
```

State table:

| State | Header | Picker | ⋯ menu |
|---|---|---|---|
| playable, resumable | `Resume` + `{n} min left` | hidden unless `pickerOpen` | different version / delete |
| playable, not started | `Play` | hidden unless `pickerOpen` | different version / delete |
| not downloaded (radarr) | `Not downloaded yet` pill, poster dimmed | visible | cancel request |
| no radarr entry | `Not downloaded yet` pill + existing "No release options available" alert | hidden | — |
| downloading or awaiting | `Downloading · about 20 min` pill + 6px bar | hidden | cancel download + cancel request |

`pickerOpen` (state) drives "Download a different version"; in that mode
VersionPicker gets `onClose={() => setPickerOpen(false)}`. After a successful
grab: `awaitingDownload` true, picker closed, header switches to the downloading
pill. `CancelMovieDownloadDialog`, `CancelRequestDialog`, `DeleteTitleDialog` are
mounted at the page root; `cancelReady` (1 s guard after a grab) is preserved to
keep the double-click protection.

Attribution: `Added by {name}` when playable, `Requested by {name}` when it is a
request, omitted when unmatched. Movie resume: `useTitlePlayback(jellyfinId)`.
Metadata: year, studio (`movie.network`), `formatRuntime(runtimeMinutes)`,
`{rating} / 10` — certification omitted.

`MoviePageSkeleton` is restyled to the new header shape (220 px poster block +
title/metadata/synopsis/action rows).

### 5. Show page (`src/pages/ShowPage.tsx`)

Replace `ShowHeader` with `TitleHeader`; keep the season selector, episode list,
dialogs and the existing `ReleaseChooser` sections byte-for-byte otherwise.

- Metadata: year, `series.network`, `{seasons.length} seasons` (excluding
  specials; singular "season"), `{rating} / 10`.
- Poster dimmed when no episode has `availability === "jellyfin"`.
- Primary action: first playable non-special episode → `Play S1 · E1`, linking to
  `playHash(episode.jellyfinId, { source, id, season })`; show with no playable
  episode → `Not downloaded yet` pill (no picker below it in this task).
- Attribution: `Added by {name}` when playable, `Requested by {name}` when
  nothing is playable yet — matched from the library/requested lists via
  `tvdbId`/`tmdbId` so shows get attribution too.
- Menu: `Delete from library` (Jellyfin id when `source === "jellyfin"`, else
  Sonarr request removal).
- No resume label for shows.
- The "Back to Library" link moves into `TitleHeader`.

### 6. Responsiveness & a11y

- `<640px`: poster 140 px, content column wraps under it, title `text-[2rem]`,
  action row wraps, best-match Download goes full width
  (`w-full sm:w-auto`), alternative rows stack (`flex-col sm:flex-row`), size and
  availability columns drop their fixed widths below `sm`.
- No horizontal page scroll: release names are `truncate`/`min-w-0` everywhere;
  the picker card uses `min-w-0`.
- Real `<button>`/`<a>`; `aria-label="More actions"` on the ⋯ button;
  `ToggleGroup` gives `aria-pressed` on tiers; the alternatives toggle carries
  `aria-expanded` + `aria-controls`; the footer status is inside
  `aria-live="polite"`; popover/dialog focus handling comes from radix.

## Files

**New**
- `src/features/title/TitleHeader.tsx`
- `src/features/title/TitleMenu.tsx`
- `src/features/title/TitlePrimaryAction.tsx`
- `src/features/title/DeleteTitleDialog.tsx`
- `src/features/title/Synopsis.tsx`
- `src/features/title/attribution.ts`
- `src/features/title/use-title-attribution.ts`
- `src/features/title/use-title-playback.ts`
- `src/features/releases/VersionPicker.tsx`
- `src/features/releases/use-release-search.ts`
- `src/features/releases/release-tiers.ts`
- `src/features/releases/availability.ts`
- `src/features/releases/availability.test.ts`
- `src/features/releases/release-tiers.test.ts`

**Modified**
- `src/pages/MoviePage.tsx` (rewrite)
- `src/pages/ShowPage.tsx` (header swap only)
- `src/features/releases/ReleaseChooser.tsx` (consume the shared hook; no visual change)
- `src/lib/format.ts` (`formatRuntime`, `formatRelativeAge`, `formatEtaAbout`)
- `src/features/library/library-entries.ts` (export `normalizeTitle`)
- `src/features/download/DownloadStats.tsx` (reuse the shared ETA helper)

**Not touched**: `src/index.css` (square theme stays), backend, library/search
pages, `ReleasePickerDialog`, `Cancel*Dialog`.

## Reuse

| Need | Existing code |
|---|---|
| search/refresh/grab behaviour | `features/releases/ReleaseChooser.tsx` (extracted) |
| release bytes/age formatting | `formatBytes` (`lib/format.ts`), `formatAgeHours` (ReleaseChooser) |
| download ETA | `DownloadStats.downloadEta`, `formatEta` |
| resume position | `fetchPlayback` + `readPlaybackQuality` (same query key as `PlayPage`) |
| attribution | `mergeLibraryEntries`, `normalizeTitle`, `["library"]`/`["requested-library"]` queries |
| delete/cancel flows | `cancelJellyfinLibraryItem`, `cancelLibraryItem`, `cancelMovieDownload`, `CancelRequestDialog`, `CancelMovieDownloadDialog` |
| UI kit | shadcn `Card`, `Button`, `ToggleGroup`, `Toggle`, `DropdownMenu`, `Popover`, `Dialog`, `Progress`, `Skeleton`, `Alert`, `Empty` |
| playback links | `playHash`, `showHash` (`hooks/use-hash-route.ts`) |

## Steps

- [x] Create the bean (`beans create "Title header and version picker" -t feature -s in-progress`) with this plan's checklist, then implement.
- [x] `lib/format.ts`: `formatRuntime`, `formatRelativeAge`, `formatEtaAbout` (+ reuse in `DownloadStats`/pages).
- [x] `release-tiers.ts` + `availability.ts` with unit tests (thresholds at 49/50/199/200, default tier order with 1080 absent, `Other`-only, empty).
- [x] `use-release-search.ts` extracted; `ReleaseChooser` switched to it; verify the show page picker is unchanged.
- [x] `VersionPicker` — structure, tiers, best match, alternatives, footer popover, download states, all six search states.
- [x] `TitleHeader` + `Synopsis` + `TitlePrimaryAction` + `TitleMenu` + `DeleteTitleDialog`.
- [x] Attribution helper/hook (movies and shows).
- [x] Movie page rewrite (state table, `pickerOpen`, downloading pill, menu wiring, dialogs).
- [x] Show page header swap (first playable episode link, attribution, delete).
- [x] `npm run typecheck` / `npm test` / `npm run build`.
- [ ] Visual verification (below).

## Verification

- `cd server && npm run typecheck && npm test && npm run build` (frontend
  typecheck+vitest; `ReleaseChooser` refactor must not change show behaviour).
- Live stack: sign in via `agent_browser` at `http://localhost:5173`, then check
  each state at `1440x900` and `390x844`:
  - playable movie with resume (`Resume` + `n min left`),
  - playable movie not started (`Play`),
  - not-downloaded movie (`Not downloaded yet` + picker, tier default 1080p,
    best match, alternatives expand, footer popover),
  - downloading movie (pill + 6px bar, picker hidden),
  - search states: initial skeleton (refresh a movie with an empty snapshot),
    streaming (`Searching… n of m`), finished/cached
    (`Searched n of n sources · …`), no results, all sources failed (footer
    popover shows `failed`/`blocked (451)`).
- Grab from the best match → header flips to downloading, picker unmounts,
  library "On the way" card loses "Needs a pick"; grab from an alternative →
  same, plus the inline error path can be forced by grabbing a release with
  `canGrab === false` (Download stays disabled, so use a stopped qBittorrent or
  intercept the request to see the inline message).
- Show page: `Play S1 · E1` opens the first playable episode, `Added by`/
  `Requested by` line renders, `Delete from library` confirms and returns to
  `#/library`, existing season chooser still opens and grabs.

## Spec deviations (agreed)

1. No rounding — the app stays square (`--radius: 0rem`).
2. No friendly release labels → full release name truncated; release-label
   builder, its tests and the `scope`-aware label prefix are dropped from the
   extension points.
3. Content rating omitted (no backend field).
4. No show resume / "everything watched" state → always "first playable
   episode" (backend follow-up: bean `churn-icdh`).
5. The old movie "Downloading now" card (speed/seeders/size stats) is replaced by
   the spec's pill; live stats stay on the library "On the way" cards.
6. Default tier order changes to spec (`1080p → 720p → 2160p → 480p → Other`);
   the earlier `churn-27z7` order put 480p before 4K.

## Out of scope / follow-up beans

- Season tabs, episode list redesign, season-level `VersionPicker` (the props are
  ready for it: `title`, `subtitle`, `primaryLabel`, `footerExtra`, `scope`).
- Backend: content rating on detail routes, `addedBy` on detail routes, per-episode
  watch state, parsed release source/flags.
- Library page and Find something new.
