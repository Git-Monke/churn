---
# churn-x7td
title: Add passkey sign-in and refine the login screen
status: in-progress
type: feature
priority: normal
created_at: 2026-11-12T13:23:14Z
updated_at: 2026-11-12T13:42:34Z
---

Add secure-origin WebAuthn with password fallback, enrollment and removal. Refresh the sign-in hierarchy and verify the flow.

Implemented in the separate `ui/passkey-login` worktree. The server and frontend test suites passed, including new persistence and origin checks. The browser test covered password sign-in, enrollment, repeated passkey sign-in, logout, and removal with an isolated Jellyfin fixture.

Pending review before committing and opening the PR. A live deployment requires setting Churn's exact HTTPS origin.

Local review preview is served at http://localhost:48132 with a throwaway Jellyfin fixture. Verified that the login page offers passkeys and the test password creates a session.

Added a visible Set up a passkey action that opens enrollment after password sign-in. Verified the path to Add passkey in Chrome and confirmed the frontend build and 48 tests pass.
