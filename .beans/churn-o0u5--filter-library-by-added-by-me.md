---
# churn-o0u5
title: Filter library by 'added by me'
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:01:08Z
updated_at: 2026-11-05T02:48:37Z
---

Users can show only media they added themselves, using the added-by tag.

Plan: plans/added-by-tags.md (shared with churn-hqr4). Implemented.

## Todos
- [x] Add Added-by-me toggle to the library page
- [x] Compose with type tabs and empty state
- [x] Verify frontend typecheck/build

## Summary of Changes

- Added an "Added by me" toolbar toggle that composes with search and the All/Movies/Series tabs.
- Filtering uses the current session's Jellyfin user id; tab counts and the header count follow the filter.
- Added a dedicated empty state with a "Show everyone's library" action.
- Verified with full backend tests, workspace typecheck and production build.
