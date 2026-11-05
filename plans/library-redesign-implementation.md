# Library page redesign — implementation plan

Spec: `plans/library-redesign.md` (authoritative for layout/copy). Reference mock:
`~/Pictures/Screenshots/Screenshot From 2026-11-05 14-23-35.png`.

Constraint from the user: use shadcn idioms — the spec's raw hex/px values become
theme tokens in `src/index.css`; components use semantic classes
(`bg-background`, `bg-card`, `text-muted-foreground`, `bg-primary`, …), never hex
literals.

## Context

`server/frontend` is a React 19 + Vite + Tailwind v4 + shadcn (radix-nova style,
`base: radix`) SPA behind a Fastify BFF. The current Library page is a single
merged grid of Jellyfin titles, arr requests and qBittorrent downloads, with
admin-ish affordances (trash button, "Available" badge, metadata chips) on every
card, a narrow 1280px column, a header with tagline/timestamp/Admin badge/Refresh,
and a "Search" nav item.

The redesign reorders the page (resume → incoming → library), removes
non-default status and destructive affordances from browse, fills the viewport,
and restyles the global header/nav. Only the header and shared tokens change
outside the Library page.

## Findings that shape the plan

- App is dark-only already: `ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}`
  (`src/main.tsx`). Safe to make the dark palette the single palette.
- The shadcn theme currently uses `--radius: 0rem` (square) and `--primary` =
  amber-ish `oklch(0.9247 0.0524 66.1732)`; fonts are Geist
  (`@fontsource-variable/geist`, `--font-heading: var(--font-sans)`).
- `Progress` (`src/components/ui/progress.tsx`) is a local component (not the
  shadcn registry one): track `bg-muted`, indicator `bg-primary`, fixed `h-1.5`.
  Reusable for the "On the way" 6px bar; needs an indicator-class hook for the
  4px flush bar with `rgba(255,255,255,.18)` track.
- Existing data plumbing: `useQuery(["library"|"requested-library"|"activity"])`
  in `src/pages/LibraryPage.tsx`; `mergeLibraryEntries()` +
  `searchLibraryEntries()` + `useLibraryScanState()` already exist and are reused.
- Jellyfin 10.11.11 (pinned in `server/docker-compose.yml`) answers
  `GET /UserItems/Resume?userId=…&Limit=…&MediaTypes=Video` (verified live, 200;
  `/Users/{id}/Items/Resume` also works but is the legacy form). The response
  carries `UserData.PlaybackPositionTicks`, `UserData.PlayedPercentage`,
  `RunTimeTicks`, `SeriesId`, `SeriesName`, `ParentIndexNumber`, `IndexNumber`,
  `ImageTags.Primary`, `BackdropImageTags`, `SeriesPrimaryImageTag`.
  **No resume route exists in the backend today** — this is the only new API.
- Library listing currently requests `Fields=ProductionYear,RunTimeTicks,
  CommunityRating,OfficialRating,Genres,Overview,ProviderIds`. Verified live:
  adding `DateCreated` returns it. It is needed anyway for the spec's default
  sort (most recently added first).
- Playback already resumes: `PlayPage` applies `item.positionTicks` when the item
  is unplayed and not near the end, and the player route already returns it. The
  Continue-watching card only needs to link to `#/play/{itemId}`.
- Routing is hash-based (`src/hooks/use-hash-route.ts`), pages: `library`,
  `search`, `services`, `people`, `show`, `movie`, `play`.
- Backend has one logout (`POST /api/auth/logout`) and two sign-in modes
  (admin password / household profile). There is **no distinct "switch" vs
  "sign out" backend behaviour** — see open questions.
- `CancelDownloadDialog` (trash) is only used by the library grid today; the
  detail pages (`ShowPage`, `MoviePage`) keep their own delete flows, so removing
  the grid's trash button does not orphan the dialog file (it is imported by the
  grid only, so it will become unused unless the detail pages use it — verify
  and, if unused, either delete it or keep it for the On-the-way cards; default:
  keep delete on detail pages only and remove the import).
- Backend tests use `vitest` + `buildServer()` + `app.inject()` (`test/auth.test.ts`),
  frontend tests use `vitest` (only `use-hash-route.test.ts` today).

