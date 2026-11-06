---
# churn-icdh
title: Remember and show episode watch progress
status: completed
type: feature
priority: normal
tags:
    - playback
    - shows
created_at: 2026-11-05T17:56:44Z
updated_at: 2026-11-06T05:45:46Z
---

## Goal

Episodes remember how far they have been watched and the interface shows that
progress, so users can tell at a glance what is unwatched, in progress or done.

## Current behaviour

Jellyfin already tracks per-user watch state and the player reads it: the
player reports start/progress/stop upstream, so the data is written. The show
page just never asked for it back: `loadJellyfinShow` called `getSeasons` /
`getEpisodes` without a user id, so Jellyfin returned no `UserData`,
`ShowEpisode` had no watch fields, and the episode row left its right-hand
column empty.

## Tasks

- [x] `JellyfinClient.getEpisodes(seriesId, userId?)` sends `userId`, the only way
      Jellyfin fills `UserData` (verified on 10.11.11; API-key callers such as
      `library-scan.ts`, `introdb-warm.ts` and `next-episode.ts` still call it
      with one argument).
- [x] `loadJellyfinShow` passes `auth.user.id`; `getSeasons` stays user-agnostic.
- [x] `ShowEpisode` (backend + frontend) gains `played?`, `progressPercent?`
      (1–99) and `lastPlayedDate?`.
- [x] `assignWatchState` in `shows.ts` fills them from `UserData.Played` /
  `PlayedPercentage` (falling back to position over runtime), skipping
  unstarted episodes and Sonarr-only rows. No Churn-side threshold: Jellyfin
  flips `Played` itself.
- [x] Tests: `shows.test.ts`, the "show watch state" route block, and the
  frontend `episode-watch-state.test.ts`.
- [x] `EpisodeRow` shows a check + **Watched** at the top right of a finished
      row and an accent bar along the bottom of the thumbnail for a started one;
      both are also in the row's accessible name.
- [x] `ShowPage` header plays the episode in progress, else the first unwatched,
      else the first playable (specials excluded).
- [x] `docs/src/web-ui.md` documents the watch state and the `?userId=` query.
- [x] Bean kept current and completed with a summary.

## Deferred

- The "3 of 10 watched" count on season tabs — the tabs already carry a
  not-downloaded dot and the extra number started to crowd them.
- The right-hand column still shows nothing for a started-but-not-finished
  episode: the bar on the thumbnail is the only affordance, which keeps a
  resume row from competing with **Continue watching**'s own label.

## Summary of Changes

- `server/backend/src/upstream/jellyfin.ts`: `getEpisodes(seriesId, userId?)`
  adds `userId` to `/Shows/{id}/Episodes`, with a comment explaining that
  Jellyfin only returns `UserData` when a user is named.
- `server/backend/src/routes/shows.ts`: `loadJellyfinShow` passes
  `auth.user.id`, so the show page sees the signed-in user's progress instead of
  a library-wide view.
- `server/backend/src/shows.ts`: `assignWatchState` / `progressPercent` map
  `Played`, `PlayedPercentage` (or position over runtime) and `LastPlayedDate`
  onto each episode; percentages are clamped to 1–99 so a nearly finished but
  still-unplayed episode never looks complete.
- `server/backend/src/types.ts`, `server/frontend/src/api/types.ts`: the new
  `played`, `progressPercent` and `lastPlayedDate` fields.
- `server/frontend/src/features/show/episode-watch-state.ts` (new): `resumeTarget`
  (in progress by last played, then first unwatched, then first playable;
  specials and non-playable rows excluded) and `playLabel` (accessible name
  including the watch state).
- `server/frontend/src/features/show/EpisodeRow.tsx`: accent `Progress` bar on
  the bottom edge of the thumbnail for a started episode, a check + **Watched**
  label at the top right of a finished row, and the watch state in the row's
  `aria-label`.
- `server/frontend/src/pages/ShowPage.tsx`: the header's Play button now resumes
  via `resumeTarget` instead of always starting at the first playable episode.
- Tests: `shows.test.ts` (+4 mapping cases), a "show watch state" block in
  `routes.test.ts` (user id forwarded, payload fields, `no-store`) and
  `episode-watch-state.test.ts` (+6). Backend 384, frontend 30.
- `docs/src/web-ui.md`: how episode watch state is read and drawn, and what the
  Play button targets.

Verified against the live Jellyfin 10.11.11: *Parks and Recreation* as Jacob
returns S1E1/E3/E4 played, S1E6 in progress at 12.6 %, and S1E2/E5 unmarked
(rewatch reset) — exactly what the row renders. Typechecks, `npm test` and the
frontend build are clean.
