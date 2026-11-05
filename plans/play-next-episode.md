# Play next episode from the episode player (churn-daog)

## Context

`PlayPage` (`server/frontend/src/pages/PlayPage.tsx`) plays exactly one Jellyfin
item. When the video ends, `handleEnded` reports the stop position and nothing
else happens; continuing a season means going back to the show page and finding
the next row. The playback route
(`GET /api/playback/items/:itemId`) knows the item is an `Episode` and already
returns `seriesId`, `seasonNumber` and `episodeNumber`, but it never looks at
the rest of the series.

This plan adds an "Up next" affordance that works through a season without a
round trip to the show page.

### Confirmed decisions

- Resolve the next episode **on the backend** from Jellyfin's episode list for
  the current item's `SeriesId`. Jellyfin only lists episodes it has, so the
  next entry is always playable; nothing is inferred from Sonarr.
- Ordering is `(season, episode)`, skipping season 0 specials unless the
  current item is itself a special. A special does not roll into season 1, and
  the last episode of the last season has no next episode.
- `PlaybackItem` gains `nextEpisode?: { id, name, seasonNumber, episodeNumber,
  imageUrl?, runtimeTicks? }`. The frontend renders it; it does not compute the
  next episode itself.
- The next-episode lookup is **best effort**: if Jellyfin is slow or errors, the
  player behaves exactly as today.
- The player shows a persistent "Up next" card below the video whenever a next
  episode exists, plus an end-of-playback overlay with a short countdown.
- Autoplay defaults **on** with a per-browser toggle persisted in
  `localStorage` (`churn:play:autoplay`). Cancelling the countdown leaves the
  ended video paused; the card's button still starts the next episode.
- Advancing uses `replaceHash(playHash(nextId, from))`, not a push, so the
  browser Back button still returns to the show/season instead of replaying the
  finished episode. `PlayPage` is keyed by `route.id` in `App.tsx`, so the hash
  change remounts the player cleanly.
- Quality resets to `max` for the next episode, matching the existing
  "always start at Max" decision in `plans/playback-quality-selector.md`.
- The end overlay triggers at the credits marker when `segments.outro` exists
  (`start_sec` from `churn-bhfb`), not only when the video reports `ended`.
  Without outro data it falls back to `ended`, so the feature still works if
  the segments bean is not done.
- Out of scope: a "next episode" action on `ShowPage`, computing segment
  timestamps, and cross-show autoplay. Credits times are produced by
  `churn-bhfb`; this plan only consumes them.

## Sequencing

Do the IntroDB segments work (`churn-bhfb`) first. That bean adds
`PlaybackItem.segments` (intro/recap/outro) and the backend cache; this plan
consumes `segments.outro.start_sec` for the credits trigger. `churn-daog` is
marked blocked-by `churn-bhfb` so the intended order is explicit.

The backend half of `churn-bhfb` is now implemented: grabbing a season or
episode warms IntroDB for that season/episode and caches it under
`server/cache/releases/introdb/`; playback only reads the cache. The remaining
work in that bean is the player's skip overlay.

The dependency is soft in practice: the up-next card, `nextEpisode` resolution
and `ended`-based countdown are all independent of IntroDB. If the segments work
slips, this plan can land first with the overlay firing on `ended`, then add the
credits trigger in a small follow-up.

## Approach

### 1. Pure next-episode resolution

Add to `server/backend/src/playback.ts`:

```ts
export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
  imageUrl?: string;
  runtimeTicks?: number;
}

export function pickNextEpisode(
  episodes: JellyfinItem[],
  current: { id?: string; seasonNumber?: number; episodeNumber?: number },
): PlaybackNextEpisode | undefined;
```

Rules:

- Ignore items without `Id`, `Name`, or integer
  `ParentIndexNumber`/`IndexNumber`; only `Type === "Episode"` (or a missing
  type, for older Jellyfin responses).
- Drop season 0 unless `current.seasonNumber === 0`; then only consider other
  season 0 episodes.
