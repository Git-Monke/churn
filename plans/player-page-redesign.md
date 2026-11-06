# Player page redesign — implementation plan

Spec source: the "Player page — implementation spec" pasted by the user, plus the
mock `~/Pictures/Screenshots/Screenshot From 2026-11-05 22-16-57.png`
(the current page for comparison: `~/Pictures/Screenshots/Screenshot From
2026-11-05 22-12-26.png`).

## Context

`server/frontend/src/pages/PlayPage.tsx` works but looks nothing like a media
page: back breadcrumb → "Episode" badge + monospace `S01E02` + "Resumed" badge →
transcoding `Alert` → `<video>` in a square `Card` → Quality `Select` + Autoplay
`Switch` row → "Progress and watched state sync to Jellyfin" footnote.

The redesign makes it a player page: video frame directly under the header, one
title row (title, metadata line, synopsis, Next + playback-settings actions), and
playback chrome (resumed toast, buffering, up next, ended, error) drawn *inside*
the frame. Playback behaviour is untouched: quality switching, resume seek,
start/progress/stop reporting, pagehide beacons, autoplay preference, hls.js
error recovery.

**Decisions taken with the user (these override the spec):**

1. **No season/episode list under the video** — for episodes and movies alike.
   The mock's "Season 1" block, the current-episode progress row and the watched /
   not-downloaded row states are out of scope. `features/show/EpisodeRow.tsx` is
   not touched.
2. **Keep the shipped theme** — `src/index.css` is not modified. The mock's
   palette/radii (`#0E0E10`, amber `#F2B544`, 10–12px corners) are *not* applied
   here, so corners stay `--radius: 0` and the accent stays cream. Use existing
   semantic tokens only (`bg-background`, `bg-card`, `bg-muted`, `border-border`,
   `text-muted-foreground`, `bg-primary`, `ring-ring`); no new tokens
   (`--rule`/`--foreground-soft`/`--track` are replaced by `border-border`,
   `text-muted-foreground` and `bg-muted`).
3. **Up-next countdown stays 3 s** (`NEXT_EPISODE_COUNTDOWN_SECONDS`), not the
   mock's 8 s.
4. **No "Choose a different version"** in the movie error overlay (no routing
   change needed). The existing "Open Jellyfin" escape hatch is kept as a
   secondary button.
5. **Keep "Skip intro"**, restyled like the other in-frame overlays.

## What exists and gets reused

- Installed shadcn pieces: `Button` (`default`/`outline`/`secondary`/`ghost`/
  `link`, sizes incl. `icon`, `sm`), `DropdownMenu` with `RadioGroup`/`RadioItem`/
  `CheckboxItem`/`Label`/`Separator`, `Progress`, `Skeleton`. Nothing needs the
  shadcn CLI (`Collapsible` is unnecessary — `Synopsis` already does the
  overflow-only More/Less toggle).
- `features/title/Synopsis.tsx` — overflow-measured More/Less. Reused with two
  new optional props (`lines`, `className`) whose defaults keep the title pages
  exactly as they are.
- `lib/playback-preferences.ts` — `readPlaybackQuality` / `writePlaybackQuality`,
  `readAutoplay` / `writeAutoplay` (moved into the settings menu, logic shared).
- `lib/playback-segments.ts` — `isInsideSegment` (skip intro) unchanged.
- `hooks/use-hash-route.ts` — `playHash(itemId, from)`, `showHash(source, id,
  season)`. `from: ShowReturnContext` already flows into `PlayPage`; it stays as
  the return context for `playNext`.
- Backend `pickNextEpisode()` (`server/backend/src/playback.ts`) already resolves
  next-episode across season boundaries (specials handled) and is fed by
  `createNextEpisodeLookup()` (Jellyfin series list ⇒ "next downloaded episode"
  is already the semantics). Covered by `server/backend/test/playback.test.ts`
  ("same season", "rolls into the next season and stops at the series finale",
  specials, malformed rows) — no new resolution logic is needed.
- Backend `mapPlaybackItem()` / `PlaybackItem` carry `year`, `runtimeTicks`,
  `overview`, `imageUrl`, `positionTicks`, `played`, `nextEpisode`, `segments`.

Two metadata values the mock needs are missing from the payload: the episode air
date (`PremiereDate`, not in `DETAIL_FIELDS`) and the movie content rating
(`OfficialRating` is already fetched but not mapped). Both are added — it is a
four-line backend change with test coverage.

## Approach

### 1. Player page composition

`PlayPage.tsx` keeps every stream/report/quality/recovery callback it has today.
The JSX is replaced and split into a small `features/player/` feature folder so
the 1 260-line page stays readable:

