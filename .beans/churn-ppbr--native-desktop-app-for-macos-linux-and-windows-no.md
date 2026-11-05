---
# churn-ppbr
title: Native desktop app for macOS, Linux and Windows (no transcoding)
status: todo
type: feature
priority: normal
tags:
    - playback
    - streaming
created_at: 2026-11-05T17:21:57Z
updated_at: 2026-11-05T17:21:57Z
---

## Goal

Ship native desktop clients so users can stream their library without the server
transcoding.

## Why

The web player in `server/frontend` can only play what the browser can decode.
Anything else falls back to a Jellyfin HLS transcode (`server/backend/src/playback.ts`,
`playbackMethod: "hls"`), which costs CPU and drops quality. A native app can
direct-play far more codecs/containers (MKV, HEVC, AV1, DTS/TrueHD passthrough,
bitstream audio to a receiver) than any browser, using the same HTTP API the
dashboard already calls.

## Scope

- One codebase, three targets: macOS, Linux, Windows (e.g. Tauri or Electron — decide in a spike).
- Reuse the existing dashboard UI where practical; a native shell around the current
  React app plus a native media path (MPV/libmpv or the platform video surface) is the
  least duplicative option.
- Login/profile flow: reuse `/api/auth/*` session cookies or mint a device token.
- Playback: fetch `/api/playback/:id` and prefer direct play whenever the native
  decoder supports the source, falling back to the existing HLS transcode only when
  it cannot.
- Progress reporting must keep using `/api/playback/:id/report` so resume/Continue
  Watching keeps working across web and native clients.
- Packaging/signing/auto-update story, and a way to point the app at a churn server
  (LAN IP, Tailscale/MagicDNS name, or a user-entered URL).

## Todos

- [ ] Spike: compare Tauri vs Electron vs a native player shell; pick one and record the decision
- [ ] Decide the code-sharing strategy with the existing web dashboard (shared components vs a thin independent client)
- [ ] Implement direct-play detection and a native playback surface with HLS fallback
- [ ] Implement server discovery / manual URL entry and auth
- [ ] Wire start/progress/stop reporting so Continue Watching works from native
- [ ] Build, sign and package installers for macOS, Linux and Windows
- [ ] Add a `churn` docs page and release pipeline for the desktop builds
