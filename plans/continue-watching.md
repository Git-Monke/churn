# Continue watching from Jellyfin resume items

Bean: **churn-lute** — "Proxy Jellyfin resume items for Continue watching".

## Context

`LibraryPage` already renders a **Continue watching** row
(`server/frontend/src/features/library/ContinueWatching.tsx`), but the cards come
from a hard-coded `MOCK_CONTINUE_WATCHING` array and none of them has an `href`.
The backend never asks Jellyfin for resume data, so the row is decoration.

Jellyfin already tracks per-user playback positions: `PlayPage` reports
`/Sessions/Playing`, `/Progress` and `/Stopped`, and resumes from
`item.positionTicks`. The data is upstream; churn only has to read it back for
the signed-in user. No Churn-side watch history is needed.

**Answer to the original question: yes — Jellyfin's own resume endpoint is enough.**

Two neighbouring beans exist:

- **churn-pchj** (`Continue watching row to resume the last episode`) — blocked by
  churn-icdh and describes this same row. It is superseded by churn-lute, which
  is unblocked because it does not depend on the show-page progress work.
- **churn-icdh** (`Remember and show episode watch progress`) — progress bars and
  watched state on the `ShowPage` episode list. Out of scope here; leave it as a
  separate bean.

### Verified against the live instance

Probed the local Jellyfin (`http://127.0.0.1:8096`, **10.11.11**, the version
pinned in `server/docker-compose.yml`) with the API key from `server/.env`:

- `GET /UserItems/Resume?userId=…&Limit=20&MediaTypes=Video` → **200** ✅
- `GET /Users/{userId}/Items/Resume?…` (legacy) → **200**, identical body ✅
- `SortBy=DatePlayed&SortOrder=Descending` is accepted; the default order is
  already last-played first.
- Current resume list for user `Jacob`: one item —
  `{ Type: "Episode", Name: "Rock Show", SeriesName: "Parks and Recreation",
  SeriesId: "0eb5…", ParentIndexNumber: 1, IndexNumber: 6,
  RunTimeTicks: 16096080000, UserData: { PlaybackPositionTicks: 2007299910,
  PlayedPercentage: 12.47, Played: false, LastPlayedDate: "…" },
  ImageTags: { Primary: "89c8…" }, BackdropImageTags: [],
  SeriesPrimaryImageTag: "d3ed…", ParentBackdropImageTags: ["16ef…"] }`.
- `GET /Items/{id}/Images/Primary?tag=…` (episode) → `image/jpeg` **1920×1080**
  (already 16:9, perfect for the card).
- `GET /Items/{id}/Images/Backdrop/0?tag=…&maxWidth=680` (movie) → `image/jpeg`
  **680×382, 71 KB**. Unconstrained the same backdrop is 1.4 MB at 3840×2160, so
  the row must ask for `maxWidth`.

## Approach

Read Jellyfin's resume list per user, shape it once in the backend, and swap the
mock for a query.

**Backend**

1. `JellyfinClient.listResumeItems(userId, limit)` in
   `server/backend/src/upstream/jellyfin.ts`:
   `GET /UserItems/Resume?userId=…&Limit=…&MediaTypes=Video&SortBy=DatePlayed&SortOrder=Descending&Fields=RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,SeriesPrimaryImageTag`.
   Add `BackdropImageTags?: string[]`, `SeriesPrimaryImageTag?: string`, and
   `UserData.PlayedPercentage?: number` to `JellyfinItem`.
2. Generalise the image call so backdrops are reachable:
   `getPrimaryImage(itemId, query)` → `getItemImage(itemId, query)` with
   `JellyfinImageQuery.type?: "Primary" | "Backdrop"`, building
   `/Items/{id}/Images/Backdrop/0` for backdrops (keeps the tag/maxWidth/optional
   `quality` handling that already exists).
3. New pure module `server/backend/src/resume.ts` (same shape as `shows.ts` /
   `playback.ts`):
   - `mapResumeItems(items: JellyfinItem[], limit: number): ContinueWatchingItem[]`
     — drop items that are not `Movie`/`Episode`, have no `Id`/`Name`, are
     `UserData.Played`, or have no `PlaybackPositionTicks` → `0`;
   - **dedupe per series**: keep only the most recently played episode per
     `SeriesId` (the upstream list is already newest-first), keep every movie;
   - cap the result (`LIMIT = 12`);
   - image precedence — episode: own `ImageTags.Primary` (16:9 still) → series
     Primary via `SeriesId` + `SeriesPrimaryImageTag` → none; movie:
     `BackdropImageTags[0]` (via `type=Backdrop`) → own `Primary` → none;
   - `imageUrl` = `/api/library/images/{id}?tag=…[&type=Backdrop][&maxWidth=680]`;
   - `playedPercentage` from `UserData.PlayedPercentage`, falling back to
     `positionTicks / runtimeTicks * 100`.