```
features/player/
  playback-meta.ts            pure helpers + tests
  PlaybackTitleRow.tsx        h1, metadata line, Synopsis, action slots
  PlaybackSettingsMenu.tsx    ⋯ DropdownMenu (quality / autoplay / start over)
  PlayerOverlays.tsx          resumed toast, buffering, ended, error, skip intro
  UpNextCard.tsx              thumbnail + countdown + Play now / Cancel
  use-player-shortcuts.ts     page-level keys, exported guard helpers
```

Root markup: `<div className="flex flex-col gap-7">` (28px) with (a) frame,
(b) title row. No back link, no badges, no alerts, no quality/autoplay row, no
footnote. The app shell (`main` in `App.tsx`) already supplies the 1400px
`max-w-content` column and `px-4 sm:px-6 lg:px-10`; it stays as-is.

### 2. Video frame

- `<div className="relative mx-auto aspect-video w-full max-w-[calc((100dvh-14.5rem)*16/9)] overflow-hidden bg-black">`
  — the `max-w` (not `max-height`) keeps 16:9 while shrinking and centering the
  frame, so header (68px) + frame + title row fit in 1440×900 without scrolling.
  Tune the `14.5rem` once measured in the live app.
- Native `<video controls playsInline preload="metadata" poster>` unchanged, all
  existing handlers kept.
- Overlays are `absolute` children with `pointer-events-none` on their scrim
  layer; interactive panels use `pointer-events-auto`. Panels stop at
  `bottom-19` (76px) so the native control bar is never covered. Scrims use
  `bg-background/55`, `bg-background/75`, `bg-background/85`, `bg-background/90`
  (the tokens the palette already provides instead of raw rgba).

### 3. Title row

Flex row, `items-start`, `justify-between`, `gap-6`, wrapping.

- Left: `min-w-0 flex-[999_1_480px] flex-col gap-2.5`
  - `h1` — `font-heading text-3xl font-semibold tracking-tight max-sm:text-2xl`.
  - Metadata line — `flex flex-wrap items-center gap-x-1.5 text-sm
    text-muted-foreground`, tokens separated by `<span aria-hidden>·</span>`,
    unknown fields omitted (never "n/a"):
    - Episode: show name link (`from ? showHash(from.source, from.id, from.season)
      : #/library/show/jellyfin/{seriesId}`, `text-foreground underline
      underline-offset-4`), `S{n} · E{n}`, `formatRuntime(minutes)`,
      `Aired {formatAirDate(premiereDate)}`.
    - Movie: movie title link (`#/library/movie/jellyfin/{id}`), `year`,
      `formatRuntime(minutes)`, `officialRating`.
  - Synopsis — `<Synopsis lines={3} className="max-w-[72ch]" />`, only when
    `item.overview` exists.
- Right: `flex flex-none items-center gap-2.5`
  - **Next** (episodes with `item.nextEpisode` only) — `Button variant="outline"
    className="h-12 px-4"` containing muted "Next", the next episode name
    (`font-medium`), `SkipForwardIcon`. Navigates without marking this episode
    watched (see §6).
  - **Settings** — `Button variant="outline" size="icon" className="size-12"
    aria-label="Playback settings"` + `MoreHorizontalIcon`.
  - `PlaybackSettingsMenu`: `DropdownMenuContent align="end"`,
    `DropdownMenuLabel` "Quality" + `RadioGroup` with **Auto** (`max`) and the
    remaining tiers from `item.qualities` (section hidden when only `max` exists,
    matching today's `length > 1` gate; the "Original quality" detail is dropped
    from the label so only the preset name shows). Separator +
    `CheckboxItem` "Autoplay next episode" (episodes only, `checked={autoplay}`,
    `onCheckedChange={handleAutoplayChange}`). Separator + `MenuItem`
    "Start from beginning" (`RotateCcwIcon`, seeks to 0 and hides the toast).

### 4. In-frame overlays

State added to `PlayPage` (all presentational — no reporting changes):

- `buffering` — `waiting`/`stalled` listeners start a 600 ms timer; `playing` /
  `canplay` clear it and hide; initial load starts buffered until first `playing`.
  Rendered while `!mediaIssue && !ended`: `LoaderCircleIcon` 40px
  (`animate-spin`) + text in `role="status"`. Copy: `Preparing video…`;
  hls transcode that is still buffering after ~3 s → `Preparing video… this can
  take a moment`; `recovering` → `Reconnecting playback…`; `switchingQuality` →
  `Switching quality…`. This replaces the old transcoding and "Reconnecting
  playback" `Alert` banners.
