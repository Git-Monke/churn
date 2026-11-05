---
# churn-lute
title: Proxy Jellyfin resume items for Continue watching
status: todo
type: feature
created_at: 2026-11-05T23:01:32Z
updated_at: 2026-11-05T23:01:32Z
---

## Why
The Library redesign ships 'Continue watching' with mock data because the backend does not proxy Jellyfin resume items yet.

## Scope
- [ ] `JellyfinClient.getResumeItems(userId, limit)` → `GET /UserItems/Resume?userId=…&Limit=…&MediaTypes=Video&Fields=RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber,ImageTags` (verified working on Jellyfin 10.11.11; the legacy `/Users/{id}/Items/Resume` also responds).
- [ ] `GET /api/library/resume` route in `server/backend/src/routes/library.ts` using the user's own access token (`requireAuth`), `cache-control: no-store`, returning `{ state, detail?, items: ResumeItem[] }` with `id, kind (movie|episode), title (series name for episodes), seriesId?, seasonNumber?, episodeNumber?, runtimeMinutes?, positionTicks, playedPercentage, imageUrl`.
- [ ] Image precedence: episode `ImageTags.Primary` (16:9 still) → series primary → poster fallback. Movies: backdrop when `BackdropImageTags` is present; the image proxy (`GET /api/library/images/:itemId`) needs a `type=Backdrop` query param.
- [ ] Add `DateCreated` to the library query Fields and map it to `LibraryItem.addedAt` so the library grid can sort 'most recently added first' (spec requirement, not implemented yet).
- [ ] Types in `server/backend/src/types.ts` + `server/frontend/src/api/types.ts`, `fetchResume()` in `server/frontend/src/api/client.ts`.
- [ ] Replace the mock in `ContinueWatching.tsx` with a `useQuery(['resume'])` (60s + focus refetch) and give each card its `href` (`#/play/{itemId}`).
- [ ] Backend tests: `server/backend/test/library-resume.test.ts` (mapping episode vs movie, percentage, image precedence, 401 unauthenticated, upstream failure → state/detail).

## Done when
Continue watching shows the signed-in user's real Jellyfin resume list and clicking a card resumes playback at the saved position.
