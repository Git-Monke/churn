---
# churn-z490
title: Default to 1080p when choosing download quality
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:01:11Z
updated_at: 2026-11-05T02:14:09Z
---

1080p is the default selected quality when browsing seasons/movies to download, when 1080p is available.

## Summary of Changes

The release chooser now auto-selects 1080p when that tier has releases, instead of the highest available tier (which used to default to 4K).

- `server/frontend/src/features/releases/ReleaseChooser.tsx`: replaced `defaultTier`'s "highest known tier" logic with an explicit preference order (1080p → 720p → 480p → 2160p → other).
- `docs/src/web-ui.md`: documented the default tier behaviour.

Verified with `npm run typecheck`, `npm run build` (frontend) and `npm test` (backend, 297 passing).
