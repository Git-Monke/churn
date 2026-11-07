---
# churn-w1rj
title: Fire TV release (Fire OS + Vega OS)
status: todo
type: epic
priority: high
tags:
    - tv
    - fire-tv
    - playback
    - distribution
created_at: 2026-11-06T21:50:34Z
updated_at: 2026-11-07T00:40:27Z
---

## Goal

Ship a Fire TV client (Fire OS + Vega OS) that streams the library with only a
remote: up/down/left/right, select, back, play/pause, rewind/forward — without
maintaining a second UI alongside the web dashboard.


## Decision (proposed)

Build the TV experience **inside the existing web app** (`server/frontend` TV mode)
and keep the native shells thin, because both Fire OS (hybrid Android app with
Amazon WebView) and Vega OS (Vega WebView) render Chromium web content:

- Fire OS → Kotlin `WebView` shell → `.apk` (sideloadable)
- Vega OS → React Native for Vega + `VegaWebView` → `.vpkg` (Appstore only)

There is then exactly one UI. TV mode is a presentation layer in
`server/frontend` (focus engine, 10-foot layout, remote-driven player), and the
shells own only launch URL, discovery/pairing, keep-screen-on, back/exit and
(optionally later) a native player. React Native for the UI was rejected: it
would mean porting shadcn/Radix/Tailwind screens to a second design.

## Scope: library + player only

The TV build shows library, Continue Watching, show/movie detail and playback.
Services/VPN, People and the request/download surfaces stay on the web UI. This
is both the right 10-foot UX and the safer Appstore position: Amazon's content
policy prohibits BitTorrent clients, and the TV client must not look like one.

## Key constraints found in research

- D-pad arrives as `keydown` 37–40 / 13; Vega adds Back = 27 (needs
  `allowSystemKeyEvents`) and media keys 179/227/228. Fire OS delivers media keys
  to the activity first — forward them or use `navigator.mediaSession`.
- Both WebViews block cleartext HTTP (Vega WebView 4.0.2+/RN 0.83 via
  `[network-traffic-policy.cleartext]`, Fire OS 9+ via network-security-config).
  A self-hosted `http://192.168.x.x` server needs both configured.
- No multiline text boxes, no popups/`window.open`, no uploads/downloads in
  either WebView → login must be a pairing flow, not a password prompt.
- Vega WebView audio has no AC3/EAC3/DTS; those rips need an audio transcode (or
  a native player later). `canBrowserDirectPlay()` also omits HEVC today, so
  TV-capable files transcode needlessly.
- Fire TV design rules are acceptance criteria: 1080p, 5% overscan safe area,
  large type, obvious focus state, focus memory, every action D-pad reachable.
- Appstore: physical-device testing required, reviewer credentials required,
  video apps must keep the screen awake / stop audio in background / survive
  HDMI hot-plug. Vega has **no sideloading**, so Vega support is Appstore-or-none.

## Distribution decision

Sideload-first: signed APK from GitHub releases, installed over ADB or the
Downloader app, updated in-app from the churn server (`GET /api/tv/app` ->
sha256 -> system installer). The Appstore is optional and last, which removes
the torrent-client content-policy rejection from the Fire OS critical path.
Vega OS has no user sideloading, so Vega remains store-only.

## Phases

- [ ] 0. Spike on real hardware (Fire TV Stick 4K, optionally a Vega Stick): key
      codes, WebView playback (H.264/HEVC/AC3/HLS), hls.js perf, load time.
      Verdict on WebView viability + native-player need.
- [ ] 1. TV mode in `server/frontend`: focus engine + tests, key mapping,
      `?tv=1`/`data-tv`, overscan/typography, library rows, back semantics,
      remote-driven player, hidden admin/request surfaces.
- [ ] 1b. Companion keyboard: WS relay, TV sheet (QR + code), phone
      `#/type/:code` page, warm-channel reuse, system-keyboard fallback.
- [ ] 2. Fire OS shell (`tv/fireos`) + device pairing endpoints (`/api/tv/pair/*`,
      `#/pair`, device list/revoke) + server URL setup + screen-on + back/exit.
- [ ] 2b. Sideload pipeline + in-app update: release signing, `GET /tv/apk`,
      release workflow, `GET /api/tv/app`, shell updater (sha256 + installer).
- [ ] 3. Playback parity: capability-aware direct play (HEVC/AV1), audio
      transcode fallback, TV default quality, mediaSession polish; native player
      only if phase 0 demands it.
- [ ] 4. Vega shell (`tv/vega`, optional and store-only): RN for Vega +
      `VegaWebView`, manifest/cleartext, devmode device, Appstore submission.
- [ ] 5. Release + docs: user-facing Fire TV page in `docs/src` (sideload steps,
      Downloader URL, pairing, "why not the Appstore", Vega caveat).

## Risks

- Appstore may read the app as a torrent client → Fire OS ships by sideload, so
  the store is off the critical path; the TV build stays playback-only anyway.
- Sideload friction (developer mode, Downloader URL, install dialogs) → short
  `GET /tv/apk` URL, ADB instructions, in-app updates, QR for phone transfer.
- Signing drift breaks updates → one keystore in CI secrets, fixed app id.
- Vega has no sideload → newest sticks stay Appstore-only; documented plainly.
- Weak hardware (1–2 GB RAM) → measure hls.js/UI cost in phase 0, lower default
  bitrate, native player as escape hatch.
- Buyers of the newest (Vega) sticks cannot sideload → they stay uncovered until
  the store-only Vega phase lands; say so in the docs rather than implying
  universal support.

## Child beans

- churn-k9dp — Spike: Fire TV WebView shell and playback viability
- churn-drxi — Add TV mode (D-pad focus engine) to the web dashboard
- churn-dina — Companion keyboard: pair a phone to type into TV mode (blocked by TV mode)
- churn-6nfv — Device pairing auth for TV clients
- churn-s5r4 — Build the Fire OS (Android WebView) app shell (blocked by spike + TV mode)
- churn-9raa — Sideload distribution and in-app updates for the Fire TV APK (blocked by Fire OS shell)
- churn-6z2j — Build the Vega OS shell and Appstore submission (blocked by spike + TV mode + Fire OS shell)

Vega is store-only and optional; Fire OS ships by sideload.

## Design doc

`plans/fire-tv-release.md` — platform landscape, options matrix, architecture,
bridge contract, phases, risks, spike questions.
