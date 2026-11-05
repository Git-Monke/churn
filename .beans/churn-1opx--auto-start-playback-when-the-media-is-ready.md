---
# churn-1opx
title: Auto-start playback when the media is ready
status: completed
type: bug
priority: normal
created_at: 2026-11-05T19:32:44Z
updated_at: 2026-11-05T19:33:14Z
---

Opening the player creates the stream but leaves the video paused until the user presses play. Start playback once the source is ready, while still preserving intentional pauses across quality switches and recovery.

## Summary of Changes

- Direct-play videos call `play()` after metadata and resume seeking.
- Native HLS starts on `loadedmetadata`; hls.js starts on `MANIFEST_PARSED`.
- Existing paused quality switches and recovery behaviour are unchanged; a
  browser autoplay rejection still leaves the native controls available.
