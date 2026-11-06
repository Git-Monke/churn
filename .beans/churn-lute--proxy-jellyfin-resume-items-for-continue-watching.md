---
# churn-lute
title: Proxy Jellyfin resume items for Continue watching
status: completed
type: feature
priority: normal
created_at: 2026-11-05T23:01:32Z
updated_at: 2026-11-06T05:29:20Z
---

## Why
The Library redesign ships 'Continue watching' with mock data because the backend does not proxy Jellyfin resume items yet.

## Scope
- [x] `JellyfinClient.listResumeItems(userId, limit)` → `GET /UserItems/Resume?userId=…&Limit=…&MediaTypes=Video&Fields=RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,SeriesPrimaryImageTag` (verified on Jellyfin 10.11.11; the legacy `/Users/{id}/Items/Resume` returns the same body).
- [x] `GET /api/library/resume` in `server/backend/src/routes/library.ts` using the user's own access token (`requireAuth`), `cache-control: no-store`, returning `{ source, state, detail?, items }` with `id, kind (movie|episode), title (series name for episodes), episodeTitle?, seriesId?, seasonNumber?, episodeNumber?, runtimeTicks?, positionTicks, playedPercentage, imageUrl?, lastPlayedDate?`.
- [x] Backend shaping (`server/backend/src/resume.ts`): finished, unstarted and non-video items dropped, one card per series (its latest episode), response capped at 12 after fetching 20.
- [x] Image precedence: episode `ImageTags.Primary` (16:9 still) → series poster; movie `BackdropImageTags[0]` → own poster. The image proxy (`GET /api/library/images/:itemId`) accepts `type=Backdrop`, and cards request `maxWidth=680`.
- [x] DTO in `server/backend/src/types.ts`, the same shape in `server/frontend/src/api/types.ts`, and `fetchResume()` in `server/frontend/src/api/client.ts`.
- [x] Frontend: `ContinueWatching.tsx` renders the real list (label `S1 · E6 · 24 min left`, progress bar, 16:9 still) and links with `playHash(id, { source: 'jellyfin', id: seriesId, season })` for episodes; the mock is gone. `useContinueWatching()` keeps a 60 s stale time, refetches on focus, and `PlayPage` invalidates `['resume']` on stop and unmount.
- [x] Tests: `server/backend/test/resume.test.ts` (mapper), the "continue watching" block in `server/backend/test/routes.test.ts` (401, unconfigured, mapping/dedupe/per-user token, unreachable, expired session), and `server/frontend/src/features/library/continue-watching-items.test.ts` (labels, links, cards).
- [x] Docs: `docs/src/web-ui.md` endpoint table + a "Continue watching" paragraph.

## Done when
Continue watching shows the signed-in user's real Jellyfin resume list and clicking a card resumes playback at the saved position.

## Summary of Changes
Jellyfin was already the source of truth for playback positions, so no Churn-side watch history was needed.

- `upstream/jellyfin.ts`: `listResumeItems(userId, limit)` (new `RESUME_FIELDS`), `BackdropImageTags` / `SeriesPrimaryImageTag` / `UserData.PlayedPercentage` on `JellyfinItem`, and `getPrimaryImage` generalised to `getItemImage(itemId, { type })` (`Primary`, or `Backdrop/0` for backdrops).
- `resume.ts` (new): `mapResumeItems` / `mapResumeItem` — drops played, unstarted and non-video items, keeps one card per series (newest episode), caps the row, prefers a 16:9 still or backdrop and falls back to the poster.
- `routes/library.ts`: `GET /api/library/resume` with the user's own token and `no-store`, reusing the `/api/library` unconfigured/unauthorized/unreachable handling; the image route validates `?type=Primary|Backdrop`.
- Frontend: `fetchResume`, `useContinueWatching()`, `continue-watching-items.ts` (labels/links/cards), real cards in `ContinueWatching.tsx`, and `['resume']` invalidation in `PlayPage`.
- Verified against the live Jellyfin 10.11.11: Jacob's resume list yields one card — Parks and Recreation, `S1 · E6 · 24 min left`, 12.5 %, 187 KB still.

Related: **churn-icdh** (episode progress in the show page) is untouched and still open; **churn-pchj** is superseded by this bean.
