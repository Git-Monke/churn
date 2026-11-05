---
# churn-daog
title: Play next episode from the episode player
status: completed
type: feature
priority: normal
tags:
    - playback
    - shows
created_at: 2026-11-05T17:21:57Z
updated_at: 2026-11-05T19:34:24Z
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

- [x] Backend: resolve the next episode (same season, then next season) for playback items
- [x] Extend the playback API type and frontend `PlaybackItem`
- [x] Add the floating three-second credits countdown and autoplay toggle to `PlayPage`
- [x] Persist the selected quality across episodes with a Max fallback
- [x] Stop/start Jellyfin sessions cleanly when advancing
- [x] Tests: next-episode resolution, route attachment/failure, cache and quality fallback


## Plan

Implementation plan: `plans/play-next-episode.md`.

Decisions recorded there: the backend resolves the next episode from Jellyfin's
series episode list; season 0 specials do not roll into season 1; the lookup is
best effort and cached per series; there is no persistent Up next card, just a
small floating **Next episode in 3 → 2 → 1** prompt at the credits. The
countdown starts when `segments.outro.startSec` begins and advances three seconds
later (falling back to `ended`). Cancel dismisses the prompt and lets the credits
play. Autoplay and
the selected quality persist per browser in localStorage; a tier the source
cannot offer falls back to Max without erasing the preference. Advancing uses
`replaceHash` so Back returns to the show/season.


## Sequencing

`churn-bhfb` now exposes `item.segments.outro.startSec`; the soft dependency is
satisfied and this bean can start. The credits trigger uses that range, falling
back to `<video>` `ended` when no outro data exists. Plan:
`plans/play-next-episode.md`.


## Summary of Changes

- Playback metadata now resolves `nextEpisode` from Jellyfin's series episode list,
  using a 60-second in-process cache and coalesced lookups. Movies, the series
  finale and failed lookups omit it.
- The item and HLS routes normalize a remembered quality tier to the source's
  available presets, falling back to `max` without changing the stored
  preference.
- `PlayPage` shows a small floating **Next episode in 3 → 2 → 1** prompt starting
  when `segments.outro.startSec` begins and advances three seconds later. Without
  outro data it falls back to `ended` with a three-second wall-clock countdown.
  Play now and Cancel are available; cancelling during credits lets playback
  continue.
- Autoplay is persisted per browser (`churn:play:autoplay`) and the selected
  quality is persisted per browser (`churn:play:quality`) for the next episode.
- Added backend tests for next-episode ordering, route attachment/failure,
  cache TTL/coalescing and quality fallback, plus README/web-ui docs.

- Autoplay is only armed by natural playback reaching the countdown. Seeking
  into the credits or scrubbing during the countdown leaves a static Play next
  prompt and never auto-advances.


- Timing tuned after user testing: the credits prompt now appears when the
  outro starts and counts three seconds (`3 → 2 → 1`) before advancing.
