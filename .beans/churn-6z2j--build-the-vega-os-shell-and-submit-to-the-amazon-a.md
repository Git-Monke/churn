---
# churn-6z2j
title: Build the Vega OS shell and submit to the Amazon Appstore
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - vega
    - distribution
created_at: 2026-11-06T21:50:59Z
updated_at: 2026-11-06T21:51:01Z
parent: churn-w1rj
blocked_by:
    - churn-k9dp
    - churn-drxi
    - churn-s5r4
---

## Goal

Ship the same TV-mode dashboard on Vega OS devices (e.g. Fire TV Stick 4K Select),
where Android APKs cannot run and sideloading is blocked.

## Why

New Fire TV hardware is Vega-only, so a Fire OS-only client leaves new buyers
stranded. Vega has no sideload path: this ships only through the Amazon
Appstore, which makes it as much a submission problem as a build problem.

## Work

- [ ] `tv/vega/` React Native for Vega app (RN 0.83 line) using the Vega WebView
      template; keep it to a shell — no UI beyond setup/errors.
- [ ] `manifest.toml`: `com.amazon.category.main`, media services required for
      playback, and `[network-traffic-policy.cleartext]` for self-hosted HTTP
      servers (WebView 4.0.2+ blocks cleartext without it).
- [ ] `VegaWebView`: `hasTVPreferredFocus`, `allowSystemKeyEvents: true` (Back =
      27), `allowsDefaultMediaControl` + `navigator.mediaSession` handlers,
      `backgroundColor` set to avoid the white flash, `onMessage`/
      `injectJavaScript` bridge matching `window.ChurnNative` v1.
- [ ] Setup screen: server URL + pairing; error states from `onError`/
      `onHttpError`/`onSslError` with retry/switch-server.
- [ ] Background handling per Vega guidance: stop video and return to the detail
      page when the app backgrounds (the decoder is released and the first frame
      back can be black for a few seconds).
- [ ] Dev loop: Vega Studio + virtual device, `vega devmode login` and
      `enable-device` for real hardware; document the sideload-free iteration.
- [ ] Store submission: listing, screenshots, reviewer credentials/instructions,
      and a content-policy read before investing in metadata.

## Risks

- Content policy review: distribution is app-store-only, so a rejection means no
  client on that hardware. The app must not read as a torrent client (TV mode
  already hides request/download surfaces).
- WebView feature gaps (no multiline text, no WebGL reliance, no external
  browser) — TV mode avoids them; verify on device.
- `.vpkg` builds need Amazon credentials → build locally/manually, not in CI.
- Audio: the Vega WebView media stack has no AC3/EAC3/DTS; verify transcoded
  audio and HDR titles on the target device.

## Verification

Installs on a Vega Fire TV Stick via `vega devmode`, pairs, plays an episode with
the remote only, and Back exits sensibly.
