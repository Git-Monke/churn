---
# churn-mwoz
title: Remove unnecessary copy from login page
status: completed
type: task
priority: normal
created_at: 2026-11-15T18:49:07Z
updated_at: 2026-11-15T18:49:30Z
---

Remove the 'No people have been added yet...' empty-state text and the 'Sessions last 12 hours of inactivity and survive dashboard restarts.' footer from the login page.

- [ ] Remove empty-state paragraph in server/frontend/src/pages/LoginPage.tsx
- [ ] Remove session-lifetime footer in server/frontend/src/pages/LoginPage.tsx
- [x] Verify build/typecheck

## Summary of Changes

Removed the two lines of login-page copy: the "No people have been added yet. An admin can create them from the People page." empty-state paragraph and the "Sessions last 12 hours of inactivity and survive dashboard restarts." footer. Both removed from `server/frontend/src/pages/LoginPage.tsx`; `tsc --noEmit` passes and the page was verified in the running dev server.
