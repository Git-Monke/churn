# Episode watch state on the show page

Bean: **churn-icdh** — *Remember and show episode watch progress*
(`.beans/churn-icdh--remember-and-show-episode-watch-progress.md`)

## Context

Jellyfin already tracks per-user watch state and Churn already writes it — the
player reports start/progress/stop upstream (`server/backend/src/routes/playback.ts`)
— but the show page never reads it back, so every episode looks unwatched:

- `loadJellyfinShow` (`server/backend/src/routes/shows.ts`) calls
  `client.getSeasons(id)` / `client.getEpisodes(id)` without a user id, so
  Jellyfin returns no `UserData` at all.
- `ShowEpisode` has no watch fields. `EpisodeRow` even ships a comment saying
  *"Watching progress is not tracked yet, so this column stays empty."*
- The show header plays "the first playable episode" because it cannot tell
  where anybody left off.

Verified against the live Jellyfin 10.11.11 on this box:

| request | `UserData` |
| --- | --- |
| `GET /Shows/{id}/Episodes` (today) | absent |
| `GET /Shows/{id}/Episodes?userId=<id>` | `Played`, `PlayCount`, `PlaybackPositionTicks`, `PlayedPercentage` |

Real rows from Jacob's account (*Parks and Recreation*): S1E1–E4 `Played true`;
S1E6 "Rock Show" `PlaybackPositionTicks 2031460790` / `RunTimeTicks 16096080000`,
`PlayedPercentage 12.62`, `Played false`. One extra query parameter gives the UI
everything it needs, per user.

Outcome: finished episodes show a check + "Watched" at the top-right of the row,
partly watched episodes get an accent progress bar along the bottom of their
thumbnail, and the header's Play button resumes where that user left off. All of
it comes from Jellyfin's own flags — Churn invents no threshold and stores
nothing.

## Approach

1. Pass the signed-in Jellyfin user id to the episode query so `UserData` comes
   back, map it onto `ShowEpisode`, and render it in `EpisodeRow`.
2. Watched = `UserData.Played === true`. In progress = not played **and** a
   playback position between the start and the runtime; the bar value is
   Jellyfin's `PlayedPercentage`, falling back to `position / runtime`. No 90 %
   cut-off of our own: Jellyfin flips `Played` itself from the stop report.
3. Header Play target becomes "episode in progress (most recently played) →
   first unwatched → first playable", still skipping specials.

## Files to modify

- `server/backend/src/upstream/jellyfin.ts` — `getEpisodes(seriesId, userId?)`
- `server/backend/src/routes/shows.ts` — pass `auth.user.id`
- `server/backend/src/shows.ts` — map `UserData`, derive the percentage
- `server/backend/src/types.ts` — `ShowEpisode` fields
- `server/backend/test/shows.test.ts`, `server/backend/test/routes.test.ts`
- `server/frontend/src/api/types.ts` — mirror the DTO
- `server/frontend/src/features/show/episode-watch-state.ts` (new) + `.test.ts`
- `server/frontend/src/features/show/EpisodeRow.tsx` — badge + thumbnail bar
- `server/frontend/src/pages/ShowPage.tsx` — resume target for the header
- `docs/src/web-ui.md`
- `.beans/churn-icdh--remember-and-show-episode-watch-progress.md`

## Reuse

- `JellyfinItem.UserData` (`PlaybackPositionTicks`, `Played`,
  `PlayedPercentage`, `LastPlayedDate`) already exists in
  `server/backend/src/upstream/jellyfin.ts` — added for the resume row.
- `assignIfDefined` (`server/backend/src/shows.ts`) for optional fields;
  `mapPlaybackItem` (`server/backend/src/playback.ts`) reads the same
  `UserData.Played` / `PlaybackPositionTicks` fields.
- `runtimeMinutes()` / `formatRuntime()` and the percentage rounding style in
  `server/backend/src/resume.ts` (`Math.round(pct * 10) / 10`).
- `Progress` (`server/frontend/src/components/ui/progress.tsx`) is the accent
  (`bg-primary`) bar; `ContinueWatching.tsx` overlays it on a 16:9 image exactly
  the same way (`absolute inset-x-0 bottom-0 h-1 rounded-none bg-foreground/20`).
