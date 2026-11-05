---
# churn-kwlm
title: Back from an episode returns to the show's season, not the library
status: completed
type: bug
priority: normal
tags:
    - playback
    - navigation
    - shows
created_at: 2026-11-05T17:22:10Z
updated_at: 2026-11-05T17:44:52Z
---

## Problem

Watching an episode lands on `#/play/<jellyfinId>`. Both the back link in the
main player and the one in `PlaybackMessage` (`frontend/src/pages/PlayPage.tsx`)
are hardcoded to `href="#/library"`, so leaving playback always dumps the user
in the library instead of the season of the show they were watching.
Browser back is no better: the play route carries no show/season context.

The selected season on the show page is also only component state
(`selectedSeason` in `ShowPage.tsx`), so any round trip resets it to the
default and cannot be restored even if we navigate back to the show.

## Expected

- Back from an episode goes to that episode's show with the correct season
  selected and the episode visible in the list.
- Browser back/forward and deep links preserve the season too (no lost state).
- Movies should keep going back to the library (or their movie page) — do not
  regress that path.

## Likely approach

1. Put the season in the URL, e.g. `#/library/show/jellyfin/<seriesId>/season/2`
   (extend `parseHash`/`AppRoute` in `frontend/src/hooks/use-hash-route.ts`);
   `ShowPage` reads and writes the season from the route.
2. Put return context in the play route as well, e.g.
   `#/play/<id>?from=show&source=jellyfin&series=<id>&season=2`, or derive it
   from the playback item (it already carries `type`, season and episode numbers)
   and link back accordingly.
3. Update both back links in `PlayPage` to use that context, with the label
   changing to "Back to <show>" / "Back to season N".

## Todos

- [x] Extend the hash router so the show season is part of the URL
- [x] Make `ShowPage` read/write `selectedSeason` from the route
- [x] Give the play route enough return context (show, source and season)
- [x] Replace the hardcoded `#/library` back links in `PlayPage`
- [x] Keep movie playback returning to the library/movie page
- [x] Tests for `parseHash`, `showHash` and `playHash` (frontend vitest)

## Summary of Changes

- `frontend/src/hooks/use-hash-route.ts`: show routes carry an optional season (`#/library/show/<source>/<id>/season/<n>`), play routes carry return context (`#/play/<id>?source=&show=&season=`), plus `showHash`, `playHash` and a `replaceHash` helper that updates the URL without adding a history entry.
- `ShowPage` accepts the route season, writes season changes back to the URL, and builds episode `playHref`s with show/source/season context.
- `PlayPage` reads that context and returns to the correct season with a show-aware back label; both the player and the error view use it, and the "View show" link uses the same target. Movies and context-less deep links still return to the library.
- `App.tsx` passes the season and play return context through.
- Added `frontend/src/hooks/use-hash-route.test.ts` (4 tests) and wired the `server/` `npm test` script to run backend and frontend suites. Docs updated in `docs/src/web-ui.md`.
- Verified with `npm run typecheck`, `npm test` (328 backend + 4 frontend tests) and a production build.
