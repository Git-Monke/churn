---
# churn-k9dp
title: Spike Fire TV WebView shell and playback viability
status: todo
type: task
priority: high
tags:
    - tv
    - fire-tv
    - playback
    - spike
created_at: 2026-11-06T21:50:58Z
updated_at: 2026-11-06T21:50:58Z
parent: churn-w1rj
---

## Goal

Decide, with measurements, whether a Chromium WebView can carry the TV UI and
playback on real Fire TV hardware — or whether a native player is required.

## Why

The whole architecture (`plans/fire-tv-release.md`) assumes one React UI rendered
in a WebView on Fire OS and Vega OS. That assumption fails if D-pad keys do not
arrive in the page, if hls.js cannot keep up on a 1–2 GB device, or if the codecs
we care about need ExoPlayer.

## Work

- [ ] Get a Fire TV Stick 4K (Fire OS 8) into developer mode; `adb connect`.
      Optionally a Fire TV Stick 4K Select (Vega) for the Vega half.
- [ ] Throwaway Kotlin `WebView` shell (not merged) pointed at the LAN dashboard,
      plus a Vega "WebView" template app if a Vega device is available.
- [ ] Record actual D-pad/Enter/Back key codes reaching `keydown`; check media
      keys (play/pause, rewind, fast-forward) with and without `mediaSession`.
- [ ] Playback matrix on device: H.264/AAC MP4 direct, HEVC MKV, AC3/EAC3 audio,
      forced HLS transcode. Note `canPlayType`/`isTypeSupported` results.
- [ ] Measure: cold start to usable library, 1080p UI smoothness while scrolling
      rows, hls.js CPU/thermals, time to first frame, behaviour after
      background/voice-search.
- [ ] Verify cleartext HTTP works once configured (Fire OS network-security-config;
      Vega `[network-traffic-policy.cleartext]`) and what the failure looks like.
- [ ] Check cookie/localStorage persistence across app restarts for an HTTP origin.

## Deliverable

A verdict section appended to `plans/fire-tv-release.md` (or its own note):
WebView viable yes/no, required native player yes/no, min device spec, and the
adjusted key-code table.