4. Route `GET /api/library/resume` in `server/backend/src/routes/library.ts`
   (registered already by `registerLibraryRoutes`):
   - `reply.header("cache-control", "no-store")`, `requireAuth(request)`;
   - `createJellyfinClient(service, config.requestTimeoutMs, auth.accessToken, { deviceId: auth.deviceId })`
     so each profile gets its own list (Jellyfin is the source of truth, nothing
     is persisted);
   - no API key → `{ state: "unconfigured" }`; `isUnauthorized` → `expireSession`
     + 401 `session_expired` (identical to `/api/library`); `UpstreamError` →
     `{ state, detail }` via the existing `libraryStateForError` / `errorMessage`
     helpers; success → `{ source: "jellyfin", state: "ok", items }`.
5. DTO in `server/backend/src/types.ts`:

   ```ts
   export interface ContinueWatchingItem {
     id: string;
     kind: "movie" | "episode";
     /** Series name for episodes, movie title for films. */
     title: string;
     /** Episode title; absent for movies. */
     episodeTitle?: string;
     seriesId?: string;
     seasonNumber?: number;
     episodeNumber?: number;
     runtimeTicks?: number;
     positionTicks: number;
     playedPercentage: number;
     imageUrl?: string;
     lastPlayedDate?: string;
   }
   export interface ContinueWatchingResponse {
     source: "jellyfin";
     state: LibraryState;
     items: ContinueWatchingItem[];
     detail?: string;
   }
   ```

**Frontend**

6. `server/frontend/src/api/types.ts` — mirror the DTO; `api/client.ts` —
   `fetchResume(): Promise<ContinueWatchingResponse>` (next to `fetchLibrary`).
7. New hook `server/frontend/src/features/library/use-continue-watching.ts`:
   `useQuery({ queryKey: ["resume"], queryFn: fetchResume, staleTime: 60_000,
   refetchOnWindowFocus: true, retry: false })`, returning only `state === "ok"`
   items and swallowing errors (upstream down ⇒ empty row, as the spec asks).
8. `ContinueWatching.tsx`: delete `MOCK_CONTINUE_WATCHING`; keep the existing
   markup/classes (`w-85` 340 px cards, aspect-video still, circular play button,
   bottom `Progress` bar, title + muted line) and render mapped items:
   - `title`; muted line `S1 · E6 · 14 min left` for episodes (`seasonNumber`,
     `episodeNumber`, `Math.ceil((runtimeTicks - positionTicks)/600_000_000)`) and
     `48 min left` for movies;
   - `progress` = `playedPercentage`; `imageUrl` from the API;
   - `href` = `playHash(id, { source: "jellyfin", id: seriesId, season: seasonNumber })`
     for episodes, `playHash(id)` for movies — so the player's back link returns
     to the right season (`ShowReturnContext` in `hooks/use-hash-route.ts`);
   - hide the section when the list is empty.
9. `LibraryPage.tsx` — `<ContinueWatching />` stays where it is; no other change
   if the hook lives in the component.
10. Invalidate `["resume"]` after playback: in `PlayPage.tsx`'s `stopPlayback`
    (next to the existing `["playback", id]` invalidation) and in the unmount
    cleanup effect that already invalidates `["playback", currentItem.id]`.

**Docs**

11. `docs/src/web-ui.md` — add `GET /api/library/resume` to the endpoint table
    and a paragraph in "Library and activity": the row reads Jellyfin's own
    per-user resume list with the user's token, one card per series (most recent
    episode), episodes resume with the season kept in the back-link, and the row
    is hidden when the list is empty or Jellyfin is unreachable.

## Files to modify

