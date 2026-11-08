---
type: Runtime Workflow
title: Playback and streaming
description: How the dashboard prepares a playable item, chooses direct play versus HLS transcoding, redirects to Jellyfin with the user's token, reports watch progress, and adds next-episode and IntroDB skip segments.
tags: [playback, streaming, hls, jellyfin, player, introdb]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-9d4c49a42098926e3b2997fd
    resource: repo://server/backend/src/introdb-warm.ts
  - id: openwiki-source-4241c9f211a877c34e07be04
    resource: repo://server/backend/src/introdb.ts
  - id: openwiki-source-e45b86b677c84e41121079ec
    resource: repo://server/backend/src/next-episode.ts
  - id: openwiki-source-c1f8414e6eb28384093a4f90
    resource: repo://server/backend/src/playback.ts
  - id: openwiki-source-d15edd9c57083cc8510023cd
    resource: repo://server/backend/src/routes/playback.ts
  - id: openwiki-source-3fa2b491a4b0996cf98fb6e9
    resource: repo://server/frontend/src/features/player/playback-meta.ts
  - id: openwiki-source-ce9cf39f67441f8aa54b8fa8
    resource: repo://server/frontend/src/pages/PlayPage.tsx
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Playback and streaming

Playback is a collaboration between the backend (`server/backend/src/playback.ts`, `routes/playback.ts`) and the SPA player (`server/frontend/src/pages/PlayPage.tsx`). The backend does not proxy video bytes; it resolves playback metadata, chooses a method and quality, and returns same-origin endpoints that redirect to Jellyfin with the signed-in user's token. The browser then talks to Jellyfin directly.

This keeps large video transfers out of Node while still hiding upstream URLs and API keys from the UI.

## Playback item resolution

`GET /api/playback/items/:itemId` requires a session and validates the id against `[A-Za-z0-9-]{1,64}`. It:

1. Fetches the Jellyfin item and playback info in parallel using the user's token and device id.
2. Maps an upstream 401 to `{ state: "unauthorized" }`, a 400/404 to `404 item not found`, and other failures to `{ state: "unreachable" }`.
3. Picks a media source: the first source with an `Id`, otherwise the first source. `PlaySessionId` comes from Jellyfin.
4. Computes available quality tiers for that source.
5. Chooses the method:
   - direct play only when the requested tier is `max`, Jellyfin says `SupportsDirectPlay`, **and** the browser can decode the codecs;
   - HLS otherwise.
6. Builds a same-origin stream path (`/stream` or `/hls.m3u8`) — this URL never contains the Jellyfin token.
7. Adds best-effort optional data: the next episode and IntroDB segments.

`mapPlaybackItem` returns `null` for anything that is not a Movie or Episode. The response includes title metadata, runtime/position ticks, image URL, `playbackMethod` (`direct` or `hls`), the effective `quality`, the list of selectable qualities and the session/source ids.

### Browser direct-play is stricter than Jellyfin's flag

`canBrowserDirectPlay` ignores Jellyfin's `SupportsDirectPlay` unless the actual streams are browser-safe:

| Component | Allowed |
| --- | --- |
| Container | `mp4`, `m4v`, `mov`, `webm` |
| Video codec | `h264`, `avc1`, `vp8`, `vp9`, `av1` |
| Audio codec | `aac`, `mp3`, `opus`, `vorbis`, `flac`, `pcm` |

This prevents an HEVC/AC3 MKV from being handed to a browser that cannot decode it.

## Quality presets

`QUALITY_PRESETS` defines four tiers:

| Tier | Caps |
| --- | --- |
| `max` | Original file; direct play when possible, otherwise source-bitrate transcode |
| `high` | 1080p, 10 Mbps |
| `medium` | 720p, 5 Mbps |
| `low` | 480p, 2 Mbps |

`qualityTranscodeCaps` never exceeds the source: a 10 Mbps tier on a 3 Mbps file encodes at 3 Mbps, and a 1080p tier on a 720p file stays at 720p. Caps are clamped to 240–2160p and 1–20 Mbps.

`availablePlaybackQualities` always includes `max` and only adds tiers whose bitrate is strictly lower than the source, so a low-bitrate file may show no picker at all. Invalid `quality` query values return `400 invalid_quality`.

## Stream and HLS redirects

Two redirect endpoints exist:

- `GET /api/playback/items/:itemId/stream` → `302` to Jellyfin's `/Videos/:id/stream` with `static=true`, `mediaSourceId`, `playSessionId` and `api_key`.
- `GET /api/playback/items/:itemId/hls.m3u8` → `302` to Jellyfin's `/Videos/:id/master.m3u8`.

