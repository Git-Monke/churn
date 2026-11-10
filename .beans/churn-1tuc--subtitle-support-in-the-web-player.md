---
# churn-1tuc
title: Subtitle support in the web player
status: todo
type: feature
priority: normal
tags:
    - frontend
    - playback
    - subtitles
created_at: 2026-11-10T00:13:01Z
updated_at: 2026-11-10T00:13:01Z
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

## Current state (verified)

- `server/backend/src/playback.ts` already reads `MediaStreams` for the video
  stream (bitrate/height at lines 189/199) but never looks for subtitle streams,
  and `PlaybackItem` carries no subtitle field.
- `buildJellyfinStreamUrl` (~line 390) and `buildJellyfinHlsUrl` (`playback.ts:418`)
  send `MediaSourceId`/`PlaySessionId` but no `SubtitleStreamIndex` /
  `SubtitleMethod`.
- Routes live in `server/backend/src/routes/playback.ts`: `/stream` at :250,
  `/hls.m3u8` at :185.
- Frontend types: `PlaybackItem` in `server/frontend/src/api/types.ts:700+`.

## Work

- [ ] Backend: add `subtitles: { index, language, title, codec, isExternal,
      isForced, isHearingImpaired, isText }[]` and `selectedSubtitle?: number` to
      `PlaybackItem` (backend + `api/types.ts`), built from
      `source.MediaStreams.filter(Type === "Subtitle")`.
- [ ] Backend: accept `?subtitle=<streamIndex|off>` on `GET /api/playback/items/:itemId`
      and on `/stream` + `/hls.m3u8`, same pattern as `?quality=` and validated
      the same way (`parsePlaybackQuality`, `availablePlaybackQualities`).
- [ ] Backend: text tracks (srt/ass/vtt, embedded or external) → serve as sidecar
      WebVTT through a same-origin proxy route (Jellyfin's
      `/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.vtt`), so the
      Jellyfin token never reaches the browser — mirroring `/stream`.
- [ ] Backend: bitmap tracks (PGS/DVDSUB) cannot be converted, so they must burn
      in via `SubtitleMethod=Encode` + `SubtitleStreamIndex` on the transcode URL,
      which implies an HLS/direct playback restart at the current position.
- [ ] Frontend: subtitle section in `PlaybackSettingsMenu` (radio group: Off /
      each track with language + forced/HI/bitmap badges), wired through
      `PlayPage` like `onQualityChange`.
- [ ] Frontend: sidecar tracks become `<track kind="subtitles">` on the `<video>`
      and are re-attached after a quality switch re-creates the element; select
      the active track through `video.textTracks`.
- [ ] Persist the choice per title/series (localStorage, mirroring the autoplay
      preference) and default to the forced track or the user's language.
- [ ] TV mode: the picker must be reachable with the D-pad — reuse the existing
      `DropdownMenu` (see `churn-drxi`), no new key system.
- [ ] Subtitles must stay in sync after seek and after a transcode/quality
      restart; no drift.

## Verification

Manual: a film with embedded SRT and one with PGS — pick each, confirm render and
seek sync; switch quality with subtitles on and confirm they survive; Off works.
`npm run typecheck` / `test` / `build` in `server/` stay green, plus backend tests
for the stream→dropdown mapping and the `?subtitle=` validation.
