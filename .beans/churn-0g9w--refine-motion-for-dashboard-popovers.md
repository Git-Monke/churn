---
# churn-0g9w
title: Refine motion for dashboard popovers
status: completed
type: feature
priority: normal
created_at: 2026-11-12T12:29:09Z
updated_at: 2026-11-12T12:31:44Z
---

Refine the shared popover used by Request options and release indexer status.

- [x] Make the reveal feel anchored to its trigger and keep dismissal quick.
- [x] Honor reduced motion and verify focus, dismissal, and rapid reopening in a browser.

## Summary of Changes

Tuned the shared Radix popover reveal and dismissal in CSS. Reduced motion uses a short fade. Verified the Search page with mocked API responses in Chromium and passed the frontend build and tests.
