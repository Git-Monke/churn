---
# churn-27z7
title: Order download qualities downward from 1080p
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:01:11Z
updated_at: 2026-11-05T02:14:09Z
---

List order starts at 1080p and goes to lower qualities from there (720p, 480p, ...). 4K/2160p stays in the list but sits to the right of 1080p; it is never the default selected item.

## Summary of Changes

Quality tiers stay in ascending order (480p, 720p, 1080p, 2160p, Other) and the chooser now starts at 1080p, stepping down to 720p/480p when 1080p is missing. 4K remains in the list but is only selected when nothing at or below 1080p exists.

- `server/frontend/src/features/releases/ReleaseChooser.tsx`: `DEFAULT_TIER_PREFERENCE = [2, 1, 0, 3]` drives the default selection; tab order is unchanged.
- `docs/src/web-ui.md`: documented the ordering and default.

Verified with `npm run typecheck`, `npm run build` (frontend) and `npm test` (backend, 297 passing).
