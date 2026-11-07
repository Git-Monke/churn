# Fire TV release (Fire OS + Vega OS)

## Goal

Ship a Fire TV client for churn, driven entirely by a remote's D-pad
(up/down/left/right, select, back, play/pause, rewind/forward), without
maintaining a second UI next to the React dashboard in `server/frontend`.

This is a research + design document. Nothing here is built yet.

## What exists today

- `server/frontend` — React 19 + Vite + Tailwind 4 + shadcn/Radix SPA.
  Hash-routed (`src/hooks/use-hash-route.ts`), TanStack Query for data,
  `hls.js` for playback, browser-default focus/pointer interaction.
- `server/backend` — Fastify BFF that also serves `frontend/dist`. Session
  cookie is `httpOnly`, `sameSite=lax`, `secure: auto`, sessions persist to
  `CHURN_STATE_DIR`. Jellyfin login (`/api/auth/login`) plus profile PIN login.
- Playback — `/api/playback/items/:id` returns a same-origin stream URL plus
  HLS/transcode URLs, `canBrowserDirectPlay()` decides direct play, and
  progress is reported back to Jellyfin so Continue Watching stays in sync.
- `usePlayerShortcuts()` already maps keyboard keys to player actions
  (`resolvePlayerShortcut`), which is the natural seam for remote input.

Reusable on TV with no backend change: library, Continue Watching, show/movie
detail, playback + reporting, auth/session, quality presets.

Not TV-appropriate as-is: Services/VPN and People pages (admin), the
request/download surfaces (Search → release picker → qBittorrent), hover
affordances, the pointer-first grid layout, and every text input.

## Platform landscape (verify on device before committing)

Fire TV is no longer one platform. New devices split across two OSes:

| | Fire OS | Vega OS |
| --- | --- | --- |
| Base | Android (Fire OS 7 ≈ Android 9, Fire OS 8 ≈ Android 11) | Linux, Amazon-built (2025+) |
| Package | `.apk` / `.aab` | `.vpkg` |
| UI tech | Android app, Amazon WebView (Chromium-derived, GPU-optimised) | React Native for Vega (RN 0.72 / 0.83) or Vega WebView (Chromium) |
| Sideload | Yes (`adb install`, Downloader app) | **No** — Amazon Appstore or `vega devmode` only |
| Typical devices | Fire TV Stick 4K Max, Fire TV Cube, older Sticks | Fire TV Stick 4K Select (2025), Fire TV Stick HD (2026) |

Both platforms accept a **web presentation layer**: Fire OS through a hybrid
Android app with a WebView (Amazon explicitly supports "HTML5 hybrid apps"),
Vega through the Vega WebView component. Amazon's *hosted/packaged web app*
submission format was deprecated in 2024, so the shell has to be a real app.

Both WebViews are Chromium, so `server/frontend` renders unchanged; what is
missing is TV behaviour, not TV rendering.

### Amazon constraints that shape the design

Shared by Fire OS WebView and Vega WebView:

- No multiline text boxes, no popups/`window.open()`, no file upload/download,
  no launching an external browser, no geolocation.
- System on-screen keyboard appears on text-field focus (works, but painful on
  a remote).
- D-pad keys arrive as DOM `keydown` with `ArrowUp/Down/Left/Right` (37–40) and
  `Enter` (13). Vega adds `GoBack` = 27 (needs `allowSystemKeyEvents: true`) and
  media keys 227/228/179. Fire OS delivers media keys to the activity/MediaSession
  first — the shell must forward or the page must use `navigator.mediaSession`.
- Vega WebView blocks cleartext HTTP from WebView 4.0.2 (RN 0.83) unless
  `manifest.toml` declares `[network-traffic-policy.cleartext]`; Fire OS blocks
  cleartext from Android 9+ unless the manifest opts in. A self-hosted server on
  `http://192.168.x.x` needs both.
- Neither platform can scope cleartext to "whatever LAN IP the user types":
  Android's network-security-config has no CIDR/wildcard domains, and Vega's
  policy is a domain allow/block list (Amazon lists "allow all HTTP" as a
  supported use case, so verify the exact allow-all syntax). Plan on a
  cleartext-allowed base config, and expect that to be questioned if the app ever
  goes to a store.
- Vega WebView has spatial navigation **on by default**; call
  `preventDefault()` on keydown to own focus yourself.
