---
# churn-6nfv
title: Device pairing auth for TV clients
status: todo
type: feature
priority: high
tags:
    - tv
    - fire-tv
    - auth
    - backend
created_at: 2026-11-06T21:50:59Z
updated_at: 2026-11-06T21:50:59Z
parent: churn-w1rj
---

## Goal

Let a TV sign in without typing a password on a remote.

## Why

The current login is profile pick + PIN/password (`/api/auth/login`,
`/api/auth/profile-login`). On a remote that is unusable, and both Fire TV
WebViews make text entry slow. Pairing also gives us a revocable device
credential, which a browser cookie does not.

## Flow

1. TV (setup screen) shows the server URL and a 6-character code + QR.
2. Phone/laptop already signed in opens `#/pair`, enters/scans the code, approves.
3. TV polls, receives a device token, and continues as the paired user.

## Work

- [ ] Backend: `POST /api/tv/pair/start` (unauthenticated, login-style throttle),
      `POST /api/tv/pair/:code/approve` (authenticated), `GET /api/tv/pair/:code`
      (poll). Short TTL, single use, rate limited.
- [ ] Persist device sessions next to existing sessions (`CHURN_STATE_DIR`) so a
      server restart does not log every TV out; verify existing persistence path.
- [ ] Web UI: `/tv` pairing page (`#/pair`) reachable from the existing app;
      show/approve/deny; list paired devices and revoke.
- [ ] TV side: code display screen + polling, then hand off to the normal session.
- [ ] Session semantics: TV logout revokes its own token only; revoked/expired
      device shows a clear re-pair screen instead of a generic login form.

## Notes

No changes to `churn`'s installer or to Jellyfin auth. Password login stays
available on TV as a fallback path for anyone without a second device.

## Verification

Unit tests for code generation/expiry/single-use; a backend integration test that
pairs, uses the token, and confirms it stops working after revocation.
