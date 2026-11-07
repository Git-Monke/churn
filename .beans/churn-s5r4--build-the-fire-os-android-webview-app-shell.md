---
# churn-s5r4
title: Build the Fire OS (Android WebView) app shell
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - android
    - fireos
created_at: 2026-11-06T21:50:59Z
updated_at: 2026-11-07T00:40:24Z
parent: churn-w1rj
blocked_by:
    - churn-k9dp
    - churn-drxi
---

## Goal

A Fire OS app that opens the TV-mode dashboard full screen and behaves like a
Fire TV app: launch from the home row, D-pad + Back, screen stays awake during
playback, no address bar, survives server restarts.

## Why

Fire OS devices accept an ordinary Android app, so it can be installed straight
over ADB or the Downloader app — no store review, no content-policy risk. It is
the lowest-risk way to get a real, icon-on-the-launcher TV client while the web
UI does the work.

## Work

- [ ] `tv/fireos/` Gradle project: single `WebView` activity, leanback launcher
      intent (`LEANBACK_LAUNCHER`, launcher entry only), touchscreen not required,
      TV banner (320×180) so the app is reachable from the home row.
- [ ] Manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE`,
      and `<base-config cleartextTrafficPermitted="true">` — the server URL is
      user-entered, and Android network-security-config cannot express CIDR or
      wildcard hosts, so cleartext cannot be scoped to the LAN only.
- [ ] Setup screen (native or bundled local page): server URL entry, optional LAN
      discovery, connection test with a clear error + retry.
- [ ] WebView wiring: JS enabled, DOM storage, cookie persistence, no external
      browser hand-off, load `http://<server>/?tv=1#/library`.
- [ ] Back: JS handshake (`canGoBack`) → navigate page history; at the root show
      the "exit app?" confirm; never silently kill a running playback.
- [ ] Playback: `FLAG_KEEP_SCREEN_ON` while the page reports playback, release it
      on pause/stop/background; pause video when the app loses focus (platform
      already pauses, verify UI state); stop audio on voice-search/background.
- [ ] Bridge: implement `window.ChurnNative` v1 (`keepScreenOn`, `exitApp`,
      `getServerUrl`/`setServerUrl`, `appVersion`) over `addJavascriptInterface` +
      `evaluateJavascript`, versioned so the web app can detect a stale shell.
- [ ] Build flavours: `dev` (skips the server picker, loads
      `http://<laptop>:5173/?tv=1`, WebView debugging on) and `release` (saved
      server URL, debugging off, release key). Document the loop: npm dev →
      `./gradlew installDebug` → `adb shell am start` → `chrome://inspect`.
- [ ] WebView debugging only in debug builds (`setWebContentsDebuggingEnabled`).
- [ ] Errors: offline/HTTP/SSL error pages that offer retry and switch-server.

## Verification

`adb install` on a real Fire TV Stick 4K: launcher icon appears, first run asks
for the server, pairing works, an episode plays with the remote only, Back exits
sensibly, resume point shows up in the web UI.

## Distribution

Sideload first — the delivery pipeline (release signing, `GET /tv/apk`, in-app
updates, CI) lives in `churn-9raa`; this bean only has to produce a debuggable
debug build and a releaseable app. The Appstore is not planned.