- `EpisodeRow`'s existing right-hand column is the slot for the badge, and
  `episodeStatusLabel()` shows the intended text styling for a row status.
- `ShowPage`'s `showQuery` already refetches on mount and polls every 10 s, so
  coming back from the player picks up new positions with no new plumbing.

## Steps

- [x] `getEpisodes(seriesId, userId?)` adds `userId` to the `/Shows/{id}/Episodes`
      query when given (with a comment explaining that `UserData` only appears
      with it). API-key callers — `library-scan.ts`, `introdb-warm.ts`,
      `next-episode.ts` — keep calling it with one argument.
- [x] `loadJellyfinShow` passes `auth.user.id` to `getEpisodes`. `getSeasons`
      stays user-agnostic.
- [x] `ShowEpisode` (backend + frontend types) gains
      `played?: boolean`, `progressPercent?: number` (1–99, only for a started
      episode Jellyfin does not consider played) and `lastPlayedDate?: string`
      (to rank resume targets).
- [x] `mapEpisode` in `shows.ts` fills them: `played` from
      `UserData.Played`, percentage from `UserData.PlayedPercentage` else
      `PlaybackPositionTicks / RunTimeTicks`, skipped when the position is 0 or
      the runtime is unknown; nothing is set for Sonarr-only episodes.
- [x] `shows.test.ts`: played flag, `PlayedPercentage`, derived percentage,
      position 0 → nothing, Sonarr-only → nothing.
- [x] `routes.test.ts` (new "show watch state" block): the `/Shows/.../Episodes`
      request carries `userId=<session user>` and the episode payload exposes
      `played` / `progressPercent`, `cache-control: no-store` still set.
- [x] `episode-watch-state.ts` + test: `resumeTarget(episodes)` (in progress,
      most recent first, then first unwatched, then first playable; specials and
      non-playable episodes excluded) and the row's accessible label
      (`Play episode 6: Rock Show, 13% watched` / `…, watched`).
- [x] `EpisodeRow`: thumbnail wrapper becomes `relative` and renders
      `<Progress>` on its bottom edge when `progressPercent` is set; the right
      column is no longer empty for watched rows — it shows
      `<CheckIcon className="text-primary" /> Watched` in the existing
      muted `text-[13px]` styling, right-aligned and top-aligned
      (`sm:self-start`) so it sits at the top-right of the card.
- [x] `ShowPage`: replace `firstPlayableEpisode` with `resumeTarget`, and drop
      the "no per-episode watch state" comment on `ShowHeader`.
- [x] `docs/src/web-ui.md`: show page paragraph (badge, bar, header resume) and
      the `?userId=` note for the episodes query.
- [x] Bean: mark `churn-icdh` in-progress, keep its todo checklist current,
      complete it with a `## Summary of Changes`; note the deferred "3 of 10
      watched" season-tab count and the left-empty right column when nothing is
      watched.

## Verification

- `cd server && npm test` — backend `shows.test.ts` + `routes.test.ts` (379
  currently), frontend `episode-watch-state.test.ts` (24 currently).
- Typecheck: `cd server/backend && npx tsc --noEmit`, `cd server/frontend &&
  npx tsc --noEmit`; `npm run build` in `server/frontend`.
- Live data check (already confirmed on 10.11.11, repeat after the change):
  `curl -H "X-Emby-Token: $JELLYFIN_API_KEY" "/Shows/<parks-and-rec>/Episodes?userId=<jacob>"`
  → S1E1–E4 played, S1E6 at ~12.6 %.
- Manual in the app as Jacob, *Parks and Recreation*: S1E1–E4 show "Watched" at
  the top right, S1E6 has a ~13 % accent bar at the bottom of its still, no
  other episodes are marked; the header button reads `Play S1 · E6`.
- Play S1E6 for a minute, stop, return to the show page → the bar advanced
  (and stays hidden once Jellyfin marks it played); play it to the end → the
  check appears and the header moves on to the next unwatched episode.
- Check the empty state: a show with no Jellyfin watch history (or a
  Sonarr-only show) shows no badges and no bars.