| File | Change |
| --- | --- |
| `server/backend/src/upstream/jellyfin.ts` | `listResumeItems`, `BackdropImageTags`/`SeriesPrimaryImageTag`/`PlayedPercentage` on `JellyfinItem`, `getPrimaryImage` → `getItemImage` with image `type` |
| `server/backend/src/resume.ts` (new) | pure mapper: filter, dedupe per series, cap, image precedence, percentages |
| `server/backend/src/routes/library.ts` | `GET /api/library/resume` |
| `server/backend/src/types.ts` | `ContinueWatchingItem`, `ContinueWatchingResponse` |
| `server/backend/test/resume.test.ts` (new) | unit tests for the mapper |
| `server/backend/test/routes.test.ts` | route tests (auth, per-user token, states, image query) |
| `server/frontend/src/api/types.ts`, `api/client.ts` | DTO mirror + `fetchResume` |
| `server/frontend/src/features/library/use-continue-watching.ts` (new) | query hook |
| `server/frontend/src/features/library/ContinueWatching.tsx` | real data, hrefs, labels, drop mock |
| `server/frontend/src/features/library/continue-watching.test.ts` (new) | label/href/percentage mapping |
| `server/frontend/src/pages/PlayPage.tsx` | invalidate `["resume"]` on stop/unmount |
| `docs/src/web-ui.md` | route table + behaviour |

Not touched: `routes/shows.ts`, `shows.ts`, `EpisodeRow.tsx`, `ShowEpisode`
(that is churn-icdh), and `LibraryPage.tsx` beyond nothing.

## Reuse

- `createJellyfinClient(service, timeoutMs, auth.accessToken, { deviceId })` — per-user token, exactly as `/api/library` and the image proxy do.
- `libraryStateForError`, `errorMessage`, `emptyLibrary`-style shaping, `isUnauthorized` + `expireSession` — no new error vocabulary.
- `parseImageQuery` / `optionalString` / `optionalSize` in `routes/library.ts` — extend with `type`.
- `assignIfDefined` (`backend/src/playback.ts`) if the mapper wants to omit empty fields.
- `playHash` + `ShowReturnContext` (`frontend/src/hooks/use-hash-route.ts`) for deep links.
- `fetchPlayback`/`useTitlePlayback` remaining-minutes math (`features/title/use-title-playback.ts`) as the precedent for the `14 min left` label.
- `Progress` (`components/ui/progress`) and the card markup already in `ContinueWatching.tsx`.
- `server/backend/test/routes.test.ts` helpers: `makeConfig`, `installFetch`, `buildAuthedServer`, `testAuthResult`.

## Steps

- [x] Extend `JellyfinItem` (`BackdropImageTags`, `SeriesPrimaryImageTag`, `UserData.PlayedPercentage`)
- [x] Add `listResumeItems(userId, limit)` to the Jellyfin client
- [x] Generalise `getPrimaryImage` → `getItemImage` with `type: "Primary" | "Backdrop"` and teach the image route the `type` query param
- [x] Add `server/backend/src/resume.ts`: `mapResumeItems` (filter finished/zero-position, one card per series, cap 12, image precedence, percentage)
- [x] Add `GET /api/library/resume` (auth, per-user token, no-store, states)
- [x] Add DTO types to `server/backend/src/types.ts`
- [x] Unit-test the mapper (`test/resume.test.ts`)
- [x] Route-test `GET /api/library/resume` (`test/routes.test.ts`)
- [x] Frontend types + `fetchResume`
- [x] `use-continue-watching.ts` hook
- [x] Rewire `ContinueWatching.tsx` (real items, labels, `playHash` hrefs, hide when empty)
- [x] Invalidate `["resume"]` in `PlayPage` on stop and unmount
- [x] Frontend unit test for label/href/percentage mapping
- [x] Document the route and behaviour in `docs/src/web-ui.md`
- [x] Update bean churn-lute todos; note churn-pchj as superseded by churn-lute and keep churn-icdh separate

## Verification

- `cd server/backend && npm test` and `npm run typecheck`; `cd server/frontend && npm test && npm run build`.
- Manual, against the running stack (Jellyfin 10.11.11 on :8096, dashboard on :4000):
  1. Sign in as `Jacob`; the row shows one card — *Parks and Recreation*, `S1 · E6 · 24 min left` (27 min runtime, 200 s watched), bar at ~12 %, 16:9 still.
  2. Confirm the card's `imageUrl` requests `type=Backdrop` only for movies and a `maxWidth` cap (backdrop payload should be tens of KB, not 1.4 MB).
  3. Click it: `#/play/<episodeId>?source=jellyfin&show=<seriesId>&season=1`, the player resumes at 200 s, and back returns to that season.
  4. Play an episode to the end, go back: the card is gone (Jellyfin flips `Played`, `["resume"]` is invalidated).
  5. Sign in as `admin` (no resume history) or stop Jellyfin (`docker compose stop jellyfin`): the section disappears, the rest of Library still renders.
  6. `curl -s localhost:4000/api/library/resume` without a cookie → 401 `unauthenticated`.