- Vega WebView media: HW H.264/H.265/VP8/VP9, no AV1 in the WebView list; audio
  FLAC/MP3/Opus/Vorbis/AAC/PCM — **no AC3/EAC3/DTS**, so those rips must be
  transcoded. Fire TV hardware happily decodes AC3/EAC3 through ExoPlayer, which
  a WebView `<video>` cannot use.
- Background/voice-search: the platform pauses video automatically; audio apps
  must pause themselves. Going to background releases the video decoder.

Appstore rules that matter:

- Video apps must hold the screen awake during playback, stop audio in the
  background, and pause/resume across HDMI hot-plug, input switch and TV power.
- Physical-device testing is mandatory; reviewers need working credentials and a
  reachable backend for end-to-end testing.
- Apps must do more than wrap a website, must not link to competing stores, and
  must degrade gracefully where a feature is unsupported.
- The content policy prohibits BitTorrent clients and "illegal downloaders".
  churn's request/download stack is exactly that surface, so the TV client has to
  be a **library + player** client. That is also the right 10-foot UX.
- Fire TV's home-row "Continue Watching" is Amazon's Content Personalization
  service (opt-in, backend sync). The Android TV `TvProvider` Watch Next
  database is not supported on Fire OS, so do not plan on it.

Design guidelines that become acceptance criteria: 1080p target, keep interactive
elements inside the inner 90% (5% overscan margin per edge), body text ≥ ~28px at
1080p, obvious focus state, no hamburger menus, focus memory when returning to a
row, and every actionable element reachable with the D-pad.

## Options considered

| | A. React Native for TV UI | **B. Web UI + TV mode + thin native shells** | C. Ship hosted/packaged web app | D. Browser only |
| --- | --- | --- | --- | --- |
| UI codebases | 2 (web + RN) | **1** | 1 | 1 |
| Rewrite cost | High — shadcn/Radix/Tailwind are DOM-only; ~3.3k lines of pages plus features | **Low–medium** — focus engine + TV layout + player keys | None | None |
| Playback | ExoPlayer (best codecs, AC3/EAC3 passthrough) | WebView `<video>`/hls.js first, native player as an escape hatch | WebView | Browser |
| Store | Yes (Fire OS APK, Vega `.vpkg`) | **Yes** (both) | Deprecated format | No store presence |
| Vega support | Yes (RN for Vega) | **Yes** (Vega WebView) | No | No |
| Sync risk | High (two UIs drift) | **Low** (one UI, shells hold zero UI) | Low | Low |

