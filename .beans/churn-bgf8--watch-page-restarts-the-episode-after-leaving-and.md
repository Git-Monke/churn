---
# churn-bgf8
title: Watch page restarts the episode after leaving and returning
status: completed
type: bug
priority: normal
created_at: 2026-11-13T19:07:26Z
updated_at: 2026-11-13T19:10:37Z
---

Autoplay (and Play now / end-of-file advance) opens the next episode as `#/play/<id>?restart=1`. That instruction must be one-shot, but it stays in the browser history entry, so leaving the player and coming back (back navigation, or a stale tab reload) re-reads `restart=1` and starts the episode over instead of resuming where the viewer stopped.

Fix: consume the flag when the player mounts — strip `restart` from the hash (keeping `source`/`show`/`season`) and hold the intent in a ref for the load handler, so the URL never re-executes it.

- [x] Add `stripRestartParam` to `use-hash-route.ts` with tests
- [x] Consume `restart` on mount in `PlayPage` and use a ref in the resume logic
- [x] Update README/docs wording for the one-shot restart
- [x] Typecheck + frontend tests

## Summary of Changes

`stripRestartParam` in `server/frontend/src/hooks/use-hash-route.ts` removes the one-shot `restart` parameter from a hash while keeping `source`/`show`/`season`. `PlayPage` consumes it on mount: the intent moves into `startAtBeginningRef` and the hash is rewritten, so the history entry (and any later reload of it) resumes at the saved position instead of starting the episode over. Covered by new cases in `server/frontend/src/hooks/use-hash-route.test.ts`; docs updated in `docs/src/web-ui.md` and `server/README.md`.
