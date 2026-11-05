---
# churn-yh7c
title: Resume interrupted installs
status: todo
type: feature
priority: normal
created_at: 2026-11-05T05:17:26Z
updated_at: 2026-11-05T05:18:14Z
---

When the installer runs, persist a session (chosen stacks, answers, completed steps). On a later run, detect the unfinished session, ask whether to resume, and continue from the first unfinished step instead of re-asking everything.

## Todo

- [ ] Add a session module that persists stacks, answers and step progress under the churn root
- [ ] Ask to resume a detected session at installer start
- [ ] Skip completed stack writes, starts and Jellyfin setup on resume
- [ ] Clear the session on success and on a declined resume
- [ ] Add tests for session persistence and resume validation
- [ ] Document resume behavior in README
