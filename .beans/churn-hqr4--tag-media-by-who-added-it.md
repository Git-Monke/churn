---
# churn-hqr4
title: Tag media by who added it
status: completed
type: feature
priority: normal
created_at: 2026-11-05T00:01:08Z
updated_at: 2026-11-05T02:48:37Z
---

Record the user that added each item to the library.

Plan: plans/added-by-tags.md (shared with churn-o0u5). Implemented.

## Todos
- [x] Add persisted media-attribution store
- [x] Record attribution on successful requests
- [x] Enrich library and requested-library responses
- [x] Remove attribution on delete/cancel
- [x] Add backend tests
- [x] Show added-by tag in the library card
- [x] Update docs

## Summary of Changes

- Added a persisted attribution store in `server/backend/src/media-attribution.ts`, saved to `<CHURN_STATE_DIR>/media-attribution.json` and keyed by TMDB/TVDB identity. Writes are atomic and serialized; corrupt files warn and start empty.
- `POST /api/requests` records the signed-in Jellyfin user on successful adds. `already_exists` never overwrites an existing tag.
- `GET /api/library` and `GET /api/library/requested` now include `addedBy`; both arr and Jellyfin delete paths clear attribution.
- Library cards show an "Added by <name>" line.
- Added `media-attribution.test.ts` and route coverage for tagging, no-overwrite and cancellation cleanup.
- Updated `docs/src/web-ui.md`.
