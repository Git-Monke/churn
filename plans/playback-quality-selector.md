# Playback quality selector (churn-9hth)

## Context

A film that buffers badly on a poor connection currently has no escape hatch.
`GET /api/playback/items/:itemId` decides once between direct play and a Jellyfin
HLS transcode, and `buildJellyfinHlsUrl` pins that transcode to the source's own
bitrate and resolution (`server/backend/src/playback.ts`). A 40 Mbps remux
therefore either direct-plays (buffering) or transcodes at 40 Mbps (still
buffering). The player only reacts after a fatal HLS error by skipping ahead.

Goal: a quality picker in the player — **Max** (original), **High** (1080p,
10 Mbps), **Medium** (720p, 5 Mbps), **Low** (480p, 2 Mbps). Choosing one starts
a new Jellyfin stream with those caps and keeps the current position.

Confirmed decisions:

- Presets cap **bitrate and resolution**. Jellyfin downscales during the
  transcode it is already doing (FFmpeg scale filter driven by `MaxHeight`), so
  1080p→720p needs no extra source file and costs almost nothing on top of the
  H.264 encode.
- Start at **Max every time**; no persistence.
- Switching mid-playback rebuilds the stream in place and keeps the position.
- Only offer presets genuinely below the source bitrate; a source already
  lighter than every preset shows no picker.

## Approach

Keep the quality decision on the backend: it already owns the Jellyfin
`PlaybackInfo` call, the media source, and the HLS transcode URL. The frontend
only sends a preset id and renders what the backend advertises.

- `?quality=` on `GET /api/playback/items/:itemId`, defaulting to `max`. The
  route calls `getPlaybackInfo` per request (it already does), so every switch
  gets a **fresh `PlaySessionId`** — Jellyfin keys transcoding jobs by play
  session, and reusing one with different bitrate params can return the old
  job.
- `max` keeps today's behaviour: direct play when the browser can decode it,
  else HLS at the source bitrate/resolution. Every other preset always forces
  HLS (`playbackMethod: "hls"`, `directPlay: false`).
- The playback item response gains `quality` (what was applied) and
  `qualities` (what is selectable for this source), so the picker has one source
  of truth and no client-side tier table.
- The HLS route accepts the same `?quality=` and applies the preset caps to the
  Jellyfin transcode URL, clamped so it never exceeds the source.

### Presets (`server/backend/src/playback.ts`)

| id       | label  | max height | video bitrate |
| -------- | ------ | ---------- | ------------- |
| `max`    | Max    | source     | source (existing 1–20 Mbps clamp) |
| `high`   | High   | 1080       | 10 000 000 |
| `medium` | Medium | 720        | 5 000 000 |
| `low`    | Low    | 480        | 2 000 000 |

Rules:

- Effective height = `min(preset.height, source height)`; effective bitrate =
  `min(preset.bitrate, source bitrate)`. Never encode bigger than the source.
- `qualities` always includes `max`, then every preset whose effective bitrate
  is **strictly below** the source bitrate (source bitrate = `source.Bitrate ??
  video.BitRate ?? 8_000_000`, as today). A 3 Mbps source offers Max + Low; a
  1 Mbps source offers Max only and the picker hides.
- Each option carries a backend-formatted `detail` (e.g. `720p · 5 Mbps`) built
  from the *effective* caps, so the UI needs no formatting logic.
- `MaxHeight` stays the only scaling parameter (as today); Jellyfin derives the
  width from the aspect ratio. Keep `VideoCodec=h264`, `AudioCodec=aac`,
  `MaxAudioChannels=2`, `AudioBitrate=192000`, `SegmentContainer=ts`.

## Files to modify

- `server/backend/src/playback.ts` — `PlaybackQuality` type, `QUALITY_PRESETS`,
  `parsePlaybackQuality`, `availablePlaybackQualities`, preset-aware
  `buildJellyfinHlsUrl(..., quality)`, quality query in `playbackHlsPath`,
  `quality` + `qualities` on `PlaybackItem`/`mapPlaybackItem`, optional
  `playbackMethod` on reports so Jellyfin records `Transcode` instead of always
  `DirectPlay`.
- `server/backend/src/routes/playback.ts` — parse/validate `?quality=` on the
  item and HLS routes, force HLS for non-max, pass the preset into the URL
  builder, pass the reported play method through.
- `server/backend/test/playback.test.ts` — preset URL building (caps, clamping,
  max behaviour), availability filtering, quality parsing, report `PlayMethod`.
- `server/backend/test/routes.test.ts` — `?quality=medium` returns an HLS item
  with `quality=medium` in the stream URL, a fresh play session and only valid
  options; invalid quality → 400; HLS manifest honours the cap.
- `server/frontend/src/api/types.ts`, `server/frontend/src/api/client.ts` —
  quality types and `fetchPlayback(itemId, quality?)`.
- `server/frontend/src/pages/PlayPage.tsx` — picker + in-place switch.
- `docs/src/web-ui.md` — Playback section.
- `.beans/churn-9hth--bitrate-selection-while-playing.md` — completion note.

## Reuse

- `server/backend/src/playback.ts`: `pickMediaSource`,
  `canBrowserDirectPlay`, `buildJellyfinHlsUrl`, `mapPlaybackItem`,
  `assignIfDefined`, `clamp`.
