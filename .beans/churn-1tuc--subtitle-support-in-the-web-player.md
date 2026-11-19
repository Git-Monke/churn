---
# churn-1tuc
title: Subtitle support in the web player
status: in-progress
type: feature
priority: normal
tags:
    - frontend
    - playback
    - subtitles
created_at: 2026-11-10T00:13:01Z
updated_at: 2026-11-19T07:54:52Z
---

## Goal

Let a viewer pick a subtitle track while playing, and turn subtitles off, from the
web player — for both direct play and HLS transcode.

## Why

Jellyfin already delivers subtitle streams with every item, but nothing in our UI
exposes them. Watching a foreign-language film currently means leaving the app.
The `<video>` element in `server/frontend/src/pages/PlayPage.tsx:1100` has no
`<track>` children and `PlaybackSettingsMenu` (`server/frontend/src/features/player/PlaybackSettingsMenu.tsx`)
only offers quality, autoplay and start-over.

## Current state

Sidecar subtitles ship; burn-in does not. A viewer can pick any text track from
the player settings and turn it off again. Bitmap subtitle streams are not
listed, so nothing offers a track the browser cannot draw.

## Work

- [x] Backend: `PlaybackItem.subtitles` (`index`, `title`, `language`, `url`)
      built from text subtitle streams in
      `server/backend/src/playback.ts` (`mapSubtitles`); bitmap codecs
      (`hdmv_pgs_subtitle`, `dvd_subtitle`) are skipped.
- [x] Backend: same-origin WebVTT proxy
      `GET /api/playback/items/:itemId/subtitles/:index?mediaSourceId=…` in
      `server/backend/src/routes/playback.ts`, backed by
      `JellyfinClient.getSubtitle`; the Jellyfin token stays in the backend.
- [x] Frontend: Off/each-track radio group in `PlaybackSettingsMenu`, wired
      through `PlayPage` like `onQualityChange`.
- [x] Frontend: `<track kind="subtitles">` children on the `<video>`; selection
      flips `video.textTracks[i].mode` and is re-applied when a quality switch
      refetches the item (`PlayPage.tsx`).
- [x] Sidecar sync through seek is the browser's job; a quality switch reloads
      the same `<track>` URL, so cues stay aligned with the new stream.
- [x] TV mode: the picker reuses the existing `DropdownMenu` (`churn-drxi`), so
      the D-pad already reaches it.
- [ ] Persist the choice per title/series and default to the forced track or the
      user's language. Currently each playback starts with subtitles off.
- [ ] Backend (deferred): bitmap tracks burn in via `SubtitleMethod=Encode` +
      `SubtitleStreamIndex` on the transcode URL, restarting playback at the
      current position. Not built for now.

## Deferred: burn-in

Burn-in is deliberately out of scope until a bitmap-subtitle item shows up.
It is not just a URL flag: direct play must flip to HLS, the transcode must run
at source caps (`qualityTranscodeCaps(source, "max")`), and the restart path
must reuse the quality-switch machinery (`qualitySwitchRef` / Jellyfin session
stop + start at the same ticks). A probe of _3 Body Problem_ Season 1 found
every subtitle track was `subrip` (text), so sidecars cover the current library;
only PGS/DVDSUB discs would need the follow-up.

## Verification

Done: backend tests cover text-track mapping (bitmap skipped) and the WebVTT
proxy route (`server/backend/test/playback.test.ts`,
`server/backend/test/routes.test.ts`); `npm run typecheck` passes in both
workspaces; frontend `test` and `build` pass. The Jellyfin
`/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.vtt` endpoint was
probed directly against the live server and returns `text/vtt`.

Still manual: with a text-subtitle file, pick each track, confirm cues render
and seek correctly; switch quality with subtitles on, confirm they survive;
confirm Off hides them.