- `resumed` toast — condition moves into a pure helper
  `shouldShowResumeToast({ positionTicks, runtimeTicks, played })`: position ≥ 30 s
  **and** < 95 % of runtime **and** not `played`. (The resume *seek* keeps its
  current rule so playback behaviour is unchanged; only the toast is gated by the
  new window.) Toast: `absolute top-5 left-5 h-12` panel,
  `bg-background/85 pl-4 pr-2 gap-3.5`, "Resumed at 7:12" + `Button
  variant="secondary" size="sm"` "Start over"; auto-hides after 6 s; hover/focus
  within the panel pauses the timer (`onMouseEnter`/`onFocus` clear,
  `onMouseLeave`/`onBlur` restart); `role="region" aria-label="Resume position"`.
- **Up next** (episodes with `nextEpisode`, not dismissed) — `UpNextCard` at
  `right-5 bottom-19 w-[360px]`, `bg-background/90 p-4 gap-3.5`,
  `pointer-events-auto`, `role="region" aria-label="Up next"`; 112px thumbnail
  (16:9, `bg-muted`, `item.imageUrl` of the next episode is not available, so use
  the poster or a `FilmIcon` placeholder), muted `Up next · in 3s` (or plain
  `Up next` when autoplay is off), next episode name `3 · The Reporter`,
  `Progress` countdown (`h-1 bg-muted`, indicator `bg-primary`, `value` from the
  remaining seconds — only when autoplay is on), then `Play now` (default) and
  `Cancel` (outline) splitting the width at `h-11`.
  Trigger gains the spec's second condition: arm at
  `min(outro.startSec, duration - 20)` (whichever comes first, clamped ≥ 0), so an
  episode without IntroDB credits still offers the next episode in the last 20 s.
  Existing natural-playback arming, seek-disarms and the `ended` fallback stay.
- **Ended** — new `ended` state from `handleEnded`: movie → scrim
  `bg-background/75` + `Watch again` (default) + `Back to library` (outline);
  episode without a next episode → same with `Back to show`. Episodes *with* a
  next episode keep today's up-next behaviour instead.
- **Error** — `mediaIssue` renders the scrim with "This video won't play", the
  muted "The file may be damaged or in a format the browser can't handle." and
  `Try again` (default, `retryPlayback`) + `Open Jellyfin` (outline, existing
  `/api/services/jellyfin/open` link) with `role="alert"`.
- **Skip intro** — kept, restyled as `absolute bottom-19 right-5` outline button
  with `SkipForwardIcon`.

### 5. Settings/keyboard

`use-player-shortcuts.ts` registers one `window` `keydown` listener, disabled
when the target is `INPUT`/`TEXTAREA`/`SELECT`/contenteditable, when the target
is the `<video>` element (native shortcuts already handle it), or when a Radix
menu/dialog is open (`[role="menu"][data-state="open"]`, `[role="dialog"]`).
Space/`k` play-pause, `←`/`→` ±10 s, `f` fullscreen, `m` mute, `n` next episode.
The guard resolution (`resolvePlayerKey(event)`-style pure function) is exported
and unit-tested.

### 6. Playback behaviour that must stay identical

- `handleQualityChange`, `handleAutoplayChange`, recovery (`recoverStream`,
  `RECOVERY_SKIP_SECONDS`), reporting (`reportProgress`, `stopPlayback`,
  `sendStopBeacon`, `sendStopKeepalive`), `handleLoadedMetadata` resume seek,
  intro skip, `handleTimeUpdate` re-arming. Only the JSX around them changes.
- `playNext()` keeps its "report the whole runtime so Jellyfin marks the episode
  watched" behaviour (used by the up-next card, the `ended` path and `N`).
- New: the title-row **Next** button and `N` navigate through the same helper
  with a `markWatched: false` flag, so stopping mid-episode reports the current
  position instead of the full runtime.

### 7. Data plumbing (two new metadata fields)

- `server/backend/src/upstream/jellyfin.ts`: add `PremiereDate` to
  `DETAIL_FIELDS`.
- `server/backend/src/playback.ts`: `PlaybackItem` gains `premiereDate?` and
  `officialRating?`; `mapPlaybackItem` maps `item.PremiereDate` /
  `item.OfficialRating` via the existing `assignIfDefined`.
- `server/frontend/src/api/types.ts`: same two optional fields on `PlaybackItem`.

## Files to modify

New:
- `server/frontend/src/features/player/playback-meta.ts`
- `server/frontend/src/features/player/playback-meta.test.ts`
- `server/frontend/src/features/player/PlaybackTitleRow.tsx`
- `server/frontend/src/features/player/PlaybackSettingsMenu.tsx`
- `server/frontend/src/features/player/PlayerOverlays.tsx`
- `server/frontend/src/features/player/UpNextCard.tsx`
- `server/frontend/src/features/player/use-player-shortcuts.ts`
- `server/frontend/src/features/player/use-player-shortcuts.test.ts`