## Approach

### 1. Tokens (`src/index.css`) — the only place the spec's values appear

Map the spec palette onto shadcn semantic variables (hex kept verbatim in CSS
custom properties, both `:root` and `.dark` so the app is dark-only):

| shadcn var | token | value |
| --- | --- | --- |
| `--background` | bg | `#0E0E10` |
| `--foreground` | text | `#EDEAE4` |
| `--card`, `--popover` | surface | `#17171A` |
| `--secondary` | surface-raised | `#2E2E34` |
| `--muted` | track | `#2A2A30` |
| `--muted-foreground` | text-muted | `#A29E97` |
| `--border` | border | `#1E1E22` |
| `--primary` | accent | `#F2B544` |
| `--primary-foreground` | on-accent | `#141210` |
| `--accent` / `--accent-foreground` | hover surface | `#2E2E34` / `#EDEAE4` |
| `--input` | control border | `#2E2E34` |
| `--ring` | focus | `#F2B544` |

New non-color tokens added to `@theme inline` (so components never inline raw
values):

- `--radius-lg: 0.625rem` (10px posters/controls), `--radius-xl: 0.75rem`
  (12px "On the way" card), `--radius-sm: 0.375rem` (6px badges/thumbnails) via
  `--radius: 0.625rem` + explicit `radius-xl` override.
- `--container-content: 87.5rem` (1400px) → `max-w-content`.
- `--scrim: rgb(14 14 16 / 0.72)` → play button background (`bg-scrim`).
- `--overlay-track: rgb(255 255 255 / 0.18)` → progress track over stills.
- Typography scale: `--text-base: 0.9375rem` (15px), `--text-xs: 0.8125rem`
  (13px); `text-sm` stays 14px. `--font-sans: "Inter Variable"`,
  `--font-heading: "Space Grotesk Variable"`.
- Fonts self-hosted with `@fontsource-variable/inter` and
  `@fontsource-variable/space-grotesk` (same approach as the current Geist
  import; drop the Geist import). *(pending user choice)*

### 2. Shell (`src/App.tsx`, `src/components/AppHeader.tsx`)

- Header becomes a full-bleed 68px bar with `border-b` and an inner
  `max-w-content` container; content sections move into `<main>` inside the same
  container with `40px` horizontal padding (`16px` below `sm`).
- `AppHeader` rewrite: lowercase `churn` wordmark (`font-heading text-2xl`), nav
  **Library** / **Find something new** (`#/search`, label only), active item
  `text-foreground` + 2px `border-b` in accent, inactive `text-muted-foreground`.
- Right: account `DropdownMenu` trigger = avatar initial + display name +
  chevron. Menu: **Switch person** (the app's only sign-out path; lands on the
  profile picker) for everyone, plus admin-only **Services** and **People**.
- Delete the tagline, "Last checked", "Signed in as", Admin badge and Refresh
  button (removes `checkedAt`/`refreshing`/`onRefresh` props and
  `Dashboard.refresh()`; data freshness comes from the existing react-query
  intervals + `refetchOnWindowFocus`).
- `Services` leaves the primary nav; `#/services` route still works.

### 3. Library page (`src/pages/LibraryPage.tsx`)

Split into three sections with `gap-14` (56px), keeping the existing queries,
notices (`LibraryStateNotice`, service alerts, repick notice) and error alerts in
a top "alerts" stack:

1. **Continue watching** (new component `features/library/ContinueWatching.tsx`)
   - New query `["resume"]` → `fetchResume()` (new API), refetch 60s + focus.
   - `overflow-x-auto` row, `gap-5` (20px), cards `w-[340px]` (token-driven width
     via a `--spacing`-based value or `w-85`; prefer `basis` from a theme token
     `--spacing-card-continue: 21.25rem`), 16:9 still, centred 52px play button
     (`bg-scrim`), 4px progress bar flush at the bottom (track
     `bg-overlay-track`, fill `bg-primary`), title `font-medium`, muted line
     (`S3 · E5 · 14 min left` / `48 min left`).
   - Whole card is a link to `#/play/{itemId}`; hidden when the list is empty.
