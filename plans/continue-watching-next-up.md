# Continue watching: the episode after the last completed one

Bean: **churn-j3ys** — "Continue watching shows the episode after the last completed one"

## Context

Today `GET /api/library/resume` (`server/backend/src/routes/library.ts`) returns
only Jellyfin's per-user resume list, and `mapResumeItems`
(`server/backend/src/resume.ts`) drops every item that is `Played` or has a zero
playback position. So finishing an episode makes its show **disappear** from
Continue watching until the next episode is started by hand — the row never says
"you finished E3, E4 is waiting".

Jellyfin already has the data and the logic for this: its **Next Up** endpoint
returns, per series, the first *unplayed* episode after the highest played
episode `(season, episode)`, skipping gaps (so an episode missing from the
library is not offered) and skipping season-0 specials. Churn only has to merge
that list into the row.

Verified against the live instance (`http://127.0.0.1:8096`, Jellyfin
**10.11.11**, API key from `server/.env`):

| request | result |
| --- | --- |
| `GET /Shows/NextUp?userId=<jacob>&Limit=20` | **200**, one item: S1E5 "The Banquet", `SeriesId`, `ParentIndexNumber 1`, `IndexNumber 5`, `RunTimeTicks 12874949999`, `ImageTags.Primary`, `SeriesPrimaryImageTag`, `UserData { PlaybackPositionTicks 0, Played false, LastPlayedDate }` |
| `GET /Shows/NextUp?…&Fields=RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,BackdropImageTags,SeriesPrimaryImageTag&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop` | **200**, identical payload — the field/image params are accepted |
| `GET /Items?userId=<jacob>&Recursive=true&IncludeItemTypes=Episode&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Descending&Fields=SeriesId,UserData&Limit=80` | **200**, one item: S1E4 "Boys' Club", `SeriesId`, `UserData.LastPlayedDate` |
| `GET /Shows/NextUp?userId=<jacob>` | S1E5 — E4 is the last *completed* episode, so E4's show is absent from `/UserItems/Resume` (the bug this fixes) |
| `GET /Shows/NextUp?userId=<admin>` | S1E1 "Pilot" — admin has **no completed** episode, only a 23 % resume position, so Next Up falls back to the series' first unplayed episode |

That last row is why a gate is needed. Reading Jellyfin's own code
(`Jellyfin.Server.Implementations/Item/NextUpService.cs` on `master`):

- `GetNextUpSeriesKeys` only considers series that have **at least one episode
  with a non-null `LastPlayedDate`** for the user, ordered by that date;
- the candidate set is "unplayed episodes after the highest played
  `(season, episode)`", ordered ascending — the first hit wins, so gaps are
  skipped and specials (`ParentIndexNumber == 0`) are excluded;
- with **no** played episode the position filter is skipped, so the series'
  **first** unplayed episode is returned (`admin` → S1E1).

Requirement being implemented: *"complete E3 of a show → continue watching shows
E4, even though I never started it"*. So Next Up entries are only kept for series
where the user has actually **completed** an episode; resume cards always win for
the same series.

## Approach

One extra upstream call (Next Up), one tiny gate query (the user's completed
episodes), merged in the existing mapper module. No new endpoint, no new
persistence, no Churn-side watch history — Jellyfin stays the source of truth and
everything is per user because the route already forwards the user's token.

**Backend**

1. `server/backend/src/upstream/jellyfin.ts` — two client methods next to
   `listResumeItems`:
   - `listNextUpItems(userId, limit)`:
     `GET /Shows/NextUp?userId=…&Limit=…&StartIndex=0&Fields=<RESUME_FIELDS>&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop`
     (`EnableResumable` and `EnableRewatching` are left at their defaults: true /
     false, so a next-up episode that already has a resume position is included
     and watched episodes are not offered again). Return `response.Items ?? []`.
   - `listPlayedEpisodes(userId, limit)`:
     `GET /Items?userId=…&Recursive=true&IncludeItemTypes=Episode&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Descending&Fields=SeriesId,UserData&Limit=…`.
     Used **only** as the "this series has a completed episode" gate plus its
     `LastPlayedDate`. Comment why the request exists, referencing
     `GetNextUpSeriesKeys` (a series with no completed episode falls back to its
     first episode upstream).
   - Reuse the existing `RESUME_FIELDS` constant for both, or add
     `NEXT_UP_FIELDS` if the Next Up response needs nothing more (verified: same
     fields work).