`react-native-tvos` (aliased through Expo's `with-tv` template) is a legitimate
path — it gives focus management and ExoPlayer for free — but it means porting the
whole dashboard to RN primitives and owning two designs. That is the exact
outcome the request is trying to avoid.

## Recommendation

**B: put TV support inside the existing web app, and keep the native shells
thin.** Fire OS and Vega both accept a Chromium WebView, so the dashboard renders
as-is; only behaviour changes. React Native is used only for the Vega *shell*
(Amazon's required app frame), never for UI.

Consequences:

- "Keeping the UI in sync" becomes a non-problem: there is one UI. TV mode is a
  presentation layer inside `server/frontend`, exercised every day by the normal
  web build.
- The shells contain no screens. They own: launch URL, server discovery/pairing
  glue, keep-screen-on, back/exit, media-session forwarding, and (later) a native
  player surface.
- The same approach fits the existing desktop-client bean (`churn-ppbr`): a
  Tauri/Electron shell around the same shared UI. One UI, three shells.
- Guardrails so TV mode does not rot: no forked TV components (only `tv:` styling
  and behaviour props), a `?tv=1` dev mode testable in any browser, a pure-function
  focus-graph test suite, and a tiny versioned JS bridge contract.
- Distribution is **sideload-first**: a signed APK built by CI, installed over ADB
  or the Downloader app, updated by the app itself from the churn server. The
  Appstore is optional and last, which takes the content-policy rejection (the
  torrent-client problem) off the critical path for Fire OS. Vega has no such
  escape hatch and stays store-only.
- A **companion keyboard** layer lets a phone type for the TV. It is web +
  backend only (WebSocket relay), so it lands before the shell and removes the
  worst part of text entry on a remote.

## Architecture

```
server/frontend/            server/backend/                  tv/
  src/tv/                     api/tv/*  (pairing)              fireos/   Kotlin WebView shell → APK
    remote-keys.ts            api/discovery (mDNS, phase 3)    vega/     RN for Vega + VegaWebView → .vpkg
    spatial-navigation.ts   (unchanged playback/auth)
    use-focusable.ts
  ?tv=1  →  <html data-tv="v1">
```

### TV mode inside the web app

- **Activation**: shell loads `http://<server>/?tv=1#/library`; the app writes
  `data-tv="v1"` on `<html>` and a Tailwind 4 custom variant
  (`@custom-variant tv (&:where([data-tv], [data-tv] *))`) exposes `tv:` styles.
  Fallback heuristic for manual testing: `matchMedia("(hover: none)")`.
- **Key layer** (`src/tv/remote-keys.ts`): one mapping from physical key codes
  (37–40, 13, 27/4, 179/85, 227/228, 89/90) to semantic actions, with `Backspace`
  also mapped to back for browser testing. Route-level handler decides what back
  means: player → previous route, show → season, root → "exit?" confirm.
- **Focus engine** (`src/tv/spatial-navigation.ts`): pure functions over measured
  `DOMRect`s — pick the nearest candidate in the pressed direction with row/column
  memory, wrap within rows (Amazon's 1D-list pattern), restore the last focused
  item per container. DOM glue lives in `use-focusable.ts` + a `FocusContainer`
  provider. No third-party dependency needed for the subset we need, but
  `@noriginmedia/norigin-spatial-navigation` is the fallback if the graphs get
  hairy — it covers web TV OSes and RN, so it would survive a later RN detour.
  `preventDefault()` on handled keys so Vega's built-in spatial navigation stays out
  of the way and behaviour is identical on both platforms.
- **Components**: reuse the shadcn primitives; add `tv:` focus ring, `tv:` size
  scale, hover styles moved behind `@media (hover: hover)`. Radix `DropdownMenu`
  becomes a focusable inline list in TV mode (popovers positioned off-screen are
  not reachable by a D-pad); `Dialog` gets a focus trap and initial focus.
- **Layout**: TV library page is rows (Continue Watching, Movies, Series) with a
  left nav rail, not the current filter+grid; detail pages keep one primary action
  row; text scales up; root padding 5vh/5vw for overscan; no small badges.
- **Player**: extend the existing `use-player-shortcuts` resolver rather than
  adding a second key system. Select toggles the overlay, ←/→ seek, play/pause
  toggles, back closes the overlay then leaves. Register
  `navigator.mediaSession` action handlers so remote media keys and Alexa media
  commands work, and pause on `visibilitychange`.
- **Scope gate**: in TV mode, hide People/Services/VPN and the request/download
  surfaces; Search stays as library search (no release picker). One flag in the
  route table, not a fork.

### Auth on TV: pairing, not typing

The current login (profile pick → PIN/password) is unusable with a remote.
Add a device-pairing flow:

1. Shell shows a setup screen → user enters the server URL (or picks it from
   mDNS discovery once that exists).
2. Web UI shows a 6-character code + QR (`#/pair`), large, TV-safe.
3. Phone/laptop, already signed in, opens `#/pair`, enters/scans the code and
   approves the device.
4. TV polls `GET /api/tv/pair/:code` → gets a device token (stored in
   `localStorage`, persisted server-side next to sessions) → normal session.

Backend: `POST /api/tv/pair/start` (unauthenticated, throttled like login),
`POST /api/tv/pair/:code/approve` (authenticated), `GET /api/tv/pair/:code`
(poll). Reuses the existing session store, so logout/expiry semantics stay
uniform, plus a device list with revoke in the web UI.

### Companion keyboard: the phone is the TV's keyboard

Pairing a device answers "which user is this TV?". This is a **second, separate
pairing**: "which phone types into this TV right now?". Conflating them makes
both worse — identity pairing is long-lived and account-bound, companion pairing
is a short-lived input channel.

| | Device pairing (auth) | Companion pairing (input) |
| --- | --- | --- |
| Question | Which user is this TV? | Which phone is typing here? |
| Lifetime | until revoked | one sheet / idle timeout (~10 min) |
| Credential | device session token | existing dashboard session cookie |
| Bound to | a Jellyfin user | one TV connection |

#### Transport

A small relay in the backend, because both sides already talk to the churn
server and the server is on the same LAN:

- `GET /api/tv/companion` (WebSocket) — TV side; authenticated by the TV session.
- `GET /api/tv/companion/phone?code=…` (WebSocket) — phone side; authenticated by
the normal dashboard session cookie.
- `@fastify/websocket` (the v11 line targets Fastify 5 — confirm the peer range
  when adding it) with the `{ websocket: true }` route option and the
  socket-first handler signature. One socket per side is enough for text today
  and leaves room for remote-control keys later. SSE + `POST` is the
  zero-dependency fallback if the plugin is unwanted, at the cost of a second
  endpoint per side.
- Channels live in memory only — no disk writes, which also matches the eMMC
  guidance for TV apps. Code: 6 characters from an unambiguous alphabet
  (no `0/O/1/I`), one phone at a time, single active sheet, closed on
  submit/cancel/TV disconnect/idle.

#### Message schema (v1, versioned like `ChurnNative`)

```ts
// TV -> server
type TvToServer =
  | { type: "hello"; code: string; field: FieldDescriptor }
  | { type: "field"; field: FieldDescriptor }   // next field, same channel
  | { type: "close" };                           // sheet dismissed

// server -> phone
type ServerToPhone =
  | { type: "state"; field: FieldDescriptor; tv: string }
  | { type: "phone-gone" };

// phone -> server
type PhoneToServer =
  | { type: "set"; value: string }   // throttled ~100 ms
  | { type: "submit" }
  | { type: "cancel" };

interface FieldDescriptor {
  id: string;              // stable per field instance
  label: string;
  kind: "text" | "password" | "url" | "search" | "code";
  value: string;           // current TV value (password: "")
  maxLength?: number;
  submitLabel?: string;
};
```

Server→TV mirrors `phone-connected`, `set`, `submit`, `cancel`, `phone-gone`.
Echo is not a problem: the TV field is not an `<input>`, so applying `set` cannot
re-trigger a change event.

#### TV side

- Every text field renders as a focusable **button-like card**, never an
  `<input>`. This is what keeps the Fire TV system keyboard from appearing; the
  system keyboard stays as an explicit fallback action.
- Select opens the companion sheet: a large QR (`http://<server>/#/type/<code>`)
  plus the code in huge type (scanning from 10 feet is a layout requirement, not
  a nicety), a state line (`Waiting for a phone…` / `Living Room iPhone`), and a
  `Use the TV keyboard` fallback.
- While the sheet is open the TV mirrors keystrokes live. Passwords show dots on
the TV and plain text on the phone. `submit` applies and closes.
- The channel survives the sheet for the session: a `phone connected` chip in the
  header, and the next field reopens the sheet already connected instead of
  showing a new code. Explicit disconnect in the header menu.
- Pre-login fields (server URL, password) have no server yet, so they cannot use
  the relay: those fall back to mDNS discovery or the system keyboard once.

#### Phone side

- `#/type/:code` — a minimal page with no dashboard chrome: field label, one
  large input (auto-focused, so the phone keyboard opens immediately), Send and
  Cancel. No app install, no account prompt (already signed in).
- `#/tv` — companion status: which TV is connected, what it is editing, unpair.
- Works over the LAN from the phone's normal browser; scanning the QR is the
  normal entry, typing the 6 characters is the fallback for phones without a
  camera.

#### Security

- The phone must hold a valid dashboard session — no anonymous text injection,
  even on the LAN.
- Codes are short-lived, unguessable, single-channel, and rate-limited like the
  login throttle. The TV shows who is connected before text arrives (the user is
  physically looking at the screen).
- v1 is text only. A later `key` message types remote-control commands into the
  TV and must be an explicit "use phone as remote" opt-in per session.
- LAN is plain HTTP: the trust boundary is the same as the dashboard itself. Do
  not add capabilities through the companion channel that the paired session
  does not already have.

#### Where it lives

- `server/backend/src/companion.ts` — hub + pure state machine (unit-tested).
- `server/backend/src/routes/companion.ts` — WS routes, session checks, throttle.
- `server/frontend/src/features/companion/` — TV sheet, phone page, and a
  `useCompanionField()` hook the TV inputs bind to.
- Shells: no changes. This is entirely web + backend, which is why it can land
  before or alongside the shell work.

#### Testing

- Unit: code alphabet, TTL, one-phone-only, submit/cancel, reconnect, `phone-gone`.
- Integration: fake TV socket + fake phone socket; assert mirroring, and that an
  unauthenticated phone is rejected.
- Manual: iOS Safari and Android Chrome against a real Stick, including the phone
  losing Wi-Fi mid-sheet.

### Shells

Fire OS (`tv/fireos`, Kotlin, Gradle):

- `WebView` full-screen, leanback launcher intent, `INTERNET` (+
  `ACCESS_NETWORK_STATE`, and `CHANGE_WIFI_MULTICAST_STATE` for discovery),
  `<base-config cleartextTrafficPermitted="true">` — the server URL is
  user-entered, so cleartext cannot be scoped to specific hosts.
- `FLAG_KEEP_SCREEN_ON` while the page reports playback; `MediaSession` forwarding
  or reliance on `navigator.mediaSession`; BACK handling driven by a JS
  `canGoBack` handshake, exiting only at the root.
- Setup screen (native, or a bundled local page served from assets) for the
  server URL, with mDNS discovery as the primary path, plus error/retry and
  switch-server for offline or moved servers.
- Two build flavours: `dev` (WebView debugging on, points at the Vite dev server
  `http://<laptop>:5173/?tv=1`, settings collapses to a dev panel) and `release`
  (saved server URL, debugging off, signed with the release key).
- Distribution: sideload-first with in-app updates (see the distribution
  section); Appstore submission stays optional and last.

Vega (`tv/vega`, RN for Vega 0.83):

- `manifest.toml`: `com.amazon.category.main`, media services,
  `[network-traffic-policy.cleartext]` in its allow-all form (the server URL is
  user-entered LAN HTTP, so a domain allowlist cannot work).
- `VegaWebView` with `hasTVPreferredFocus`, `allowSystemKeyEvents` (back = 27),
  `allowsDefaultMediaControl` when using `navigator.mediaSession`, `onMessage`/
  `injectJavaScript` bridge, `backgroundColor` set to avoid the white flash.
- Dev: Vega Studio + virtual device, `vega devmode login`/`enable-device` for a
  real Fire TV Stick 4K Select. Distribution: Appstore only.

Bridge contract (versioned, tiny):

```ts
window.ChurnNative = {
  version: 1,
  platform: "fireos" | "vega",
  keepScreenOn(on: boolean): void,
  exitApp(): void,
  getServerUrl(): Promise<string>,
  setServerUrl(url: string): Promise<void>,
  playNative?(payload: NativePlaybackRequest): void, // phase 3 escape hatch
};
```

Native→web stays `injectJavaScript`; web→native stays `postMessage`/
`addJavascriptInterface`. Document the contract in one place so a shell version
mismatch is detectable (`version`).

### Playback on TV

- Keep `/api/playback/*` unchanged so watched state, resume and Continue
  Watching stay identical across web and TV.
- Ship the WebView path first: direct play for MP4/H.264 + AAC, hls.js for
  transcodes. `canBrowserDirectPlay()` currently omits HEVC, so TV-ready HEVC
  titles transcode needlessly — add capability-aware codec reporting instead of a
  hard-coded set.
- Audio: Chromium has no AC3/EAC3/DTS. Rips with those tracks must transcode
  (video copy + audio transcode where Jellyfin allows) or use a native player.
- Default TV quality to a sensible cap (e.g. `high`) instead of `max`, and expose
  the existing quality picker through the remote-driven menu.
- Phase-3 escape hatch: native player (ExoPlayer on Fire OS, Vega media services)
  driven by the same web UI through `playNative()`; the web UI keeps the controls,
  the shell owns decoding. Only build this if the spike shows WebView playback is
  not good enough.

## Distribution: sideload-first, updates from the server

Decision: the Fire OS APK is the primary channel. The Appstore path stays
optional and last, because the content policy prohibits BitTorrent clients and
churn's server-side stack is exactly that. Sideloading is a documented Amazon
path, not a workaround.

### Getting the app onto a Stick

1. **ADB (developers, power users).** Settings → My Fire TV → About → press the
   device name 7× to reveal Developer Options → enable ADB Debugging (and Apps
   from Unknown Sources where the OS requires it). Then `adb connect <ip>:5555`,
   `adb install -r churn-tv-<version>.apk`, `adb shell am start -n
   com.churn.tv/.MainActivity`.
2. **Downloader app (no computer).** Typing a GitHub URL with a remote is
   miserable, so the dashboard serves a short LAN URL: `GET /tv/apk` → `302` to
   the release asset for the running server version (or streams it with a
   correct `Content-Type`). The user types `192.168.1.10:4000/tv/apk` once. The
   web UI also renders that URL as a QR so a phone can fetch the APK and send it
   over with a file-transfer app.
3. **Sideload visibility.** A `LEANBACK_LAUNCHER` intent plus a TV banner puts
   the app in the Fire TV apps row on recent Fire OS; older versions only list
   sideloaded apps under Settings → Applications → Manage Installed
   Applications. Verify per Fire OS version and document the fallback — no
   third-party launcher required.

### Dev loop: build locally, install on the Stick

This is the everyday loop, and it is the same path a user takes — no store, no
review, no waiting.

1. `cd server && npm run dev` — Vite on `5173` (already binds all interfaces:
   `server.host: true`) and the API on `4001`.
2. `cd tv/fireos && ./gradlew installDebug -PdevServer=http://<laptop-ip>:5173`,
   or `./gradlew assembleDebug` plus `adb connect <stick-ip>:5555` and
   `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
3. `adb shell am start -n com.churn.tv/.MainActivity`. The debug flavour skips
   the server picker and loads the dev URL with `?tv=1`.
   The WebView's `localhost` is the *TV*, not the laptop — use the laptop's LAN
   IP, or `adb reverse tcp:5173 tcp:5173` if the TV cannot reach the laptop
   (that makes it `http://127.0.0.1:5173` inside the WebView).
4. WebView DevTools: `WebView.setWebContentsDebuggingEnabled(true)` in debug
   builds only, then `chrome://inspect/#devices` in Chrome on the machine that
   has adb. Full DevTools, console and network for the TV page from the desk.
5. Hot reload: the TV UI lives in the web app, so Vite HMR + a page reload
   applies UI changes without reinstalling the APK. Only shell changes need
   `adb install -r` again.
6. Logs: `adb logcat -s ChurnTv chromium`; media state:
   `adb shell dumpsys media_session`; reset first-run with
   `adb uninstall com.churn.tv`.

Notes that will bite:

- Debug builds permit cleartext (`<base-config cleartextTrafficPermitted="true">`)
  so the laptop's `http://<ip>:5173` loads; release builds need the same for the
  user's LAN server.
- Debug builds enable WebView debugging; release builds must not.
- `versionCode` must increase between installs or `adb install -r` fails.
- If the TV is on a different VLAN from the laptop, `adb` works but the WebView
  cannot reach the dev server; use `adb reverse`.

### Signing and versioning

- One release keystore, base64 in CI secrets, never in git. The same
  `applicationId` + the same key forever, or updates fail with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
- `versionName` = churn version (`0.2.1`); `versionCode` = monotonic build number
  (`git rev-list --count HEAD` or date-based). The TV app's version should be
  readable from the shell bridge so the web UI can show it.

### In-app updates

- The TV app asks **its churn server**, not GitHub:
  `GET /api/tv/app` → `{ version, url, sha256, notes }`. The backend takes
  `version` from its own package version and `url`/`sha256` from the release
  asset for that version (GitHub by default, `TV_APK_URL` to override). This
  keeps the TV app and the server in lockstep the same way `src/update.rs`
  keeps the CLI and the dashboard image in lockstep.
- Shell-side updater: download to the app cache → verify the sha256 sidecar →
  `FileProvider` + `ACTION_INSTALL_PACKAGE` with `REQUEST_INSTALL_PACKAGES`.
  The system installer dialog is D-pad navigable; the user confirms. No silent
  install, and no `file://` URIs (`FileUriExposedException` on API 24+).
- Check on launch and from a Settings row. No background polling.
- Release assets: `churn-tv-<version>.apk` + `.sha256`, attached to the same
  GitHub release the CLI uses.

### CI

- `.github/workflows/tv-fireos.yml`: on tags, JDK + Android SDK,
  `./gradlew assembleRelease`, sign from secrets, upload the APK and checksum,
  and attach both with `softprops/action-gh-release` (same pattern as
  `release.yml`).

### The Vega caveat

- Vega dev builds exist (`vega devmode login`, then `enable-device --code` with a
  short-lived 6-digit code and an Amazon developer account), but that is a
  developer path, not distribution. Users on the newest sticks are
  Appstore-or-nothing. "Avoid the store" therefore solves Fire OS and does not
  solve Vega — say that plainly in the docs.

## Phases and exit criteria

0. **Spike (hardware, throwaway code).** Fire TV Stick 4K (Fire OS 8) and,
   optionally, a Vega Stick. Throwaway WebView shell pointed at the LAN
   dashboard. Measure: D-pad key codes, page load time, focus feasibility,
   H.264/HEVC/AC3/HLS playback, hls.js CPU/thermals on a 1–2 GB device, back
   behaviour. *Exit:* written verdict on WebView viability + whether a native
   player is needed.
1. **TV mode in the web app.** Focus engine + tests, key mapping, `?tv=1`,
   overscan/typography, library rows, TV-aware header, back semantics, player
   remote controls, hidden admin/request surfaces, dialogs/menus reachable.
   Text fields render as companion buttons from day one (system keyboard only as
   the fallback) so nothing has to be re-laid-out later.
   *Exit:* the whole library → show → play → back path works with arrow keys +
   Enter in a plain browser, at 1920×1080, with no mouse; focus-graph tests pass.
1b. **Companion keyboard.** WS relay + channel lifecycle, TV sheet (QR + code),
   phone `#/type/:code` page, `useCompanionField()`, warm-session reuse.
   *Exit:* search on the TV is typed entirely on a phone; unauthenticated and
   expired codes are rejected; unit + integration tests cover the lifecycle.
2. **Fire OS shell + device pairing.** Kotlin shell, manifest/cleartext,
   screen-on, back/exit, server URL setup, pairing endpoints + `#/pair` + device
   list. *Exit:* `adb install` on a real Stick, pair from a phone, play an
   episode, resume appears in the web UI's Continue Watching.
3. **Sideload pipeline + in-app update.** Release signing, `GET /tv/apk`, release
   workflow, `GET /api/tv/app`, shell updater (sha256 + installer intent).
   *Exit:* a tagged release produces an installable APK, a Stick running the
   previous version offers the update, installs it, and keeps its device pairing.
4. **Playback parity.** Capability-aware direct play, audio-transcode decisions,
   quality default, mediaSession polish, native player only if phase 0 demanded it.
5. **Vega shell (optional, store-only).** RN for Vega app, manifest/cleartext,
   Vega WebView, devmode device, Appstore submission with the playback-only
   scope.
6. **Release + docs.** `docs/src/fire-tv.md` (sideload install, pairing, "why not
   the Appstore", the Vega caveat), versioned releases, CI job wiring.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Appstore content policy reads the app as a torrent client | App rejected; Vega has no sideload fallback | TV build is library+player only; no torrent/request UI; get a policy read before investing in store metadata |
| "Just a website wrapper" rejection | App rejected | Native value is real: discovery/pairing, D-pad-first UX, screen-on/media integration, native player later; avoid an address-bar-shaped app |
| Reviewer cannot reach a self-hosted server (only if we ever submit to the store) | App rejected | Sideloading makes the store optional; if a listing is ever needed, host a demo instance with seeded content and credentials |
| Cleartext HTTP blocked (Vega 4.0.2+, Fire OS 9+) | App shows a blank page | `network-traffic-policy.cleartext` on Vega, network-security-config on Fire OS; test the exact failure path |
| Audio codec gaps (AC3/EAC3/DTS) in WebView | Silent or failed playback on common rips | Force audio transcode for those tracks; keep native player as phase-3 option |
| Weak hardware (1–2 GB RAM) | Janky 10-foot UI, hls.js CPU load | Measure in phase 0; avoid heavy animation/blur; default lower bitrate; consider native player |
| Vega-only new devices | New buyers cannot sideload an APK | Treat Vega (phase 4) as required for a "release", not optional |
| Text entry on a remote | Unusable login/search | Pairing flow + QR; library search only; keep the phone web UI for requests |
| Sessions are per-server | TV logs out when the server identity resets | Pairing persists in the store; verify survive restart/state-dir move |
| Signature drift between APK builds | Updates refuse to install (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) | One keystore in CI secrets, fixed `applicationId`, documented key recovery |
| Sideloaded app is hidden or warns "unknown source" | Users think install failed | Leanback launcher intent + banner; documented Settings → Manage Installed Applications path; verify per Fire OS version |
| No computer, no Downloader app | User stuck | Short `GET /tv/apk` LAN URL + QR for phone transfer; document both in the release notes |
| Companion pairing fails (phone offline, TV/phone network split, VLAN isolation) | Cannot type search/login | System-keyboard fallback stays wired up; mDNS/phone URL shown on the TV so the phone can be put on the same network |
| Companion channel is a text-injection path on the LAN | Someone else types into the TV | Phone must hold a dashboard session; short TTL, single-use-ish codes, throttle; TV shows the connected device name before text lands |
| Companion page grows into an unauthenticated remote | Scope creep, security | v1 is text only; a future `key` channel is a separate opt-in with its own bean |

## Open questions for the spike

- Do D-pad key codes and media keys arrive in the WebView exactly as documented
  on Fire OS 8 and Vega, including with a Bluetooth remote/game controller?
- Does Amazon WebView on Fire TV 4K hardware play HEVC in `<video>` (direct or
  via MSE), and what does `MediaSource.isTypeSupported` report?
- How bad is hls.js on a Fire TV Stick Lite / 4K Select (CPU, frame drops,
  startup time to first frame)?
- Does Vega WebView honour `localStorage` + cookies across launches for a
  self-hosted HTTP origin, and is `postMessage` reliable enough for the bridge?
- Can the Vega shell ship with `cleartext` broadly allowed, or does review
  require a static allowlist (which would break user-entered LAN IPs)?
- What exactly does the Appstore policy say about a *playback client* for a
  self-hosted Jellyfin library whose server also does torrenting?
- Is screen-on achievable purely from the page, or does the shell have to own it?

## Out of scope (for now)

- Fire TV home-row Continue Watching (Amazon Content Personalization, opt-in and
  backend-synced) — a later integration.
- Voice search/Alexa integration beyond platform media commands.
- Downloads/offline playback on TV (explicitly unsupported in both WebViews).
- Multiple profiles switching on TV (pairing binds one profile; switching can
  re-use the phone flow later).
- Phone-as-full-remote (nav/play-pause keys over the companion channel). v1 is
  text only; the transport and message envelope leave room for it.
- Appstore submission for Fire OS. Revisit only if the store ever becomes
  necessary (it never is for Fire OS: sideloading is supported).
- The native desktop client (`churn-ppbr`), which should adopt the same
  shell-plus-shared-UI pattern.

## Sources

Amazon (platform, WebView, design and store rules):

- Fire TV design and UX guidelines — https://developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html
- Web apps / HTML5 hybrid apps for Fire TV — https://developer.amazon.com/docs/fire-tv/getting-started-with-web-apps.html and https://developer.amazon.com/docs/fire-tv/hybrid-apps-overview.html
- React Native for Fire TV — https://developer.amazon.com/docs/fire-tv/get-started-with-react-native.html
- Vega WebView overview and guide — https://developer.amazon.com/docs/vega/2.0/overview-of-webview and https://developer.amazon.com/docs/vega/2.0/develop-your-app-with-webview
- Vega web app performance/focus best practices — https://developer.amazon.com/docs/vega/2.0/webview-development-best-practices-tv
- Vega developer mode — https://developer.amazon.com/docs/vega/2.0/developer-mode
- Appstore test criteria — https://developer.amazon.com/docs/app-testing/test-criteria.html
- Appstore presubmission checklist — https://developer.amazon.com/docs/app-submission/presubmission-checklist.html
- Appstore content policy — https://developer.amazon.com/docs/policy-center/understanding-content-policy.html

Sideloading, updater and companion transport:

- Connect to Fire TV through ADB — https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html
- Add TV support to an existing project (leanback manifest bits, banner) — https://developer.amazon.com/docs/fire-tv/add-tv-support-to-an-existing-react-native-project.html
- `PackageInstaller` — https://developer.android.com/reference/android/content/pm/PackageInstaller
- `FileProvider` — https://developer.android.com/reference/androidx/core/content/FileProvider
- `@fastify/websocket` — https://github.com/fastify/fastify-websocket

React Native TV alternative and libraries:

- `react-native-tvos` — https://www.npmjs.com/package/react-native-tvos
- Expo "Build apps for TV" — https://docs.expo.dev/guides/building-for-tv/
- Norigin Spatial Navigation — https://devportal.noriginmedia.com/docs/Norigin-Spatial-Navigation/

Repo-specific facts referenced above come from the code: `server/frontend/src/hooks/use-hash-route.ts`,
`server/frontend/src/features/player/use-player-shortcuts.ts`,
`server/backend/src/playback.ts` (`canBrowserDirectPlay`, `DIRECT_VIDEO_CODECS`),
`server/backend/src/auth.ts` (cookie options, persisted sessions),
`server/backend/src/routes/playback.ts` and `server/backend/src/lan.ts`.
