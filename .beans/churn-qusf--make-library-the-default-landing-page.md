---
# churn-qusf
title: Make library the default landing page
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:01:11Z
updated_at: 2026-11-05T02:21:00Z
---

Start on the library, not the services page.

## Summary of Changes

- `server/frontend/src/hooks/use-hash-route.ts`: an empty hash (bare URL) and an
  unrecognised hash now resolve to `library` instead of `services`. Explicit
  `#/services` still works, so the services page is unchanged for anyone who
  navigates to it.
- `docs/src/web-ui.md`: documented that an empty or unknown hash lands on the
  library.

Verified with `npx tsc --noEmit` in `server/frontend`.