2. `server/backend/src/resume.ts`:
   - `NEXT_UP_FETCH_LIMIT = RESUME_FETCH_LIMIT` (20) and
     `PLAYED_FETCH_LIMIT = 80` (= 4 × the row cap, so the 12 cards can be filled
     from the most recent completions; documented as a window, not a limit of the
     feature).
   - `mapNextUpItem(item): ContinueWatchingItem | null` — same card shape as
     `mapResumeItem` (series title, `episodeTitle`, `seriesId`, season/episode,
     runtime, still via the existing `imageUrlFor`), but it is the mirror image:
     require `Type === "Episode"`, `Id`, `Name`, `SeriesId`, `SeriesName`,
     `UserData.Played !== true` **and** `(UserData.PlaybackPositionTicks ?? 0) === 0`
     (an item with a saved position belongs to the resume list, and a duplicate
     card would otherwise appear). Set `positionTicks: 0`,
     `playedPercentage: 0`, `upNext: true` and carry `UserData.LastPlayedDate`.
   - `buildContinueWatching({ resume, nextUp, played }, limit = RESUME_ITEM_LIMIT)`:
     1. `mapResumeItems(resume)` → resume cards (unchanged contract, still
        one per series, still drops finished/zero-position items);
     2. `completed = new Set(played.map(i => i.SeriesId).filter(Boolean))` and
        `completedDates = Map<seriesId, LastPlayedDate>`;
     3. map `nextUp` with `mapNextUpItem`, drop anything whose `seriesId` is not
        in `completed` (the gate) or already has a resume card (resume wins);
     4. stable-sort the merged list by `lastPlayedDate` descending, `undefined`
        last (Next Up items do carry `LastPlayedDate`; fall back to the gate's
        date when an item has none), then `.slice(0, limit)`.
   Keep `mapResumeItems` / `mapResumeItem` exported and untouched so the existing
   tests stay valid.
3. `server/backend/src/types.ts` — add `upNext?: boolean` to
   `ContinueWatchingItem` ("the episode after the last completed one; nothing
   watched yet, so `positionTicks`/`playedPercentage` are 0").
4. `server/backend/src/routes/library.ts` — in `GET /api/library/resume`, after
   the existing client creation:

   ```ts
   const resume = client.listResumeItems(auth.user.id, RESUME_FETCH_LIMIT); // fatal
   const nextUp = client.listNextUpItems(auth.user.id, NEXT_UP_FETCH_LIMIT).catch(() => []);
   const played = client.listPlayedEpisodes(auth.user.id, PLAYED_FETCH_LIMIT).catch(() => []);
   const [resumeItems, nextUpItems, playedItems] = await Promise.all([resume, nextUp, played]);
   return continueWatchingResponse("ok", buildContinueWatching({ resume: resumeItems, nextUp: nextUpItems, played: playedItems }));
   ```

   The two helpers are best effort (same spirit as `createNextEpisodeLookup` in
   `next-episode.ts`): an up-next failure leaves the resume row exactly as it is
   today, and a resume failure keeps the existing `UpstreamError` /
   `session_expired` handling. `cache-control: no-store`, the 401 on
   `isUnauthorized` and the `unconfigured` early return stay as they are.

**Frontend**

5. `server/frontend/src/api/types.ts` — mirror `upNext?: boolean`.
6. `server/frontend/src/features/library/continue-watching-items.ts`:
   - `ContinueWatchingCard` gains `upNext: boolean`;
   - `resumeLabel`: when `item.upNext` is set, produce `S1 · E5 · Up next`
     (season/episode parts reused, `Up next` instead of the minutes-left text —
     `remainingMinutes` would otherwise report the whole runtime as "left");
   - the existing in-progress branches are unchanged.
7. `server/frontend/src/features/library/ContinueWatching.tsx` — render the
   `<Progress>` bar only when `!item.upNext` (an empty track under a still reads
   as a broken progress bar; an up-next card has nothing watched yet). Everything
   else — 16:9 still, play button, `playHash` href with `show`/`season` — is
   already correct: clicking an up-next card opens the player on that episode at
   0:00 and the back link returns to the right season.
8. Nothing to do for cache invalidation: `PlayPage` already invalidates
   `["resume"]` on stop and unmount, so finishing E3 and going back re-renders the
   row with E4 as the up-next card. `refetchOnWindowFocus` covers a completion
   that happened in another Jellyfin client.

**Docs**

9. `docs/src/web-ui.md`:
   - route table: `GET /api/library/resume` — "…resume list plus the next
     episode after the last completed one, one card per series";
   - the **Continue watching** paragraph: the backend now merges
     `/UserItems/Resume` with `/Shows/NextUp`, keeps a next-up episode only when
     the user has a completed episode in that series, prefers the in-progress
     episode when both exist, sorts by last played date, and renders the next-up
     card as `S1 · E5 · Up next` with no progress bar;
   - note that Jellyfin only offers the next episode when it exists in the
     library (gaps are skipped) and that specials are not offered.

## Reuse

- `createJellyfinClient(service, timeoutMs, auth.accessToken, { deviceId })` and
  `requireAuth` / `expireSession` / `libraryStateForError` / `errorMessage` — no
  new error vocabulary, no new route.
- `mapResumeItem`'s card shaping, `imageUrlFor` (episode still → series poster,
  `maxWidth=680`) and `assignIfDefined` in `resume.ts` — `mapNextUpItem` is the
  same body with the position rule inverted.
- `RESUME_FIELDS`, `RESUME_FETCH_LIMIT`, `RESUME_ITEM_LIMIT`,
  `continueWatchingResponse` in `resume.ts` / `upstream/jellyfin.ts`.
