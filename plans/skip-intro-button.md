# Skip intro button in the episode player (churn-bhfb)

## Context

The backend half of `churn-bhfb` is done: grabbing a season or episode warms
IntroDB ranges into the release cache, and `GET /api/playback/items/:itemId`
returns them as `item.segments` (`intro`, `recap`, `outro`, `postCredits`, in
absolute seconds). The player ignores them today, so the metadata has no
visible effect.

This plan adds the first consumer: a **Skip intro** button in
`server/frontend/src/pages/PlayPage.tsx`. It is intentionally limited to the
intro range; recaps, credits and the next-episode countdown stay out of this
change.

## Confirmed decisions

- **Scope:** intro only. `segments.recap`, `segments.outro` and
  `segments.postCredits` remain in the API but have no UI here. Credits timing
  belongs to `churn-daog`; skip-recap is a later follow-up.
- **Visibility window:** the button appears while `startSec <= currentTime <
  endSec`. No lead-in before the intro starts, no lingering after it ends.
  Because the condition is derived from the current time, seeking back into the
  intro shows it again; there is no "dismissed" state to remember.
- **Skip target:** `intro.endSec`, clamped to `duration - 0.25s` when the video
  duration is known. This avoids seeking past a stream's last playable frame.
- **Play state:** skipping preserves it. A playing video keeps playing; a paused
  video stays paused at the new position.
- **Progress:** update `positionRef` synchronously with the seek target so the
  next pause/stop report and the unmount beacons carry the new position instead
  of the pre-skip time.
- **Hidden when irrelevant:** no button without `segments.intro`, during error
  recovery/reconnect, or when a media error is shown.
- **Placement:** bottom-right inside the existing video `Card`, above the native
  control bar, using the existing `Button` component (`variant="secondary"`,
  `size="sm"`, `SkipForwardIcon`). It must not cover the native play/seek
  controls.
- **Fullscreen caveat:** the overlay is a sibling of `<video>`, so it is not
  visible while the browser's native video fullscreen is active. Fixing that
  requires a custom control bar/container fullscreen and is out of scope; the
  plan lists it as a follow-up instead of half-doing it here.
- **No backend changes.** `PlaybackItem.segments` and the frontend
  `PlaybackSegments` type already exist, and the playback route is already
  covered by tests.

## Implementation

### 1. Pure range helper + unit test

Add `server/frontend/src/lib/playback-segments.ts`:

```ts
import type { PlaybackSegment } from "@/api/types";

/** True while `timeSec` is inside the half-open segment range. */
export function isInsideSegment(
  segment: PlaybackSegment | undefined,
  timeSec: number,
): boolean {
  return (
    segment !== undefined &&
    Number.isFinite(timeSec) &&
    timeSec >= segment.startSec &&
    timeSec < segment.endSec
  );
}
```

A pure helper keeps the JSX free of boundary logic and is testable without a
DOM test setup (the frontend suite currently only runs node-only tests).

Add `server/frontend/src/lib/playback-segments.test.ts` covering:

- before `startSec` → false
- exactly `startSec` → true
- inside the range → true
- exactly `endSec` → false
- `undefined` segment and non-finite time → false

### 2. Player state and seek

In `PlayPage`:

- `const [showSkipIntro, setShowSkipIntro] = useState(false);`
- In `handleTimeUpdate`, after updating `positionRef`, derive visibility from
  `itemRef.current?.segments?.intro` and `video.currentTime`, and only call
  `setShowSkipIntro` when the boolean changes (the event fires ~4×/second).
  Suppress it while `recoveringRef.current` is true or `mediaIssue` is set.
- Reset `showSkipIntro` when `item?.id` changes, alongside the existing
  recovery/media reset effect, so a stream restart cannot leave a stale button.
- Add `skipIntro()`:
  - read `itemRef.current?.segments?.intro`; return if absent;
  - read `videoRef.current`; return if absent;
  - compute `target = intro.endSec`; if `video.duration` is finite and
    `target > video.duration - 0.25`, use `duration - 0.25`;
  - set `video.currentTime = target`;
  - set `positionRef.current = Math.round(target * TICKS_PER_SECOND)`;
  - `setShowSkipIntro(false)` (the next `timeupdate` confirms it).
  - Do not call `play()`/`pause()`; seeking does not change the element's
    playing state, and the browser may reject an unnecessary `play()`.
- No changes to quality switching: `segments` comes from the same `item` and
  the existing `loadedmetadata` seek path re-applies the stream position. The
  time-derived button follows automatically.

### 3. JSX

Make the video card a positioning context and render the overlay after the
`<video>`:

```tsx
<Card className="relative gap-0 overflow-hidden bg-black py-0">
  <video ... />
  {showSkipIntro ? (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="absolute bottom-16 right-4 z-10 shadow-lg"
      onClick={skipIntro}
      aria-label="Skip intro"
    >
      <SkipForwardIcon className="size-4" />
      Skip intro
    </Button>
  ) : null}
</Card>
```

`bottom-16` clears the native control bar (roughly 40–50px) on desktop and
mobile. The button is a normal focusable control; clicking it removes it because
the seek leaves the intro range.

Import `SkipForwardIcon` from `lucide-react` alongside the existing icons.

### 4. Docs

Update the IntroDB paragraph in `docs/src/web-ui.md`: replace "The skip-intro
control that consumes these ranges is the next player change." with a sentence
that the player shows **Skip intro** while the current position is inside the
intro range and jumps to its end when clicked. Do not document recap/credits UI
yet.

## Tests and verification

Automated:

```bash
cd server
npm run typecheck -w frontend
npm test -w frontend
```

Manual, using the Parks and Recreation season already warmed in
`server/.churn-cache/releases/introdb/tt1266020.json`:

1. Open an episode with cached segments. Seek into the intro: **Skip intro**
   appears above the controls; click it and playback continues at
   `intro.endSec`.
2. Seek before the intro and to its exact end: the button is absent at both.
3. Skip while paused: the video remains paused at the end of the intro.
4. Resume an episode whose saved position is already past the intro: no button.
5. Seek backwards into the intro after skipping: the button returns.
6. Switch quality mid-intro: playback resumes at the previous position and the
   button returns once `currentTime` is inside the range.
7. Open an episode with no cached segments (e.g. a show not grabbed since the
   IntroDB change): no button, no console errors.
8. Trigger a stream recovery: the button is suppressed until playback resumes.
9. Confirm Jellyfin progress after skipping (pause or leave the page) reflects
   the post-skip position, not the pre-skip time.

## Out of scope / follow-ups

- **Skip recap** (`segments.recap`) and post-credits UI.
- **Credits countdown** and next-episode overlay: owned by `churn-daog`, which
  consumes `segments.outro.startSec`.
- **Fullscreen support:** needs a custom control bar or fullscreen on the card
  container instead of the native `<video>` element. A keyboard shortcut for
  skip-intro could mitigate this cheaply, but it should be decided with the
  custom-controls work rather than added as a hidden binding now.
- **Warming on show-page open** for series downloaded outside Churn; still
  tracked in `churn-bhfb`.

## Files expected to change

- `server/frontend/src/pages/PlayPage.tsx`
- `server/frontend/src/lib/playback-segments.ts` (new)
- `server/frontend/src/lib/playback-segments.test.ts` (new)
- `docs/src/web-ui.md`
- `.beans/churn-bhfb--skip-intros-and-credits-using-introdb-segment-data.md`