- `server/backend/src/routes/playback.ts` — `parseOptionalSessionId`-style
  validation helper pattern for the new `quality` query.
- `server/frontend/src/components/ui/select.tsx` — same `Select` /
  `SelectTrigger`/`SelectContent`/`SelectItem` composition already used by
  `pages/ShowPage.tsx` for the season picker.
- `PlayPage.tsx` existing stream-rebuild machinery: the `recovery` state and the
  HLS effect keyed on `item.streamUrl` already recreate the pipeline at
  `targetTicks`. Generalise it to `restart` with a `reason` so the quality
  switch reuses that path without touching recovery counters/timers or showing
  the "Reconnecting playback" alert.
- `reportBody` / `reportPlaybackStart` for the new play session.

## Steps

- [x] **Backend presets.** Add `QUALITY_PRESETS` + `PlaybackQuality` to
  `playback.ts`; `parsePlaybackQuality(value)` (accepts `max|high|medium|low`,
  `undefined` → `max`, throws the standard `ApiError(400, "invalid_quality")`),
  and `availablePlaybackQualities(source)` returning `{id,label,detail}` with
  the source-relative filtering above. Export a helper for the effective
  height/bitrate so the URL builder and availability agree.
- [x] **HLS URL caps.** Extend `buildJellyfinHlsUrl` with a preset argument
  (default `max`): bitrate = `min(preset, source clamp)`, `MaxHeight` =
  `min(preset height, source height)`; keep the existing 240–2160 height and
  1–20 Mbps clamps for `max`, and apply the same `clamp` after min-ing presets.
- [x] **Stream paths** — `playbackHlsPath` gains the quality, emitting
  `quality=medium` only when it is not `max`, so existing URLs/route tests stay
  stable.
- `server/backend/src/routes/playback.ts`:
  - [ ] Parse `quality` on the item route; `directPlay` only when
    `quality === "max" && picked.directPlay && canBrowserDirectPlay(source)`.
  - [ ] Build `streamUrl` for HLS with the quality and the fresh play session;
    attach `quality` and `qualities` via `mapPlaybackItem`.
  - [ ] Parse `quality` on `/hls.m3u8`, pass it to `buildJellyfinHlsUrl`.
  - [ ] Pass `playbackMethod` through `parsePlaybackReport` /
  `playbackReportBodies` so `PlayMethod` is `Transcode` for HLS sessions.
- `server/frontend/src/pages/PlayPage.tsx`:
  - [ ] `const [quality, setQuality] = useState<PlaybackQuality>("max")`,
    reset on route `id` change; `useQuery(["playback", id, quality],
    () => fetchPlayback(id, quality), { placeholderData: (prev) => prev })` so
    the page never flashes back to the skeleton while switching.
  - [ ] Generalise `recovery` state to `{ itemId, targetTicks, attempt, reason }`
    with `reason: "error" | "quality"`, and reuse it for both paths. HLS effect
            and `handleCanPlay` already seek/play from `targetTicks`.
  - [ ] Add a `pendingSeekTicks` ref for the direct-play path so switching back
     to Max seeks to the stored position when the new `<video src>` loads
     (`handleLoadedMetadata` currently only applies Jellyfin's resume point).
  - [ ] On switching: stash `positionRef.current`, set the restart with reason
     `quality`, and once the new item is active send `POST /start` with the new
     `playSessionId`/`mediaSourceId` at the current position; send a
     fire-and-forget `stop` for the previous play session so Jellyfin does not
     keep a phantom stream. Keep `stoppedRef` semantics for the final stop.
  - [ ] UI: a row under the video (`flex flex-wrap items-center gap-2`) with
     `Quality` label + `Select` (hidden when `qualities.length <= 1`), the
     selected option's `detail` as muted text, and a `Switching quality…`
    indicator while `quality !== item.quality`. Map the HLS alert copy to the
    selected preset (`Streaming at Medium — 720p · 5 Mbps`).
  - [ ] Reset `recoveryRef`, `mediaIssue`, resumed flags per item as today; the
    existing fatal-error recovery keeps working on top of any chosen quality.

## Verification

- `cd server/backend && npm test` — new/updated `playback` and `routes` tests.
- `npm run typecheck -w backend`, `npm run typecheck -w frontend`,
  `cd server/frontend && npx vite build`.
- Manual (needs the real stack, e.g. `docker compose` in `server/`):
  1. Play a high-bitrate (4K/hevc) title: picker shows Max/High/Medium/Low, Max
     behaves as before.
  2. Pick Medium mid-playback: position is preserved, the "Switching quality…"
     notice appears and clears, playback continues, Jellyfin's dashboard shows
     one transcode at ~5 Mbps / 720p, and the old session disappears.
  3. Switch to Low and back to Max; if the source direct-plays, playback
     resumes at the same position from the original file.
  4. Play a ~2 Mbps 720p title: only Max (and possibly Low) is offered; a
     ~1 Mbps title hides the picker entirely.
  5. Let a session go idle after switching and confirm progress/watched state
     still lands on the last position.
- Docs: re-read the Playback section to confirm the new params and behaviour are
  described, and lint links/line width the same way as the rest of the file.
