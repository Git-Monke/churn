---
# churn-daog
title: Play next episode from the episode player
status: todo
type: feature
priority: normal
tags:
    - playback
    - shows
created_at: 2026-11-05T17:21:57Z
updated_at: 2026-11-05T17:21:57Z
---

## Goal

When the user is watching an episode, offer a "Play next episode" action so they
can continue through a season without going back to the show page.

## Current behaviour

`frontend/src/pages/PlayPage.tsx` plays a single Jellyfin item and only offers
quality switching and a "Back to Library" link. There is no notion of what comes
after the current episode.

## What we need

- The playback response (`GET /api/playback/:id`, built in
  `server/backend/src/playback.ts`) should expose the next episode for an
  `Episode` item: at minimum `{ id, title, seasonNumber, episodeNumber, seriesId }`,
  plus whether it exists on disk yet.
- Player UI: an "Up next" control (button + autoplay countdown) shown when a next
  episode exists. Clicking it stops the current session, starts the next one and
  navigates to `#/play/<nextId>` without losing the show context.
- Autoplay: when the current episode ends, start the next one after a short
  countdown; keep a toggle so users can turn autoplay off.
- Handle the end of a season: either roll into the next season's first episode or
  stop with a clear "no more episodes" state.
- Progress reporting must stop the old session and start the new one correctly
  (`reportPlaybackStop` / `reportPlaybackStart`), the same way quality switches
  already do.
- Cover both library-sourced and request-sourced (`source`) shows.

## Todos

- [ ] Backend: resolve the next episode (same season, then next season) for playback items
- [ ] Extend the playback API type and frontend `PlaybackItem`
- [ ] Add the "Up next" button and autoplay countdown to `PlayPage`
- [ ] Stop/start Jellyfin sessions cleanly when advancing
- [ ] Tests: next-episode resolution (last of season, last of series, missing file) and UI behaviour
