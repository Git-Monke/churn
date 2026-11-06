---
# churn-7y7l
title: Autoplay starts the next episode from the beginning
status: todo
type: bug
created_at: 2026-11-06T06:48:18Z
updated_at: 2026-11-06T06:48:18Z
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
