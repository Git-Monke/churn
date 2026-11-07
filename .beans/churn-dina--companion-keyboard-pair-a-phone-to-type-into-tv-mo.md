---
# churn-dina
title: 'Companion keyboard: pair a phone to type into TV mode'
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - companion
    - frontend
    - backend
created_at: 2026-11-07T00:40:12Z
updated_at: 2026-11-07T00:40:12Z
parent: churn-w1rj
blocked_by:
    - churn-drxi
---

## Goal

Pair a phone to the TV session and use the phone's keyboard for every text field
in TV mode: search, server URL, login fallback, dialogs.

## Why

Typing with a D-pad is the worst part of a TV client, and the Fire TV system
keyboard is only marginally better. A phone already has a keyboard, a session,
and is usually in the user's hand. This is the difference between "search works"
and "nobody searches".

## Design (details in `plans/fire-tv-release.md`)

- Separate from device pairing (`churn-6nfv`): pairing authorises a
  device; this binds a phone to a TV's text input for a short session.
- Transport: two WebSocket endpoints on the existing backend
  (`@fastify/websocket` v11): `/api/tv/companion` (TV) and
  `/api/tv/companion?role=phone`. Channel keyed by a 6-char unambiguous code,
  in-memory, idle TTL ~10 min, one phone at a time, single active sheet.
- Messages: `hello/field/close` (TV), `state` (server→phone), `set/submit/cancel`
  (phone), `phone-connected/set/submit/cancel/phone-gone` (server→TV). Versioned.
- TV side: text fields are buttons, never `<input>` (this is what keeps the
  system keyboard away). Select opens the companion sheet: QR
  `http://<server>/#/type/<code>`, huge code, state line, and a
  "Use the TV keyboard" fallback. Password: dots on TV, plain on phone.
  A warm channel is reused for the next field (no re-pairing per field).
- Phone side: `#/type/:code` minimal page (no chrome, autofocused input, Send /
  Cancel), plus `#/tv` status/unpair.

## Work

- [ ] Backend: `companion.ts` hub with a pure, tested state machine (code
      alphabet excludes 0/O/1/I; TTL; single phone; submit/cancel; reconnect).
- [ ] Backend routes: WS upgrade with session check (TV session / phone cookie),
      per-code + per-IP throttle, no persistence.
- [ ] Frontend: `features/companion/` — TV sheet, phone page, `useCompanionField()`
      hook; wire into TV-mode text fields (search first, then any dialog input).
- [ ] QR generation without a heavyweight dependency; verified scannable at
      10 feet on a 1080p TV (size/contrast, phone camera test).
- [ ] Fallback path: system keyboard stays reachable everywhere; sheet never
      traps a user who has no phone.
- [ ] Pre-login: server URL and password cannot use the relay (no server yet) —
      discovery + system keyboard only, documented.
- [ ] Tests: unit (lifecycle/TTL/auth rejection) and an integration test with a
      fake TV socket + fake phone socket.

## Verification

On a Stick: press Select on search, scan the QR from a phone, type the query on
the phone, see it mirror on the TV instantly, submit, results appear. Kill the
phone's Wi-Fi mid-sheet → TV shows disconnected and offers the system keyboard.

## Notes

Backend + phone page can be built before TV mode lands; the TV sheet needs
`churn-drxi`. Text only — phone-as-remote (nav/media keys) is a later bean.
