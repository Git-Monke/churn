---
# churn-wrvu
title: Redesign the player page
status: completed
type: feature
priority: normal
created_at: 2026-11-06T06:28:09Z
updated_at: 2026-11-06T06:48:32Z
---

Restyle the in-app player page (server/frontend) into a media page: video frame
under the header, one title row with metadata/synopsis plus Next and a
playback-settings menu, and in-frame overlays (buffering, up next, ended, error,
skip intro). No season list under the video, shipped theme kept, 3s countdown,
Skip intro kept.

- [x] Backend: PremiereDate in DETAIL_FIELDS, premiereDate + officialRating on PlaybackItem
- [x] Frontend types: two payload fields
- [x] Synopsis: lines + className props
- [x] features/player/playback-meta.ts + tests
- [x] PlaybackSettingsMenu + PlaybackTitleRow
- [x] PlayerOverlays + UpNextCard
- [x] Rewrite PlayPage layout, overlay state, 20s up-next trigger, next-without-watched, keyboard
- [x] typecheck + tests + build (frontend), tests (backend)
- [x] Live verification at 1440x900 and 390x844 via agent_browser

## Summary of Changes

- Backend `DETAIL_FIELDS` gained `PremiereDate`; `PlaybackItem` now carries
  `premiereDate` and `officialRating` (types + payload).
- `Synopsis` takes `lines` (default 4) and `className`.
- New `features/player/playback-meta.ts` (pure helpers: `upNextTriggerSeconds`,
  `playbackMinutes`, `episodeCode`, `formatClock`) with tests.
- New `PlaybackSettingsMenu` (quality, episode autoplay, start over) and
  `PlaybackTitleRow` (title, metadata line, synopsis, Next, settings slot).
- `PlayerOverlays` reworked for the in-frame overlays; `UpNextCard` gained a
  countdown and a Play now escape.
- `PlayPage` rewritten as frame + title row with buffering/ended/error/up-next
  state, a 20 s up-next trigger with a 3 s countdown, next-without-marking-watched
  for the explicit Next button, and `usePlayerShortcuts` keyboard support.
- The "Resumed at X:XX / Start over" toast was dropped after review: playback
  still resumes from the saved position, quietly, and the start-over escape
  lives in the settings menu.
- Page now opens with a `Back to <show>` link at the top-left (chevron +
  series name, falling back to the season/show/library label), so an episode
  leads back to its show instead of only to the library.
- Verified at 1440x900 and 390x844 against a local mock playback server.
