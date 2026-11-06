---
# churn-az6p
title: Give the dev server its own port so it can coexist with the dashboard container
status: completed
type: bug
priority: normal
created_at: 2026-11-06T05:32:56Z
updated_at: 2026-11-06T05:34:30Z
---

Running `npm run dev` in server/ fails with EADDRINUSE on 127.0.0.1:4000 because the deployed dashboard container (docker compose, network_mode: host, PORT=4000) already holds the port. Move the dev backend to 4001 by default and point the Vite /api proxy there so dev and the installed dashboard can run at the same time. Update docs.

## Summary of Changes

- `server/backend/package.json`: the `dev` script now runs `PORT=${PORT:-4001} tsx watch src/index.ts`, so development defaults to 4001 while an explicit `PORT` still wins. `start`/production keeps 4000.
- `server/frontend/vite.config.ts`: the `/api` proxy target is built from `process.env.PORT` with a 4001 fallback, so the proxy follows the backend instead of hardcoding 4000.
- Docs (`README.md`, `server/README.md`, `docs/src/server.md`, `docs/src/web-ui.md`): dev API URL is 4001, with a note on why it differs from the container's `DASHBOARD_PORT` and how `PORT` moves both.

Verified: `npm run dev` starts the backend on 127.0.0.1:4001 and Vite on 5173 with the proxy reaching `/api/auth/session` (200/401 as expected) while the existing dashboard container keeps 4000; `PORT=4055 npm run dev` moves backend and proxy together. `npm run typecheck` and `npm test` (379 backend + 24 frontend tests) pass.
