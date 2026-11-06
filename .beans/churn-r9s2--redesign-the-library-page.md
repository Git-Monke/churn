---
# churn-r9s2
title: Redesign the Library page
status: completed
type: feature
priority: normal
created_at: 2026-11-05T22:58:49Z
updated_at: 2026-11-06T00:16:07Z
---

## Plan (approved: plans/library-redesign-implementation.md)
- [ ] Add shadcn components (dropdown-menu, toggle-group, toggle, avatar) + fonts
- [ ] index.css: fonts + content width token (keep existing shadcn palette)
- [ ] App.tsx shell: full-bleed header + max-w-content main
- [ ] AppHeader rewrite (wordmark, Library / Find something new, account menu)
- [ ] library-entries: recency sort
- [ ] ContinueWatching (mock data) + OnTheWay components
- [ ] LibraryGrid rewrite (toolbar + cards, no badges) + LibraryPage composition
- [ ] Replace local Progress with shadcn progress; remove unused imports
- [ ] typecheck, tests, build
- [ ] Visual verification at 1440px and 390px

## Deferred (per user)
- Backend resume route (Jellyfin UserItems/Resume) + DateCreated mapping for recency sort: mock data on the frontend for now.
