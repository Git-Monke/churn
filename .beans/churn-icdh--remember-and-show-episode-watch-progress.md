---
# churn-icdh
title: Remember and show episode watch progress
status: todo
type: feature
priority: normal
tags:
    - playback
    - shows
created_at: 2026-11-05T17:56:44Z
updated_at: 2026-11-05T17:56:44Z
---

## Goal

Episodes remember how far they have been watched and the interface shows that
progress, so users can tell at a glance what is unwatched, in progress or done.

## Current behaviour

Jellyfin already tracks per-user watch state, and the player reads it:
`GET /api/playback/items/:itemId` loads the item with `auth.user.id`, so
`mapPlaybackItem` (`server/backend/src/playback.ts`) fills `positionTicks` from
`UserData.PlaybackPositionTicks` and `PlayPage` resumes from it.

But the show page never asks Jellyfin for user data:

- `loadJellyfinShow` (`server/backend/src/routes/shows.ts`) calls
  `client.getItem(itemId)`, `client.getSeasons(itemId)` and
  `client.getEpisodes(itemId)` without a user id.
- `getSeasons` / `getEpisodes` (`server/backend/src/upstream/jellyfin.ts`) do not
  send a `userId` query parameter or request `UserData`, so the returned items
  have no `PlaybackPositionTicks`, `Played` or `LastPlayedDate`.
- `ShowEpisode` (`server/backend/src/shows.ts`) consequently has no progress
  fields, and the episode list in `ShowPage` only shows title, runtime and
  availability.

The player does report start/progress/stop to Jellyfin, so the upstream data is
being written; it is just not read back by the library UI.

## What we need

- Backend: fetch episode/season metadata with the signed-in user so Jellyfin
  returns `UserData`. Add `userId` to the upstream client calls (or a dedicated
  `getEpisodes(seriesId, userId)`), keep the API-key calls working for the
  background library scan, and pass `auth.user.id` from the show routes.
- Backend: extend `ShowEpisode` with `positionTicks?`, `runtimeTicks?`,
  `played?` and `lastPlayedDate?`, populated from `jellyfin.UserData` in
  `buildShowEpisodes` (`server/backend/src/shows.ts`).
- Decide what "watched" means for display: use Jellyfin's `Played` flag for the
  watched state and treat `0 < positionTicks < runtime` as in progress. Jellyfin
  flips `Played` itself once the stop report crosses its threshold, so Churn
  should not invent its own threshold.
- UI: in `ShowPage`, draw a thin progress bar across the bottom of each episode
  thumbnail (or a compact bar in the list), plus a subtle "Watched" / "Resume
  from 12:34" affordance. Keep the existing episode actions working.
- Refresh progress when returning from the player: invalidate the show query
  (and the continue-watching query once that exists) on navigation back, or use
  a short stale time so progress is not minutes old.
- Season summaries can show "3 of 10 watched" if it fits the layout; optional.
- Sonarr-only shows (episodes without a Jellyfin item) have no upstream watch
  state; show them as unwatched rather than guessing.
- Update `server/frontend/src/api/types.ts` and the show API docs
  (`docs/src/web-ui.md`) for the new fields.

## Todos

- [ ] Pass the Jellyfin user id through show/seasons/episodes lookups and request `UserData`
- [ ] Map `PlaybackPositionTicks`, `Played`, `LastPlayedDate` and `RunTimeTicks` into `ShowEpisode`
- [ ] Ensure the background library scan still works without a user id
- [ ] Add progress bar + watched/resume indicators to the episode list in `ShowPage`
- [ ] Refresh show data after playback stops
- [ ] Tests: mapper output for partial/finished/unwatched episodes, show route forwards user id, UI rendering of the three states