- De-duplicate by `(season, episode)`, sort ascending, and return the first
  entry strictly after the current tuple. Comparing tuples instead of array
  indexes keeps this correct if Jellyfin returns the current item out of order
  or not at all.
- Build `imageUrl` with the existing `/api/library/images/:id?tag=` shape.
- If the next item has no usable `(season, episode)`, there is no next episode.

Unit-test the helper directly in `server/backend/test/playback.test.ts`:
middle of a season, last of a season, last of the series, specials, missing
current item, duplicate/out-of-order entries, and missing metadata.

### 2. Episode-list lookup and cache

The route already does one `getItem` plus one `getPlaybackInfo`; resolving the
next episode needs the series' episode list, which is a third upstream call.
Keep it cheap and failure-tolerant with a small new module,
`server/backend/src/next-episode.ts`:

- `getSeriesEpisodes(client, seriesId)` calls the existing
  `client.getEpisodes(seriesId)`.
- Cache results in process for 60 seconds in a `Map` capped at ~100 series
  (LRU-ish: delete the oldest key on insert). Code is keyed by `seriesId`;
  episode ordering does not depend on the signed-in user, and the list is only
  used for ordering, not `UserData`.
- Coalesce concurrent lookups for the same series with a `Map<string,
  Promise<JellyfinItem[]>>`, the same pattern as `media-cache.ts`.
- On error, delete the pending promise, do not cache the failure, and return
  `undefined`; the playback route then omits `nextEpisode`.

`getEpisodes` in `server/backend/src/upstream/jellyfin.ts` currently sends
`Fields: "Overview,ProviderIds"`. Add `RunTimeTicks` if it is not returned by
default and confirm `ImageTags.Primary` still comes back (the request already
sets `ImageTypeLimit=1`). `churn-icdh` also wants an optional `userId` on this
method; if that bean lands first, reuse its signature instead of adding a second
variant.

### 3. Playback route

In `server/backend/src/routes/playback.ts`:

1. Keep the existing `[getItem, getPlaybackInfo]` parallel fetch.
2. After mapping the item, if it is an `Episode` with a `seriesId` and both
   indices, call `getSeriesEpisodes` + `pickNextEpisode` (in parallel with
   `mapPlaybackItem`, or immediately after; the extra round trip is acceptable
   on a page that is already loading a stream).
3. Attach `nextEpisode` to the mapped `PlaybackItem` before returning.

Do **not** let an episode-list failure fail the request: log at debug level and
return the item without `nextEpisode`. The route must keep its existing
401/403/404/502 behaviour for the item and media source.

Add route tests in `server/backend/test/routes.test.ts` (using the existing
`buildAuthedServer` / `installFetch` harness):

- an episode in the middle of a season returns `nextEpisode` with the following
  id, code and image URL;
- the last episode of a season returns the first episode of the next season;
- the last episode of the series and a movie return no `nextEpisode`;
- a failing `/Shows/:id/Episodes` request still returns `state: "ok"` with the
  playable item.

### 4. Frontend types

Mirror the backend shape in `server/frontend/src/api/types.ts`:

```ts
export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
  imageUrl?: string;
  runtimeTicks?: number;
}
```

and add `nextEpisode?: PlaybackNextEpisode` to `PlaybackItem`. No new client
function is needed; `fetchPlayback` already returns the whole item.

### 5. Player UI

`server/frontend/src/pages/PlayPage.tsx`:

- Extract the `episodeCode` helper (`S01E02`) so the card and overlay share it
  with the header.
- **Up-next card** below the `<video>` `<Card>` (above or beside the quality
  picker when it exists): thumbnail (`nextEpisode.imageUrl`), `Up next`,
  `S01E02`, name, and a **Play next** `Button` with `PlayIcon`. This card is
  always visible when `nextEpisode` exists, so the feature is discoverable
  before the episode ends.
- **Autoplay toggle**: a small labelled switch/checkbox in the card, state
  initialised from `localStorage["churn:play:autoplay"]` (default `true`), and
  persisted on change. Guard `localStorage` access in a try/catch.
