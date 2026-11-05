# Play the next episode from the player (churn-daog)

## Context

`PlayPage` (`server/frontend/src/pages/PlayPage.tsx`) plays exactly one Jellyfin
item. When the video ends, `handleEnded` reports the stop position and nothing
else happens; continuing a season means going back to the show page and finding
the next row. The playback route (`GET /api/playback/items/:itemId`) knows the
item is an `Episode` and already returns `seriesId`, `seasonNumber` and
`episodeNumber`, but it never looks at the rest of the series.

IntroDB segments are now available on `PlaybackItem.segments` (intro, recap,
outro, postCredits). This plan uses `segments.outro.startSec` to show a
three-second countdown when the credits begin and advance three seconds later.

## Confirmed decisions

- Resolve the next episode **on the backend** from Jellyfin's episode list for
  the current item's `SeriesId`. Jellyfin only lists episodes it has, so the
  next entry is always playable; nothing is inferred from Sonarr.
- Ordering is `(season, episode)`, skipping season 0 specials unless the current
  item is itself a special. A special does not roll into season 1, and the last
  episode of the last season has no next episode.
- `PlaybackItem` gains
  `nextEpisode?: { id, name, seasonNumber, episodeNumber }`. The frontend renders
  it; it does not compute the next episode itself.
- The next-episode lookup is **best effort**: if Jellyfin is slow or errors, the
  player behaves exactly as today.
- No persistent Up next card. The player shows only a small floating countdown
  at the credits when a next episode exists: **Next episode in 3 → 2 → 1**.
- **Countdown:** with outro data, the prompt appears at `outro.startSec` and
  counts `3 → 1`; the next episode starts at `outro.startSec + 3`, so the first
  three seconds of credits play unless the user cancels.
- Autoplay only arms when playback reaches that trigger naturally. Seeking into
  the countdown window or into the credits shows a static **Play next** prompt
  and never auto-advances; scrubbing during the countdown cancels the countdown.
- **No outro data:** fall back to `<video>` `ended`, show the same three-second
  countdown after the file ends, then advance. The feature still works if
  segments are missing.
- **Cancel:** at the pre-credits trigger, cancel dismisses the overlay and lets
  the credits play normally (playback is never paused by the overlay). At the
  `ended` fallback, cancel leaves the finished video paused.
- Autoplay defaults **on**, persisted per browser in
  `localStorage["churn:play:autoplay"]`. The toggle sits in the controls row
  beside the quality picker. When autoplay is off, the credits prompt still
  appears with a **Play next** button, but there is no countdown and no automatic
  advance.
- **Quality persistence:** the selected preset persists per browser in
  `localStorage["churn:play:quality"]`, so a viewer streaming at Medium starts
  the next episode at Medium. This is global across shows, matching the autoplay
  toggle. If a file does not offer the remembered tier, it starts at Max for
  that file **without erasing the preference**; later files that do offer the
  tier use it again.
- Advancing uses `replaceHash(playHash(nextId, from))`, not a push, so Back
  returns to the show/season instead of replaying the finished episode.
  `PlayPage` is keyed by `route.id` in `App.tsx`, so the hash change remounts the
  player cleanly and reads the persisted quality.
- Out of scope: a "next episode" action on `ShowPage`, computing segment
  timestamps, cross-show autoplay, and skip-credits UI.

## Sequencing

`churn-bhfb` already exposes `segments` on playback items and the player consumes
`segments.intro`. Its only remaining work is unrelated to this plan. The
credits prompt and `ended` fallback are independent of segments; the credits
trigger consumes `segments.outro.startSec`. No further dependency work is needed
before starting.

## Approach

### 1. Pure next-episode resolution

Add to `server/backend/src/playback.ts`:

