---
# churn-4qgy
title: Keep Churn motion usable in interrupted flows
status: completed
type: task
priority: normal
created_at: 2026-11-12T13:19:48Z
updated_at: 2026-11-12T13:26:55Z
---

Preserve Library position through playback, keep request and download failures in place, keep player feedback in fullscreen, handle rapid Back, and honor reduced motion in loading states.

## Summary of Changes

Preserved Library browsing state through playback, made request and release retries inline and keyboard-friendly, put fullscreen controls and playback settings in the player frame, and made loading indicators static under reduced motion. Verified live South Park playback, fullscreen settings, Library return and rapid Back, delayed details through a temporary proxy, and failure/retry focus with local fixtures. The frontend build and 48 tests passed.

Quality changes now retain the previous video source if the new request fails, with a retry inside the player frame. Verified both the failed switch and a retry against an isolated HTTP error fixture.
