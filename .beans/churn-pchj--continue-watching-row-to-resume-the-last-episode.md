---
# churn-pchj
title: Continue watching row to resume the last episode
status: todo
type: feature
priority: normal
tags:
    - playback
    - shows
    - library
created_at: 2026-11-05T17:56:50Z
updated_at: 2026-11-05T17:56:54Z
blocked_by:
    - churn-icdh
---

## Goal

Give people a "Continue watching" row that surfaces the last episode they were
watching (and any other episodes in progress), so resuming a show is one click
instead of library -> show -> season -> episode.

Depends on the progress data from churn-icdh: without per-user
playback positions there is nothing to rank or display.

## Current behaviour

- There is no resume concept in Churn. `LibraryPage` opens on the full Jellyfin
  library with All/Movies/Series tabs; `ShowPage` lists seasons and episodes.
- Playback already reports progress to Jellyfin (`/Sessions/Playing*`), so
  Jellyfin knows the resume position for the signed-in user. `PlayPage` also
  applies `item.positionTicks` on load.
- The Jellyfin client (`server/backend/src/upstream/jellyfin.ts`) has no call to
  `/Users/{userId}/Items/Resume` or `/Shows/NextUp` yet.
- `PlayPage` accepts a `from` return context (`ShowReturnContext` in
  `server/frontend/src/hooks/use-hash-route.ts`), so a resume card can link
  straight into the player with the show/season breadcrumb intact.

## What we need

- Backend: add `listResumeItems(userId, limit)` (Jellyfin
  `/Users/{userId}/Items/Resume?MediaTypes=Video&Limit=…&Fields=…`) returning
  `Movie` and `Episode` items with `UserData`.
- Backend: new read-only endpoint, e.g. `GET /api/library/continue-watching`
  (auth required), returning a small DTO:
  `{ state, detail?, items: [{ id, type, name, seriesId?, seriesName?, seasonNumber?, episodeNumber?, positionTicks, runtimeTicks, played, imageUrl, lastPlayedDate? }] }`.
  Map with the existing `mapPlaybackItem`/image helpers where practical; strip
  finished items and cap the list (e.g. 10-20). Handle Jellyfin
  unauthorized/unreachable the same way the library route does.
- Per user: the endpoint must use the session's Jellyfin user id so each
  profile sees its own resume list. Do not persist a separate Churn-side
  history unless caching is needed; Jellyfin is the source of truth.
- Frontend: add `fetchContinueWatching` to `api/client.ts` and types.
- UI: a "Continue watching" section at the top of `LibraryPage`, above the
  filters: horizontal cards (poster/thumbnail, show name, S##E##, title, thin
  progress bar, time left). Clicking a card opens `playHash(id, { source:
  "jellyfin", id: seriesId, season })` for episodes, or `#/play/<id>` for
  movies. Hide the section entirely when empty or when Jellyfin is unreachable.
- Refresh: invalidate the query when returning from the player and after
  playback stop so a finished episode drops off the row; revalidate on window
  focus or with a modest stale time.
- Optional follow-up (separate bean): a "Next up" toggle that falls back to
  Jellyfin's `/Shows/NextUp` for shows with nothing in progress.
- Docs: mention the row and its data source in `docs/src/web-ui.md`.

## Todos

- [ ] Add `listResumeItems` to the Jellyfin client
- [ ] Add `GET /api/library/continue-watching` + DTO mapping (per-user, finished items filtered)
- [ ] Frontend client/types for the new endpoint
- [ ] "Continue watching" row on `LibraryPage` with progress bars and deep links into the player
- [ ] Cache invalidation after playback and on refocus
- [ ] Tests: endpoint mapping/filtering, auth required, frontend rendering and link targets
