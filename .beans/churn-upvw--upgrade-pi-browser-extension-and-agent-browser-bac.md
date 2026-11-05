---
# churn-upvw
title: Upgrade pi, browser extension and agent-browser backend
status: completed
type: task
priority: normal
created_at: 2026-11-05T22:19:56Z
updated_at: 2026-11-05T22:21:36Z
---

## Summary of Changes
- Global pi upgraded 0.83.0 -> 1.5.0 (`npm i -g @earendil-works/pi-coding-agent@latest`); installed pi now exports `buildSessionProjection`, so the extension's `session_start` hook no longer crashes.
- Extensions updated via `pi update --extensions`: pi-agent-browser-native 0.7.1 -> 0.9.16 (its `MINIMUM_PI_VERSION` is 1.5.0).
- Upstream `agent-browser` CLI installed globally (0.41.2) — it was never present, which is why browser commands could not run at all.
- Verified after restarting pi: `agent_browser read/open/snapshot` work against a real managed Chrome session (`snapshot -i` returned `link "Learn more" [ref=e1]`), `close` cleaned up, and `pi-agent-browser-doctor` passes (agent-browser 0.41.2, Pi 1.5.0, no duplicate sources).

## Deferred
- Extension declares `engines.node >= 24.21.0`; nvm Node is v24.14.1 (npm EBADENGINE warning only, doctor and runtime fine). Bumping Node requires reinstalling global npm packages because pi lives under the v24.14.1 prefix. Candidate for a follow-up bean.
