---
# churn-9hth
title: Bitrate selection while playing
status: completed
type: feature
created_at: 2026-11-05T00:01:08Z
updated_at: 2026-11-05T18:34:00Z
---

Offer lower bitrates when a film is buffering badly on a poor connection (quality/bandwidth adaptation).

## Summary of Changes

A **Quality** picker in the player with `Max` (original), `High` (1080p,
10 Mbps), `Medium` (720p, 5 Mbps) and `Low` (480p, 2 Mbps). Picking a tier
starts a new Jellyfin transcode at the current position without reloading the
page.

- `server/backend/src/playback.ts`: `PlaybackQuality`/`PlaybackQualityOption`,
  `QUALITY_PRESETS`, `parsePlaybackQuality`, `qualityTranscodeCaps` and
  `availablePlaybackQualities`. Presets clamp to the source (never encode above
  it) and are hidden when the source bitrate is already below them, so a 1 Mbps
  file shows no picker. `buildJellyfinHlsUrl` takes the preset and caps
  `MaxHeight`/`VideoBitrate`; `playbackHlsPath` appends `quality=`. Playback
  items now carry `quality` + `qualities`, and reports accept a
  `playbackMethod` so Jellyfin records `Transcode` for HLS sessions instead of
  always `DirectPlay`.
- `server/backend/src/routes/playback.ts`: `?quality=` on the item and HLS
  routes (invalid values → 400 `invalid_quality`). Non-max qualities always
  transcode, and the item route re-reads `PlaybackInfo`, so every switch gets a
  fresh `PlaySessionId` (Jellyfin keys transcode jobs by session).
- `server/frontend/src/pages/PlayPage.tsx`: `Select` under the video; switching
  keeps the position and paused state, rebuilds the HLS pipeline, stops the old
  Jellyfin session, starts the new one, and shows a "Switching quality…"
  indicator. Failed switches revert the picker with a toast. Alert copy names
  the active preset.
- Tests: preset URL caps/clamping, availability filtering, quality parsing,
  report `PlayMethod`, and route coverage for `?quality=medium` + invalid
  quality.
- Docs: `docs/src/web-ui.md` playback section and endpoint table.

Verified with `npm test` (backend, 308 tests), `npm run typecheck` for both
workspaces and `npx vite build`. Mid-playback switching still needs a manual
check against a real Jellyfin stack.