2. **On the way** (new `features/library/OnTheWay.tsx`)
   - Input: `merged entries` filtered to `activity` or (`requested` && not
     `library`) — i.e. everything not yet playable, minus scan-failed entries
     which stay in the existing notice flow.
   - Grid `repeat(auto-fill, minmax(320px,1fr))` via
     `grid gap-4 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]`; card = `Card`
     with `rounded-xl`, `p-3.5`, 56×84 poster thumb, title + right-aligned ETA
     (no wrap), 6px `Progress`, `Requested by {name}` (from `entry.addedBy`).
   - ETA copy from the existing `downloadEta`/`timeLeft` data → rounded
     `about 20 min` / `about 2 hr` / `Queued`; drop speeds/seeders/torrent names
     (that detail stays available on the show/movie pages).
   - Hidden when nothing is downloading or queued.
3. **Library** (rewrite `features/library/LibraryGrid.tsx`)
   - Toolbar: `Library` heading + muted `N titles`, `ToggleGroup` segmented
     control (All/Movies/Shows, `bg-card` container `p-1`, selected
     `bg-secondary`), `Toggle` "Added by me" (outline border
     `border-secondary`, on-state `border-primary`), `InputGroup` search
     (`w-65` ≈ 260px, `bg-card`, `aria-label="Search library"`).
   - Grid: `grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-5 gap-y-7`,
     card = 2:3 poster (`rounded-lg`), title `font-medium truncate`, muted
     `{year} · {Movie|Show}`. Whole card links to the detail route.
   - Sort by `dateCreated` desc (new field, fallback title) in
     `mergeLibraryEntries`/grid.
   - **No badges at all** (decided with the user: skip `New` and `N new
     episodes`). Also gone: type chip, chevron, rating/runtime/network/added-by
     line, and the trash button.
   - Empty states: keep the empty-library `Empty` + link to Find something new
     (`#/search`); keep "no matches" and "nothing added by you" variants.

### 4. Backend — resume route (only new API)

- `src/upstream/jellyfin.ts`: add `getResumeItems(userId, limit)` →
  `GET /UserItems/Resume?userId=…&Limit=…&MediaTypes=Video&Fields=…`
  (reuse `authHeaders()`/`fetchJson`); extend `JellyfinItem` with
  `BackdropImageTags`, `ParentImageTag`-style fields as needed; add
  `DateCreated` to `LIBRARY_QUERY.Fields` and map `addedAt`/`played` in
  `mapJellyfinItem`.
- `src/routes/library.ts`: `GET /api/library/resume` (requireAuth, user token,
  `cache-control: no-store`) → `ResumeResponse { items: ResumeItem[] }` with
  `id, kind, title, seriesId?, seasonNumber?, episodeNumber?, runtimeMinutes?,
  positionTicks, playedPercentage, imageUrl` (episode thumb when present, else
  series poster), `backdropImageUrl` for movies (via existing image proxy with a
  `type=Backdrop` query param added to
  `GET /api/library/images/:itemId`).
- `src/types.ts` + `frontend/src/api/types.ts` + `frontend/src/api/client.ts`:
  types + `fetchResume()`.
- Test: `backend/test/library-resume.test.ts` — mapping (episode vs movie,
  percentage, image precedence) and route behaviour with `app.inject()`
  (unauthenticated 401, upstream 200 mapped, upstream failure → state/detail).

### 5. Reuse / cleanup