- `createNextEpisodeLookup` (`next-episode.ts`) as the precedent for "best
  effort upstream lookup, failure is not fatal".
- `resumeDetail` (`features/title/use-title-playback.ts`), `playHash` +
  `ShowReturnContext` (`hooks/use-hash-route.ts`), `Progress`
  (`components/ui/progress`) and the existing card markup.
- Test helpers in `server/backend/test/routes.test.ts`: `makeConfig`,
  `installFetch`, `buildAuthedServer`, `jsonResponse`.

## Files to modify

| File | Change |
| --- | --- |
| `server/backend/src/upstream/jellyfin.ts` | `listNextUpItems`, `listPlayedEpisodes` |
| `server/backend/src/resume.ts` | `mapNextUpItem`, `buildContinueWatching`, `NEXT_UP_FETCH_LIMIT`, `PLAYED_FETCH_LIMIT` |
| `server/backend/src/routes/library.ts` | merge Next Up + completed gate into `GET /api/library/resume` |
| `server/backend/src/types.ts` | `upNext?: boolean` |
| `server/backend/test/resume.test.ts` | `mapNextUpItem` / `buildContinueWatching` cases |
| `server/backend/test/routes.test.ts` | serve `/Shows/NextUp` and the played query; update the existing resume test; new merge/failure/gate tests |
| `server/frontend/src/api/types.ts` | `upNext?: boolean` |
| `server/frontend/src/features/library/continue-watching-items.ts` | `upNext` on the card, `Up next` label |
| `server/frontend/src/features/library/ContinueWatching.tsx` | hide the progress bar for up-next cards |
| `server/frontend/src/features/library/continue-watching-items.test.ts` | label/card cases for up-next |
| `docs/src/web-ui.md` | route table + Continue watching paragraph |
| `.beans/churn-j3ys--*.md` | steps + completion summary |

## Steps

- [x] `listNextUpItems(userId, limit)` in `upstream/jellyfin.ts` (`/Shows/NextUp`, `RESUME_FIELDS`, `ImageTypeLimit=1`, `EnableImageTypes=Primary,Backdrop`)
- [x] `listPlayedEpisodes(userId, limit)` (`/Items`, `Recursive`, `IncludeItemTypes=Episode`, `Filters=IsPlayed`, `SortBy=DatePlayed`, `SortOrder=Descending`, `Fields=SeriesId,UserData`) with a comment explaining the gate
- [x] `mapNextUpItem` in `resume.ts`: episode only, unplayed, zero position, `upNext: true`, `positionTicks`/`playedPercentage` 0, still/series poster image
- [x] `buildContinueWatching({ resume, nextUp, played }, limit)`: resume mapping, completed-series gate, resume-wins dedupe, last-played-desc sort, cap 12
- [x] `upNext?: boolean` on `ContinueWatchingItem` (backend + frontend types)
- [x] `GET /api/library/resume` runs the three requests (`Promise.all`, up-next/played best effort), returns the merged list
- [x] `test/resume.test.ts`: up-next mapping (played/zero-position/with-position/missing series), gate drops series with no completed episode, resume wins per series, sort order, cap
- [x] `test/routes.test.ts`: existing resume test serves Next Up + played list and asserts the merged payload and the `userId` on both new requests; Next Up 500 leaves the resume card intact; a series in Next Up without a completed episode is dropped
- [x] Frontend: `upNext` on `ContinueWatchingCard`, `S1 · E5 · Up next` label, progress bar hidden for up-next
- [x] `continue-watching-items.test.ts`: up-next label + card mapping + href
- [x] `docs/src/web-ui.md`: route table row and the Continue watching paragraph
- [x] Update bean churn-j3ys and complete it with a `## Summary of Changes`

## Verification

- `cd server/backend && npm test && npm run typecheck`; `cd server/frontend && npm test && npm run build`.
- Live checks (Jellyfin 10.11.11 on :8096, dashboard on :4000):
  1. `curl -s "http://127.0.0.1:8096/Shows/NextUp?userId=<jacob>&Limit=20" -H "X-Emby-Token: $JELLYFIN_API_KEY"` → S1E5 (already confirmed above).
  2. As Jacob, *Parks and Recreation*: S1E4 is played and S1E2 is in progress, so the row must still show **only** the S1E2 resume card — resume wins over S1E5 for that series.
  3. Play the in-progress S1E2 to the end and go back: the card becomes `S1 · E5 · Up next` with no progress bar, and clicking it opens `#/play/<e5>?source=jellyfin&show=<series>&season=1` at 0:00 with back returning to season 1.
  4. As a profile with **no completed** episode (admin, which has a 23 % resume position only): the resume card is shown and no `Up next` card appears for that series.
  5. `docker compose stop jellyfin` → the row disappears, Library still renders; `/api/library/resume` without a cookie → 401 `unauthenticated`.
- Confirm the row's `imageUrl` for an up-next card is the episode still
  (`/api/library/images/<episodeId>?tag=…&maxWidth=680`), not a full-size image.