Both resolve a missing media source/session by asking Jellyfin for playback info first. The HLS URL always sets explicit transcode parameters — `VideoCodec=h264`, `AudioCodec=aac`, `MaxAudioChannels=2`, `AudioBitrate=192000`, `MaxHeight`, `VideoBitrate`, `SegmentContainer=ts` — because Jellyfin otherwise falls back to a very small default transcode profile. `buildJellyfinStreamUrl` and `buildJellyfinHlsUrl` concatenate strings rather than using `new URL("/...")` so a public base path survives.

The redirect location contains the Jellyfin token (needed for direct browser access); Churn's own `streamUrl` does not.

## Playback reporting

The player reports to three authenticated endpoints:

- `POST /api/playback/items/:itemId/start`
- `POST /api/playback/items/:itemId/progress`
- `POST /api/playback/items/:itemId/stop`

`parsePlaybackReport` accepts only `positionTicks` (non-negative safe integer), `playSessionId`, `mediaSourceId`, `isPaused` and `playbackMethod` (`direct` or `hls`); unknown keys are ignored and invalid values return `400 invalid_playback_report`.

`playbackReportBodies` maps the Churn report to Jellyfin's shapes and records `PlayMethod: "Transcode"` for HLS versus `"DirectPlay"` otherwise, so the Jellyfin dashboard does not claim the original file is being streamed. The routes return `204` on success and map Jellyfin failures through the normal upstream error handler.

On the client, `PlayPage` reports every 1 second and debounces seek reports by 500 ms, so a killed tab loses at most about a second of position. Periodic reports are the only ones dropped under backpressure; pause and seek reports always go out. The player also has a bounded HLS recovery ladder that skips 5, 15 then 30 seconds to get Jellyfin to restart a transcode past a damaged section.

## Resume position and next episode

`resumeStartSeconds` in `features/player/playback-meta.ts` decides where to start:

- `restart=1` or an already-played item starts at 0:00.
- A saved position within 30 seconds of the end also starts over.
- Otherwise playback resumes at the saved tick position.

Next episode:

- The backend caches per-series episode lists for 60 seconds (maximum 100 series) and coalesces concurrent lookups. Failures are not cached.
- `pickNextEpisode` orders episodes by season then episode and returns the first one after the current `(season, episode)`.
- Season 0 specials stay in season 0; a special never rolls into season 1, and a normal season never rolls into specials.
- The player shows a 3-second up-next countdown, triggered at the earlier of the outro marker or 20 seconds before the file ends, and only arms automatically after natural playback (not after a seek).

## IntroDB skip segments

The dashboard uses IntroDB's public segment API for intro, recap, outro (`credits`) and post-credits ranges:

- `fetchIntroDbSegments` validates an IMDb id (`tt` plus 7–8 digits), season and episode, calls `/segments`, treats HTTP 404 as "no data" and validates each range in milliseconds.
- `IntroDbService.warmFromGrab` runs after a successful grab: it resolves the series' IMDb id from the media cache or Sonarr, then fetches and caches segments for one episode or every episode of a season, sequentially and without blocking the grab.
- `IntroDbService.segmentsFor` is a pure cache read. The playback route never calls IntroDB synchronously; the enrichment is optional and a failure only omits the segments.

`PlayPage` uses the intro range for the Skip Intro button and the outro range for the up-next trigger.

## Player controls and preferences

- `hls.js` is imported dynamically only for HLS items; direct items use the native `<video>` element.
- Keyboard shortcuts are resolved by `use-player-shortcuts.ts` and are suppressed in text inputs, content-editable elements, the `<video>` element itself and open overlays.
- Quality and autoplay preferences persist in `localStorage` under `churn:play:quality` and `churn:play:autoplay`.
- The player can return to the originating season via the `from` context encoded in the play hash.

## Relevant tests

`server/backend/test/playback.test.ts` covers quality presets and caps, available tiers, direct-play codec checks, URL construction, next-episode ordering, report validation and reporting bodies. `server/frontend/src/features/player/playback-meta.test.ts` covers resume and up-next timing, and `use-player-shortcuts.test.ts` covers shortcut suppression.

## Related pages

<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard frontend](/openwiki/dashboard/frontend.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/library-and-requests.md] link "/openwiki/dashboard/library-and-requests.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Library browsing, search and requests](/openwiki/dashboard/library-and-requests.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Authentication, sessions and household profiles](/openwiki/dashboard/auth-and-profiles.md)