- **End overlay**: wrap the video `<Card>` in `relative`; when playback reaches
  the credits marker or ends and there is a next episode, render an absolutely
  positioned panel (`inset-0`, dark backdrop, `pointer-events-none` on the
  wrapper and `pointer-events-auto` on the panel) with:
  - `Up next` / `S01E02 — name`;
  - a **Play now** button;
  - a **Cancel** button that clears the timer and dismisses the overlay;
  - a countdown (`10` → `0`) driven by a single `window.setTimeout` for the
    advance plus a 1 s interval for the display, or a 1 s interval that
    advances at zero. Clear both on unmount, cancel, manual play and quality
    switch.
  - `aria-live="polite"` on the countdown text so it is announced once, not
    every tick.
- **Trigger**: keep two entry points into the same `ended` state.
  - `handleTimeUpdate` (already runs on every time update) checks
    `item.segments?.outro?.startSec`; when `currentTime` crosses it and the
    overlay has not been dismissed or advanced already, set `ended = true`.
    Only fire once per item (a ref), and do not fire while
    `mediaIssue !== null` or while a quality switch is in flight.
  - `handleEnded` reports the stop at the duration and sets `ended = true` as
    the fallback when there is no outro data (or the user watched past it).
- The overlay/countdown starts in an effect on `ended`, only if `nextEpisode`
  exists, autoplay is on, and `mediaIssue` is `null`.
- `playNext()`:
  1. clear timers and set `ended = false`;
  2. `stopPlayback(durationTicks)` where `durationTicks` is the element duration
     (falling back to `item.runtimeTicks`) — advancing at the credits marker
     must still report the full duration so Jellyfin marks the episode played;
     if `handleEnded` already ran, `stoppedRef` makes this a no-op;
  3. compute `nextFrom = from ?? { source: "jellyfin", id: item.seriesId,
     season: next.seasonNumber }`;
  4. `replaceHash(playHash(next.id, nextFrom))`.

  The remount's unmount cleanup is a no-op because `stoppedRef` is set, so no
  duplicate stop report is sent. The new page reports start through the
  existing `onPlay` handler and resumes from the next episode's own
  `positionTicks`.
- Do not render the card or overlay when `item.type !== "Episode"` or
  `nextEpisode` is missing.
- Keep the existing quality-switch/stream-recovery paths untouched; the card
  sits outside the video element so it cannot intercept native control clicks.
- Do not autofocus the overlay button (it would steal focus from the native
  controls); it is first in DOM order and keyboard reachable.

### 6. Docs

- `server/README.md`: document `nextEpisode` on the playback metadata route and
  the up-next/autoplay behaviour.
- `docs/src/web-ui.md`: describe the Up next card, credits/end countdown,
  autoplay toggle and the `replaceHash` back behaviour, noting that credits
  timing comes from the IntroDB segments added by `churn-bhfb`.
- Root `README.md`: update the roadmap/wording if it lists playback behaviour.

## Files to modify

Backend

- `server/backend/src/playback.ts` — `PlaybackNextEpisode`, `pickNextEpisode`.
- `server/backend/src/next-episode.ts` (new) — per-series episode cache and
  coalescing.
- `server/backend/src/upstream/jellyfin.ts` — episode fields / optional
  `userId` (coordinate with `churn-icdh`).
- `server/backend/src/routes/playback.ts` — attach `nextEpisode`.
- `server/backend/test/playback.test.ts`, `server/backend/test/routes.test.ts`.

Frontend

- `server/frontend/src/api/types.ts` — `PlaybackNextEpisode`, `nextEpisode`.
- `server/frontend/src/pages/PlayPage.tsx` — up-next card, autoplay toggle,
  credits/end overlay, countdown, `playNext`; reads `item.segments` from
  `churn-bhfb`.
- `server/frontend/src/api/types.ts` — `segments` already added by
  `churn-bhfb`; no duplicate change.