```ts
export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
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
- If the next item has no usable `(season, episode)`, there is no next episode.

Unit-test the helper directly in `server/backend/test/playback.test.ts`:
middle of a season, last of a season, last of the series, specials, missing
current item, duplicate/out-of-order entries, and missing metadata.

### 2. Episode-list lookup and cache

Keep the extra upstream call cheap and failure-tolerant with a new module,
`server/backend/src/next-episode.ts`:

- `getSeriesEpisodes(client, seriesId)` calls the existing
  `client.getEpisodes(seriesId)`.
- Cache results in process for 60 seconds in a `Map` capped at ~100 series
  (LRU-ish: delete the oldest key on insert). Code is keyed by `seriesId`;
  episode ordering does not depend on the signed-in user.
- Coalesce concurrent lookups for the same series with a `Map<string,
  Promise<JellyfinItem[]>>`, the same pattern as `media-cache.ts`.
- On error, delete the pending promise, do not cache the failure, and return
  `undefined`; the playback route then omits `nextEpisode`.

`getEpisodes` already returns `Id`, `Name`, `ParentIndexNumber` and
`IndexNumber`, which is all the prompt needs; no field changes are required.

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

### 4. Quality normalization (backend)

The player may ask for the remembered tier on a file that does not offer it.
Normalize the requested tier to the source's available options before building
the stream URL:

- In the item route, compute `availablePlaybackQualities(picked.source)` and
  use the requested preset only when it is in that list; otherwise use `max`.
  `mapPlaybackItem` therefore always returns `quality` that exists in
  `qualities`, and a low-bitrate episode simply reports `max` without changing
  the stored preference.
- Apply the same coercion on `/api/playback/items/:itemId/hls.m3u8` before
  passing the tier to `buildJellyfinHlsUrl`, so a directly-crafted HLS URL
  cannot request an unavailable tier.
- Keep invalid preset ids a 400 (`invalid_quality`).

Tests: requesting `medium` for a source whose presets exclude Medium returns
`quality: "max"` and a Max stream URL; a high-bitrate source still returns
`medium` as today.

### 5. Frontend types

Mirror the backend shape in `server/frontend/src/api/types.ts`:

```ts
export interface PlaybackNextEpisode {
  id: string;
  name: string;
  seasonNumber: number;
  episodeNumber: number;
}
```

and add `nextEpisode?: PlaybackNextEpisode` to `PlaybackItem`. No new client
function is needed; `fetchPlayback` already returns the whole item.

### 6. Quality preference in the player

- Add small storage helpers in `server/frontend/src/lib/playback-preferences.ts`
  (or inline in `PlayPage` if that stays cleaner):
  - `readPlaybackQuality(): PlaybackQuality` — `localStorage["churn:play:quality"]`,
    accepting only `max | high | medium | low`, default `max`, all access in
    try/catch.
  - `writePlaybackQuality(quality)`.
  - `readAutoplay(): boolean` / `writeAutoplay(enabled)` for
    `churn:play:autoplay`, default `true`.
- Initialise `const [quality, setQuality] = useState(readPlaybackQuality)` so a
  remount for the next episode queries with the remembered tier immediately.
- In `handleQualityChange`, persist the chosen tier. If the switch request
  fails, the existing error effect reverts both the picker and the stored value
  to `item.quality`.
- When a loaded item does not contain the requested tier (for example after
  backend normalization), sync the picker state to `item.quality` **without**
  overwriting the stored preference. A `qualitySwitchRef.current` guard keeps
  this from interfering with an in-flight manual switch.
- Autoplay starts on with the stored value; the toggle persists changes.

### 7. Player UI

`server/frontend/src/pages/PlayPage.tsx`:

- Extract the `episodeCode` helper (`S01E02`) so the prompt and header share it.
- **Autoplay toggle**: a small labelled switch/checkbox in the existing controls
  row (beside the quality picker), state initialised and persisted as above.
- **Credits prompt**: a small floating panel over the bottom-right of the video
  (`absolute bottom-16 right-4`, same visual weight as the skip-intro button; not
  a full-screen overlay) showing:
  - **Next episode in 3**, counting `3 → 2 → 1`, with `aria-live="polite"` so
    it is announced once, not on every tick;
  - a compact `S01E02 — name` line;
  - a **Play now** button that advances immediately (or **Play next** when
    autoplay is off);
  - a **Cancel** button that dismisses the prompt for this item.
- **Trigger and countdown ownership:**
  - `handleTimeUpdate` checks the outro and uses `outro.startSec` as the
    trigger. Once `currentTime >= trigger`, show the prompt if a next episode
    exists, `mediaIssue === null`, `!video.ended`, no quality switch is in
    flight, and the user has not dismissed it.
  - While visible, derive the displayed number from media time:
    `Math.max(1, Math.ceil(outro.startSec + 3 - currentTime))`. This freezes
    naturally if the user pauses.
  - If the user seeks back before the trigger threshold, hide and re-arm the
    prompt (unless it was cancelled), so it can appear again when the credits
    approach. A seek into or past the trigger window leaves the prompt static.
  - With autoplay on, advance when `currentTime >= outro.startSec + 3` (or
    immediately if a timeupdate jumps past it). Do not use a wall-clock timer
    for the credits path, so a paused player never auto-advances. With autoplay
    off, keep the prompt visible until Play next or Cancel.
  - Without outro data, `handleEnded` shows the prompt with five wall-clock
    seconds instead of media time. `handleEnded` also remains the fallback if
    the user watches past the credits trigger.
  - Fire once per item: refs track "prompt shown", "dismissed" and "advancing".
- `playNext()`:
  1. set the advancing/dismissed refs and hide the overlay;
  2. `stopPlayback(durationTicks)` where `durationTicks` is the element
     duration (falling back to `item.runtimeTicks`) — advancing at credits start
     must report the full duration so Jellyfin marks the episode played; if
     `handleEnded` already ran, `stoppedRef` makes this a no-op;
  3. compute `nextFrom = from ?? { source: "jellyfin", id: item.seriesId,
     season: next.seasonNumber }`;
  4. `replaceHash(playHash(next.id, nextFrom))`.

  The remount's unmount cleanup is a no-op because `stoppedRef` is set, so no
  duplicate stop report is sent. The new page reports start through the existing
  `onPlay` handler, resumes from the next episode's own `positionTicks`, and
  uses the persisted quality.
- Cancel behaviour:
  - credits path: dismiss and keep playing; never show the prompt again for this
    episode (seeking backward does not re-arm a cancelled prompt).
  - `ended` path: dismiss and stay on the ended frame.
- Do not render the prompt when `item.type !== "Episode"` or `nextEpisode` is
  missing.
- Keep the existing quality-switch/stream-recovery paths untouched; the prompt
  sits outside the video element so it cannot intercept native control clicks.
- Do not autofocus the prompt buttons (it would steal focus from the native
  controls); they are keyboard reachable.
- Skip-intro and next-episode overlays must not overlap: the next-episode
  overlay is only for the credits trigger, and the skip-intro button hides once
  playback leaves the intro range.

### 8. Docs

- `server/README.md`: document `nextEpisode` on the playback metadata route, the
  quality preference, and the up-next/autoplay behaviour.
- `docs/src/web-ui.md`: describe the three-second credits countdown, cancel
  semantics, the autoplay toggle, persisted quality and the `replaceHash` back
  behaviour.
- Root `README.md`: update the roadmap/wording if it lists playback behaviour.
- Update `churn-daog` with the confirmed timing and quality decisions.

## Files to modify

Backend

- `server/backend/src/playback.ts` — `PlaybackNextEpisode`, `pickNextEpisode`.
- `server/backend/src/next-episode.ts` (new) — per-series episode cache and
  coalescing.
- `server/backend/src/routes/playback.ts` — attach `nextEpisode`; normalize the
  requested quality against the source's available options.
- `server/backend/test/playback.test.ts`, `server/backend/test/routes.test.ts`.

Frontend

- `server/frontend/src/api/types.ts` — `PlaybackNextEpisode`, `nextEpisode`.
- `server/frontend/src/lib/playback-preferences.ts` (new) — quality/autoplay
  localStorage helpers.
- `server/frontend/src/pages/PlayPage.tsx` — persisted quality, autoplay toggle,
  credits/end prompt, countdown, `playNext`.

Docs

- `server/README.md`, `docs/src/web-ui.md`, root `README.md`.

## Reuse

- Hash routing and show/season return context: `playHash`, `replaceHash`,
  `ShowReturnContext` in `server/frontend/src/hooks/use-hash-route.ts`.
- Playback reporting and session cleanup: `reportPlaybackStop`, `stopPlayback`,
  `stoppedRef`, and the stop-then-start sequence in the quality-switch effect.
- Jellyfin client, device headers and error mapping: `createJellyfinClient`,
  `getEpisodes`, `UpstreamError`, `isUnauthorized`, `errorMessage`.
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
- [ ] Normalize requested quality to the source's available tiers and test it.
- [ ] Mirror the next-episode type in the frontend API types.
- [ ] Add quality/autoplay storage helpers; initialise and persist the player
      quality.
- [ ] Add the autoplay toggle to the existing controls row.
- [ ] Add the credits/end prompt with the three-second countdown, Play now,
      Cancel and `replaceHash` navigation.
- [ ] Trigger at `segments.outro.startSec`, advance at start + 3, and fall back
      to `ended` when missing.
- [ ] Verify no duplicate stop/start reports when advancing, and that advancing
      at credits still reports the full duration to Jellyfin.
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
- the episode-list cache reuses a recent result and refetches after the TTL
  (inject a clock or expose the TTL for tests);
- a remembered quality that the source cannot offer falls back to `max`.

Manual end-to-end (server stack running):

1. Sign in, open a Jellyfin show, play the first episode of a season.
2. Let the credits begin: the prompt counts `3 → 1` and the next episode starts
   three seconds later. Confirm Back returns to the show season.
3. Select Medium before the next advance and confirm the next episode starts at
   Medium without touching the picker.
4. Cancel the countdown: the credits continue playing and the prompt does not
   return for that episode.
5. Finish an episode without outro data: the prompt appears after `ended` and
   advances after three seconds.
6. Turn autoplay off, finish an episode and confirm the prompt stays visible but
   does not advance until Play next; reload and confirm the preference persisted.
7. Pick Low, play the next (high-bitrate) episode and confirm it starts at Low;
   play a low-bitrate file that cannot offer Low and confirm it starts at Max,
   then a later high-bitrate episode starts at Low again.
8. Finish the last episode of a season: the next season's first episode is
   offered. Finish the series finale: no prompt appears.
9. Open a movie: no prompt.
10. Watch an episode directly from Library without a show context and confirm
    the synthesized `jellyfin` return context sends Back to the right show.
11. Start an episode with an existing resume position, advance, and confirm the
    new episode resumes at its own position (not the previous one's).
12. Break Jellyfin's `/Shows/:id/Episodes` (or stop Jellyfin briefly) and
    confirm playback still starts with no prompt.
