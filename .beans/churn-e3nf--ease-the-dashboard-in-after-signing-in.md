---
# churn-e3nf
title: Ease the dashboard in after signing in
status: completed
type: feature
priority: normal
created_at: 2026-11-23T17:18:36Z
updated_at: 2026-11-23T17:19:45Z
---

After an active sign-in, the dashboard's header and content should ease in rather than snap into place.

Implemented as a CSS-only motion: a `signedIn` flag from AuthProvider tags the dashboard root with `motion-signin-arrive`; keyframes stagger the header and main. A restored session does not animate or flash. Honors `prefers-reduced-motion`.

Supersedes the WAAPI component from PR #4 (malpern:ui/signin-arrival), which also carried stale pre-passkey code.



## Summary of Changes

- `server/frontend/src/features/auth/AuthProvider.tsx`: exposes `signedIn`, set only by `applySession` (an active sign-in); a restored session leaves it false. Main's `clearSession` 401 handling is untouched.
- `server/frontend/src/App.tsx`: the dashboard root adds `motion-signin-arrive` when `signedIn`.
- `server/frontend/src/index.css`: `churn-signin-arrive` 520 ms fade plus 8 px rise, 60 ms stagger on `<main>`; reduced motion falls back to a 160 ms fade.
- The PR branch's WAAPI `SignInArrival` component is gone; no JS animation code remains.

Verified with `npm run typecheck`, `npm test` (49 tests, 7 files), and a Vite dev-server CSS fetch.