- `server/frontend/src/hooks/use-hash-route.ts` — no change expected; reuse
  `playHash`/`replaceHash` (adjust only if `ShowReturnContext` needs the next
  episode's season).

Docs

- `server/README.md`, `docs/src/web-ui.md`, root `README.md`.

## Reuse

- Hash routing and the show/season return context:
  `playHash`, `replaceHash`, `ShowReturnContext` in
  `server/frontend/src/hooks/use-hash-route.ts`, and the `from` handling in
  `App.tsx` / `PlayPage`.
- Playback reporting and session cleanup: `reportPlaybackStop`,
  `stopPlayback`, `stoppedRef`, and the stop-then-start sequence in the
  quality-switch effect.
- Jellyfin client, device headers and error mapping:
  `createJellyfinClient`, `getEpisodes`, `UpstreamError`, `isUnauthorized`,
  `errorMessage`.
- Image URL shape: `jellyfinImageUrl` / `mapPlaybackItem` image mapping.
- Episode code formatting and runtime formatting already in `PlayPage` /
  `ShowPage`.
- UI primitives: `Card`, `Badge`, `Button`, `Skeleton` under
  `server/frontend/src/components/ui/`.
- Test harness: `buildAuthedServer`, `installFetch`, `makeConfig` in
  `server/backend/test/routes.test.ts`; mapper tests in `playback.test.ts`.
- Episode ordering helpers in `shows.ts` (`episodeKey`, sort comparator) as
  prior art, without coupling playback to Sonarr data.

## Steps

- [ ] Add `PlaybackNextEpisode` and `pickNextEpisode` with unit tests.
- [ ] Add the cached, coalesced series-episode lookup.
- [ ] Attach `nextEpisode` in the playback route and add route tests.
- [ ] Mirror the type in the frontend API types.
- [ ] Add the Up next card and autoplay toggle to `PlayPage`.
- [ ] Add the credits/end overlay, countdown and `replaceHash` navigation.
- [ ] Trigger the overlay from `segments.outro.start_sec` when present, else
      `ended`.
- [ ] Verify no duplicate stop/start reports when advancing, and that
      advancing from credits still reports the full duration to Jellyfin.
- [ ] Update README/docs and the roadmap.

## Verification

Automated:

```bash
cd /home/monke/Projects/churn && cargo test
cd server && npm run typecheck && npm test && npm run build
```

Backend tests must cover:

- next episode in the same season, the next season's first episode, the last
  episode of the series, season 0 specials, missing/duplicate indices and an
  out-of-order episode list;
- the playback route includes `nextEpisode` for an episode and omits it for a
  movie or when the episode-list call fails;
- `imageUrl` points at the same-origin image proxy, never at Jellyfin;
- the episode-list cache reuses a recent result and refetches after the TTL
  (inject a clock or expose the TTL for tests).

Manual end-to-end (server stack running):

1. Sign in, open a Jellyfin show, play the first episode of a season.
2. Confirm the Up next card names the correct next episode and that Play next
   starts it immediately, with the browser Back button returning to the show
   season (not the finished episode).
3. Play to the end with autoplay on: the overlay appears, counts down, and the
   next episode starts without a page reload.
4. For an episode with IntroDB outro data, confirm the overlay appears when
   the credits start (not at the file end), and that Jellyfin still marks the
   episode played after the advance.
5. Cancel the countdown, then use the card's Play next button; the next episode
   still starts.
6. Turn the autoplay toggle off, finish an episode and confirm it stays ended;
   reload the page and confirm the preference persisted.
7. Finish the last episode of a season: the next season's first episode is
   offered. Finish the series finale: no card or overlay appears.
8. Open a movie: no Up next UI.
9. Watch an episode directly from Library without a show context and confirm
   the synthesized `jellyfin` return context sends Back to the right show.
10. Start an episode with an existing resume position, advance, and confirm the
    new episode resumes at its own position (not the previous one's).
11. Break Jellyfin's `/Shows/:id/Episodes` (or stop Jellyfin briefly) and
    confirm playback still starts with no Up next UI.
