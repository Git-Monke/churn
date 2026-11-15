---
# churn-lhnh
title: Atomic .env rewrite drops the dashboard group
status: completed
type: bug
priority: normal
created_at: 2026-11-14T04:05:09Z
updated_at: 2026-11-14T04:05:13Z
---

Rerunning the installer or migrating storage leaves server/.env owned root:root 0640, so the dashboard (PUID:PGID) cannot read the Jellyfin API key. write_atomic renames a fresh inode and only preserves the mode, undoing envfile::share.

## Summary of Changes

- `envfile::write_atomic` now restores the target's uid/gid on the temporary inode before the rename, so a rewrite keeps the ownership `share` set.
- Regression test `envfile::tests::upserting_keeps_the_ownership_and_mode_of_the_file` uses a supplementary gid (the naive version passed even without the fix) and fails when the chown is removed.
- Repaired the live install on jarvis: `chown root:1003 /var/lib/churn/server/.env` + `chmod 640`, dashboard restarted and now reads /app/.env (no EACCES warning).