Changed (frontend):
- `server/frontend/src/pages/PlayPage.tsx` — markup rewrite, overlay state,
  buffering/ended/toast wiring, keyboard hook, next-without-watched, drop the
  removed imports (`Alert`, `Badge`, `Card`, `Select`, `Switch`,
  `TriangleAlertIcon`, `CircleAlertIcon` as they fall out of use).
- `server/frontend/src/features/title/Synopsis.tsx` — optional `lines` +
  `className` props (defaults unchanged).
- `server/frontend/src/api/types.ts` — two payload fields.

Changed (backend):
- `server/backend/src/playback.ts`
- `server/backend/src/upstream/jellyfin.ts`
- `server/backend/test/playback.test.ts` — extend the `mapPlaybackItem`
  expectation with `premiereDate` / `officialRating`.

Docs: no README change (no route/env/behaviour change); the bean file is the
record.

## Reuse

| Need | Existing |
| --- | --- |
| More/Less synopsis | `features/title/Synopsis.tsx` |
| quality + autoplay prefs | `lib/playback-preferences.ts` |
| next-episode resolution | backend `pickNextEpisode` + `createNextEpisodeLookup` (already tested) |
| intro skip trigger | `lib/playback-segments.ts` `isInsideSegment` |
| route helpers | `hooks/use-hash-route.ts` `playHash` / `showHash` |
| runtime / air-date formatting | `lib/format.ts` `formatRuntime`, `formatAirDate` |
| progress bar | `components/ui/progress.tsx` (className-only restyle) |
| spinner | lucide `LoaderCircleIcon animate-spin` (project convention) |
| buttons / menu | `components/ui/button.tsx`, `components/ui/dropdown-menu.tsx` |

## Steps

- [x] 0. `beans create "Redesign the player page" -t feature -s in-progress` and
      keep its todos current (no code before this).
- [x] 1. Backend: `PremiereDate` in `DETAIL_FIELDS`, `premiereDate` +
      `officialRating` on `PlaybackItem`/`mapPlaybackItem`, extend
      `test/playback.test.ts`; `npm test` in `server/backend`.
- [x] 2. Frontend types: add the two fields to `api/types.ts`.
- [x] 3. `Synopsis`: add `lines` (default 4) and `className` props without
      changing any existing caller's rendering.
- [x] 4. `features/player/playback-meta.ts` + tests:
      `shouldShowResumeToast`, `upNextTriggerSeconds`, `formatClock`,
      `playbackMinutes` (runtime ticks → minutes).
- [x] 5. `PlaybackSettingsMenu`, `PlaybackTitleRow` (Next + menu slot).
- [x] 6. `PlayerOverlays` (resumed toast, buffering, ended, error, skip intro)
      and `UpNextCard`.
- [x] 7. Rewrite `PlayPage` JSX with the frame/title-row layout, add `buffering`,
      `ended`, toast-timer state, the 20 s up-next trigger, and
      next-without-watched; wire `use-player-shortcuts` (+ guard tests).
- [x] 8. `npm run typecheck && npm test && npm run build` in `server/frontend`;
      `npm test` in `server/backend`. Leave the working tree uncommitted.

## Verification

1. **Automated** — `cd server/backend && npm test`;
   `cd server/frontend && npm run typecheck && npm test && npm run build`.
2. **Live (stack is already running**: backend `:4001`, Vite `:5173`, Jellyfin
   `:8096`)** — sign in, then with `agent_browser`:
   - an episode (`#/play/<episodeId>`) and a movie at 1440×900: video frame fully
     visible without scrolling, title row below (title, metadata, synopsis,
     Next + ⋯), no season list, no badges/alerts/footnote;
   - mobile 390×844: title row stacks, actions left-aligned, `h1` 24px, up-next
     card inset 12px, no sideways scroll;
   - overlays state by state: resumed toast (partially-watched item, verify the
     6 s auto-hide and that Start over seeks to 0), buffering (hard reload),
     up next with autoplay on and off (seek to the last 20 s), ended (movie and
     last episode), error (point the stream at a bad item / stop Jellyfin's
     response) — each panel sits above the native control bar;
   - settings menu: quality change re-transcodes at the same position, autoplay
     checkbox persists across reloads, Start from beginning seeks to 0;
   - next: title-row Next advances mid-episode and Jellyfin does **not** mark the
     episode watched; up-next card advance at the credits does mark it watched;
   - keyboard: Space/K, ←/→, F, M, N work when the page has focus, do nothing
     while the settings menu is open or a text field has focus.
3. Report the diff to the user; do not commit until they approve (AGENTS.md).
