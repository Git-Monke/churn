---
# churn-3t3r
title: Library search bar
status: completed
type: feature
created_at: 2026-11-05T00:01:08Z
updated_at: 2026-11-05T02:35:00Z
---

Search/filter the library by title (and other useful fields) without leaving the page.

## Summary of Changes

Frontend-only search box in the Library toolbar; no API or route changes.

- `server/frontend/src/features/library/library-search.ts` (new): `searchLibraryEntries(entries, query)`. Every whitespace-separated word must match; words hit title tokens, or fall back to year, network, content rating, score and overview. Accents and apostrophes are normalised (NFKD, same as the title matching used for activity). Title hits sort before metadata-only hits with a stable sort, so the existing activity/library ordering survives.
- `server/frontend/src/pages/LibraryPage.tsx`: search input (lucide search icon, clear button, Escape to reset) above the grid, using the existing `InputGroup` component. The Movies/Series tabs and their counts now follow the search, the header shows "N of M titles" while filtering, and the empty state says which query matched nothing and offers **Clear search**.
- `docs/src/web-ui.md`: documented the search behaviour.

Search state is local to the page and resets on reload; `#/search` (the upstream Prowlarr/Jellyfin search) is untouched.

Verified with `npx tsc --noEmit` and `npx vite build` in `server/frontend` (no frontend test suite exists).
