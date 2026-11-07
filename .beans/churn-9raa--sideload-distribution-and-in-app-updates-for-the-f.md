---
# churn-9raa
title: Sideload distribution and in-app updates for the Fire TV APK
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - distribution
    - android
created_at: 2026-11-07T00:40:12Z
updated_at: 2026-11-07T00:40:12Z
parent: churn-w1rj
blocked_by:
    - churn-s5r4
---

## Goal

Make the signed Fire TV APK installable and updatable without the Amazon
Appstore: local dev builds, release builds published as GitHub release assets,
and the app updating itself from the churn server.

## Why

The Appstore's content policy prohibits BitTorrent clients, and churn's server
stack is exactly that, so a store listing is the wrong critical path. Sideloading
is a supported Amazon path on Fire OS, so the app can ship to users directly.
This bean owns the whole delivery path: build, sign, publish, install, update.

## Install paths

- **ADB** (dev + power users): Developer Options → ADB Debugging, `adb connect
  <ip>:5555`, `adb install -r churn-tv-<version>.apk`, `am start`.
- **Downloader app** (no computer): the dashboard serves `GET /tv/apk` → `302` to
  the release asset for the running server version, so the user types a short
  `192.168.1.10:4000/tv/apk` instead of a GitHub URL.
- **Phone transfer**: the dashboard renders the APK URL as a QR; phone downloads
  it and sends it to the TV with a file-transfer app.
- Sideloaded apps need a `LEANBACK_LAUNCHER` intent + TV banner to appear in the
  apps row; older Fire OS only lists them under Settings → Manage Installed
  Applications. Verify per version and document.

## Work

- [ ] `tv/fireos` app id `com.churn.tv`, `versionName` from the churn version,
      `versionCode` monotonic (`git rev-list --count` or date-based).
- [ ] Release keystore generated once, stored base64 in CI secrets (never in
      git); document recovery, because a new key breaks every installed app.
- [ ] `.github/workflows/tv-fireos.yml`: on tags → JDK + Android SDK →
      `./gradlew assembleRelease` → sign → upload `churn-tv-<version>.apk` +
      `.sha256` → attach with `softprops/action-gh-release` (same pattern as
      `release.yml`).
- [ ] Backend `GET /tv/apk`: redirect (or stream) the release asset matching the
      running server version; `Cache-Control: no-store`.
- [ ] Backend `GET /api/tv/app`: `{ version, url, sha256, notes }`, version from
      the server's own package version, URL overridable with `TV_APK_URL`.
- [ ] Shell updater: download to cache → verify sha256 → `FileProvider` +
      `ACTION_INSTALL_PACKAGE` with `REQUEST_INSTALL_PACKAGES` (no `file://`
      URIs). Check on launch + a Settings row; no background polling.
- [ ] Keep the device pairing across an update (token in app storage, not wiped
      by `adb install -r`).
- [ ] Docs: sideload steps, the Downloader URL, "why not the Appstore", and the
      Vega caveat (no user sideloading on Vega — store only).
- [ ] `adb install -r` dev loop documented (`assembleDebug`, LAN IP vs
      `adb reverse`, `chrome://inspect` for WebView DevTools).

## Verification

On a real Stick: install from a GitHub release asset by both paths; the previous
version detects the new one, verifies its checksum, installs through the system
dialog, relaunches, and is still paired.

## Depends on

The Fire OS shell (`churn-s5r4`). Content of this bean can be prepared in
parallel once the package id and signing approach exist.
