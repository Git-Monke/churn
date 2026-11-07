---
# churn-j3ys
title: Continue watching shows the episode after the last completed one
status: completed
type: feature
priority: normal
created_at: 2026-11-07T01:28:09Z
updated_at: 2026-11-07T01:33:01Z
---

The Continue watching row only reads Jellyfin's resume list, so finishing episode 3 of a show makes it disappear instead of offering episode 4. Merge Jellyfin's Next Up list (`/Shows/NextUp`) into `GET /api/library/resume`, gated on the user having completed an episode of that series (Jellyfin's NextUp returns the first episode when nothing is marked played), with resume cards winning, ordered by last activity.

Plan: `plans/continue-watching-next-up.md` (verified against Jellyfin 10.11.11 and its `NextUpService.cs`).

- [x] `client.listNextUpItems(userId, limit)` → `/Shows/NextUp` (`RESUME_FIELDS`, `ImageTypeLimit`, `Primary,Backdrop`)
- [x] `client.listPlayedEpisodes(userId, limit)` → `GET /Items?Recursive=true&IncludeItemTypes=Episode&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Descending&Fields=SeriesId,UserData` (best-effort)
- [x] `buildContinueWatching({ resume, nextUp, played }, limit)` — maps resume cards, applies completed-episode gate + resume-wins dedupe, sorts by last-played desc, caps at 12
- [x] `ContinueWatchingItem.upNext?: boolean` (backend + frontend types); up-next items map with `positionTicks: 0`, `playedPercentage: 0`, episode still → series poster image
- [x] `GET /api/library/resume` runs the three requests in parallel (`Promise.all`), Next Up + played are best effort so a failure there leaves the resume row intact
- [x] Backend tests: `mapNextUpItem` + `buildContinueWatching` in `test/resume.test.ts`; route test serves Next Up/played, asserts merged payload + per-user `userId`/token, Next Up 500 fallback, and the no-completed-episode gate
- [x] Frontend: `upNext` on `ContinueWatchingCard`, `S1 · E5 · Up next` label, progress bar hidden; card/label tests
- [x] `docs/src/web-ui.md`: route table row + Continue watching paragraph
- [x] Updated plan `plans/continue-watching-next-up.md` checkboxes

## Summary of Changes

Continue watching now merges Jellyfin's own Next Up list into the resume row, so finishing an episode offers the next one before it is started.

- **Backend** (`server/backend/src`): `upstream/jellyfin.ts` gains `listNextUpItems` (`/Shows/NextUp`, one next unplayed episode per series — gaps skipped, specials excluded) and `listPlayedEpisodes` (`/Items`, `Filters=IsPlayed`, newest first). `resume.ts` gains `mapNextUpItem` and `buildContinueWatching`: resume card wins per series, next-up card only for a series with a completed episode (because Jellyfin returns a series' first episode when nothing is marked played), cards ordered by latest activity, capped at 12. `routes/library.ts` fires all three requests together; the resume request stays authoritative (its `UpstreamError`/`session_expired` handling is unchanged) while the two next-up lookups are best effort. New optional `ContinueWatchingItem.upNext`.
- **Frontend** (`server/frontend/src`): up-next cards read `S1 · E5 · Up next` and render no progress bar; the card's play link and season back-link are unchanged. `docs/src/web-ui.md` documents the merge, the gate and the ordering.
- **Tests**: backend 396 pass (`test/resume.test.ts` 20, `test/routes.test.ts` 110 with new merge/gate/Next-Up-500 cases), frontend 48 pass. `tsc --noEmit` and `npm run build` clean.
- **Live check** (Jellyfin 10.11.11, :8096): Jacob's S1E2 resume card still wins over Next Up's S1E5; with that episode removed from the resume list the merge produces S1E5 as `S1 · E5 · Up next` with the episode still; admin (no completed episodes) gets no up-next card even though Next Up returns S1E1.
