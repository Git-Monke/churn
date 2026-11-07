---
# churn-7y7l
title: Autoplay starts the next episode from the beginning
status: completed
type: bug
priority: normal
created_at: 2026-11-06T06:48:18Z
updated_at: 2026-11-07T01:22:22Z
---

## Problem

When playback auto-advances to the next episode (`advanceToNext` in `server/frontend/src/pages/PlayPage.tsx`), the new episode mounts a fresh `PlayPage` that seeks to the item's saved `positionTicks`. For a rewatch (e.g. S1E1 auto-advancing into S1E2, which still has progress from an earlier viewing) the next episode starts partway in instead of at 0:00.

## Expected

Autoplay should always start the next episode from the beginning:
- The auto-advance path (up-next countdown / auto trigger in `handleTimeUpdate`, and any future auto-play) must not resume.
- Manually opening an episode (library, Next without watched, deep link) should keep resuming from its saved position.

## Sketch

- Thread a "restart" intent through the route instead of relying on item state: extend `playHash` (`src/hooks/use-hash-route.ts`) + `parseHash` with a `restart=1` query param, e.g. `#/play/<id>?source=jellyfin&show=<seriesId>&season=2&restart=1`.
- `advanceToNext(true)` (auto) sets `restart=1`; `advanceToNext(false)` (explicit Next) leaves it off.
- In `PlayPage`, when `restart` is set, skip the saved-position seek in `handleLoadedMetadata` (treat it as position 0) while still reporting progress normally.
- Cover with a `playHash`/`parseHash` round-trip test and a PlayPage-level check that a restarting mount does not seek.


## Plan

Small, frontend-only. The stream endpoint ignores `positionTicks` (no
`StartTimeTicks`), so the timeline always starts at 0 on the server and a
frontend skip is enough.

### 1. Carry the intent on the route

`src/hooks/use-hash-route.ts`

- `playHash(itemId, from?, restart?)` appends `restart=1` after the existing
  `source`/`show`/`season` params (`URLSearchParams`, so order is stable).
- `AppRoute` `play` variant gains `restart?: boolean`; `parseHash` reads
  `query.get("restart") === "1"` and omits the key when false, matching how
  `from` is conditionally attached today.

### 2. Decide the start position from a pure helper

`src/features/player/playback-meta.ts`

- `RESUME_END_MARGIN_SECONDS = 30` moves here from `PlayPage`.
- `resumeStartSeconds({ positionTicks, played }, { restart, durationSec })`
  returns `0` for restart, for played items, when there is no saved position,
  and when the saved position is within the end margin; otherwise the saved
  seconds. Same rules as the current `handleLoadedMetadata` block, so the only
  behaviour change is `restart`.

### 3. Use it in the player

`src/pages/PlayPage.tsx`

- New prop `restart?: boolean` (default `false`), passed from `App.tsx`
  (`<PlayPage ... restart={route.restart} />`).
- `handleLoadedMetadata` calls `resumeStartSeconds(...)` and only seeks when the
  result is `> 0`; `resumeAppliedRef` still guards the quality-switch path and
  the quality switch keeps seeking to its own `ticks`.
- `advanceToNext(markWatched)` passes `markWatched` as `restart`
  (`replaceHash(playHash(next.id, nextFrom, markWatched))`), so the up-next
  countdown, the **Play now** button and the natural end-of-file advance all
  start at 0, while an explicit **Next** skip (`markWatched === false`) keeps
  the next episode's saved position.
- Manual entry points (season episode rows, continue watching, deep links,
  movies) keep the current resume behaviour because they never set `restart`.

### 4. Tests

- `src/features/player/playback-meta.test.ts`: restart → 0; played → 0; no
  position → 0; near-end → 0; mid-file → saved seconds.
- `src/hooks/use-hash-route.test.ts`: `playHash`/`parseHash` round-trip with
  `restart` and without it (no `restart` key on the route).
- Manual: rewatch S1E1 through the credits and confirm S1E2 opens at 0:00 even
  though it has saved progress; then open S1E2 from the season list and confirm
  it still resumes.

## Todos

- [x] Route: `restart` param in `playHash`/`parseHash` + type
- [x] `resumeStartSeconds` helper and margin constant
- [x] PlayPage `restart` prop, load-metadata skip, `advanceToNext` wiring
- [x] Unit tests for helper and hash round-trip
- [x] Frontend typecheck + tests


## Summary of Changes

- `use-hash-route.ts`: `playHash(itemId, from?, restart?)` appends `restart=1`;
  the `play` route carries `restart?: boolean`, set only when the param is `1`.
  Links without `from` keep the bare `#/play/<id>` form.
- `playback-meta.ts`: new `resumeStartSeconds(item, { restart, durationSec })`
  plus the moved `RESUME_END_MARGIN_SECONDS`; returns `0` for a restart, a
  played item, no saved position, or a position inside the last 30 seconds.
- `PlayPage.tsx`: new `restart` prop (passed from `App.tsx`), the saved-position
  seek now goes through the helper, and `advanceToNext(markWatched)` passes
  `markWatched` as `restart` — so the up-next countdown, **Play now** and the
  `ended` fallback all start the next episode at 0:00, while an explicit **Next**
  skip keeps the next episode's saved position.
- Tests: `resumeStartSeconds` cases in `playback-meta.test.ts` and a
  `playHash`/`parseHash` restart round-trip (including `restart=0` and the
  no-restart link) in `use-hash-route.test.ts`.
- Docs: `docs/src/web-ui.md` and `server/README.md` describe the restart intent.

Verified with `npm test` (46 passing) and `npm run typecheck` in
`server/frontend`. Manual check still worth doing in the browser: rewatch S1E1
through the credits and confirm S1E2 opens at 0:00, then open S1E2 from the
season list and confirm it still resumes.