- Keep `mergeLibraryEntries`, `entryTitle`, `searchLibraryEntries`,
  `useLibraryScanState`, `LibraryStateNotice`, `CancelDownloadDialog` (only if
  still referenced after the grid rewrite; else drop the import and leave the
  file for the detail pages' own dialogs).
- Extend `Progress` with an optional indicator className instead of adding a
  second bar component.
- Add shadcn components with the CLI: `dropdown-menu`, `toggle-group`, `toggle`,
  `avatar` (radix-nova style, `components.json` already configured).

## Files to modify

- `server/frontend/src/index.css` — theme tokens, fonts, radii, container.
- `server/frontend/src/App.tsx` — shell layout, header props, container widths.
- `server/frontend/src/components/AppHeader.tsx` — full rewrite.
- `server/frontend/src/pages/LibraryPage.tsx` — 3-section layout + toolbar.
- `server/frontend/src/features/library/LibraryGrid.tsx` — new card/toolbar.
- `server/frontend/src/features/library/ContinueWatching.tsx` (new)
- `server/frontend/src/features/library/OnTheWay.tsx` (new)
- `server/frontend/src/features/library/library-entries.ts` — `addedAt`
  passthrough and recency sort.
- `server/frontend/src/features/library/library-search.ts` — unchanged (reused).
- `server/frontend/src/components/ui/progress.tsx` — optional indicator class.
- `server/frontend/src/components/ui/{dropdown-menu,toggle-group,toggle,avatar}.tsx`
  (added by CLI).
- `server/frontend/src/api/{types,client}.ts` — resume types + `fetchResume`.
- `server/backend/src/upstream/jellyfin.ts` — resume fetch, `DateCreated`,
  backdrop image type.
- `server/backend/src/routes/library.ts` — resume route + image `type` param.
- `server/backend/src/types.ts` — `ResumeItem`/`ResumeResponse`, `LibraryItem`
  extras.
- `server/backend/test/library-resume.test.ts` (new).
- `server/frontend/package.json` — fontsource deps (if self-hosting fonts).

## Steps

- [x] Add shadcn components (`dropdown-menu`, `toggle-group`, `toggle`, `avatar`)
      and the Inter + Space Grotesk font packages; verify the added files follow
      the project style.
- [x] Rewrite `index.css` tokens (palette, radii, container, scrims, type scale,
      font families) and confirm no other page hardcodes the removed tokens.
- [x] Restructure `App.tsx` shell: full-bleed header + `max-w-content` main.
- [x] Rewrite `AppHeader` (wordmark, nav rename, account menu, removals).
- [x] Backend: `DateCreated` mapping, resume client + route, image `type`
      param, types, tests.
- [x] Frontend API: resume types + `fetchResume`.
- [x] `library-entries`: `addedAt` field + recency sort.
- [x] New `ContinueWatching` and `OnTheWay` components.
- [x] Rewrite `LibraryGrid` (toolbar + cards, no badges) and `LibraryPage`
      composition with empty states.
- [x] Extend `Progress`; remove unused imports/dialogs.
- [x] `npm run typecheck`, `npm test` (backend + frontend), `npm run build`.
- [x] Visual verification at 1440px and 390px against the mock.

## Verification

- `cd server && npm run typecheck && npm test && npm run build`.
- Live stack is up (backend `:4000`, Jellyfin `:8096`, Vite `:5173`). Sign in
  through the browser as the `Jacob` profile, then via `agent_browser`:
  `open http://localhost:5173/#/library`, `snapshot -i`, screenshots at
  `set viewport 1440x900` and `390x844`, compare against the mock:
  header nav/underline, continue-watching stills + 4px bars, On-the-way 6px bars,
  grid density, and no "Available" badge / trash / type chip.
- Check empty states by filtering to a state with no matches, and confirm the
  resume section disappears when Jellyfin returns no resume items (can simulate
  by finishing the one in-progress episode, or by asserting the section is
  absent when the query returns `items: []`).
- Confirm the detail pages still show metadata + delete (ShowPage/MoviePage
  unchanged), and Services is reachable only via the account menu.

## Decisions (confirmed with the user)

1. Account menu has a single **Switch person** item (the only logout path;
   lands on the profile picker) instead of separate Switch/Sign out items.
2. **People** moves into the account menu for admins, next to **Services**;
   neither stays in the main nav.
3. Fonts are self-hosted via `@fontsource-variable/inter` and
   `@fontsource-variable/space-grotesk`; the Geist import is dropped.
4. **No poster badges** in the library grid — both `New` and `N new episodes`
   are skipped. `DateCreated` is still fetched, but only for the default
   recency sort.

## Deliberate spec deviations

- Only one account-menu sign-out item (see decision 1).
- No badges (see decision 4).
- `On the way` cards keep no cancel/delete affordance (browse stays
  non-destructive); cancelling stays on the show/movie detail pages.
