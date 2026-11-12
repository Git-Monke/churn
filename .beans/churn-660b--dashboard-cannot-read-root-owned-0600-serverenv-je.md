---
# churn-660b
title: Dashboard cannot read root-owned 0600 server/.env (Jellyfin API key)
status: completed
type: bug
priority: critical
tags:
    - dashboard
    - jellyfin
    - security
    - installer
created_at: 2026-11-12T21:01:42Z
updated_at: 2026-11-12T21:10:56Z
---

## Problem

`server/docker-compose.yml` mounts `./.env:/app/.env:ro` into the `dashboard`
container, which runs as a hardcoded `user: "1000:1000"`. Churn writes
`server/.env` as root and `envfile::restrict()` (`src/envfile.rs:144`) forces
mode `0600`, so the container gets `EACCES` on `/app/.env`.

`readDotEnv()` (`server/backend/src/config.ts:286`) then swallows the error and
returns `{}`, so `JELLYFIN_API_KEY` is undefined and the dashboard renders the
"Set JELLYFIN_API_KEY in server/.env" state (no library, no Continue watching).
Every `sudo churn` install is affected because churn requires root.

Second, latent bug in the same path: the dashboard user is hardcoded to
`1000:1000`, while `PUID`/`PGID` are derived from the media/download directory
owners (`stack_owner` in `src/stack.rs:245`). On any host where those are not
1000 the dashboard runs as the wrong identity, independent of permissions.

## Fix (chosen)

Keep `server/.env` root-owned so an unprivileged process cannot inject values
that compose later interpolates (`CHURN_DASHBOARD_IMAGE`, `DOWNLOAD_DIR`, …) as
root — chowning it to `PUID` would be a privilege-escalation path. Instead grant
the group that the dashboard already runs as read access, and make the
container's identity match the generated file:

- `server/.env` becomes `root:${PGID}`, mode `0640` (root still owns it and
  compose still interpolates it; the dashboard gets exactly the group it runs
  as; `torrent/.env` stays `0600`).
- dashboard instead of `user: "1000:1000"` uses
  `user: "${PUID:-1000}:${PGID:-1000}"`, matching `stack_owner`.
- Apply the mode/group change after every server `.env` write and on every
  rerun/`churn update`, so existing broken installs heal without manual chmod.
- Make the backend log a warning when `.env` exists but cannot be read/parsed,
  instead of silently treating the install as unconfigured.

Rejected alternatives: copying `.env` to a second dashboard-owned file (drift
with hand-added settings, which the docs promise survive reruns); mounting it
via compose `configs` (uid/gid support varies by compose version); dropping the
mount and passing only `JELLYFIN_API_KEY` (breaks documented per-key overrides
read from `.env`).

## Steps

- [x] `src/envfile.rs`: add `share(path, gid)` — chmod `0640` and chown group to
      `gid`, keeping uid; error with a clear message if chown fails while root,
      warn/no-op when not root and the file is already group-readable. Unit
      tests for mode and (root-gated) ownership; keep `restrict()` for the
      torrent stack.
- [x] `src/stack.rs` / `src/main.rs`: after writing the server `.env` in
      `write_stacks`, call `envfile::share(&env_path, pgid)` using the managed
      `PGID`. Do the same after `scripted_jellyfin_credentials` and after
      `jellyfin::provision` writes `JELLYFIN_API_KEY` (`src/jellyfin.rs:226`),
      before `restart_dashboard()`.
- [x] Make the heal unconditional on rerun: enforce `share()` on the existing
      server `.env` even when no key/credential rewrite happens, so a rerun or
      `churn update` fixes installs created with the old permissions.
- [x] `server/docker-compose.yml`: change the dashboard `user:` to
      `${PUID:-1000}:${PGID:-1000}`; leave the `./.env:/app/.env:ro` mount.
- [x] `server/backend/src/config.ts`: in `readDotEnv`, distinguish "missing"
      from "unreadable" and log a warning with the path and error code when the
      file exists but cannot be read or parsed.
- [x] Docs: `docs/src/web-ui.md`, `server/README.md` (Configuration) and
      `README.md` note that `server/.env` is `root:${PGID} 0640`, that the
      dashboard runs as `PUID:PGID`, and that a rerun repairs the permissions.
- [x] `cargo fmt`, `cargo test`, backend tests (`npm test` in `server/`).

## Verification

- [x] `cargo test`: 131 unit tests (including `envfile::share` mode/owner) and
      `tests/env_permissions.rs` (server `.env` is 0640, group-readable with the
      containers' gid; torrent `.env` stays 0600).
- [x] `npm test -w backend` (396 tests) and `npm run typecheck -w backend`.
- [x] `docker compose config` in a temp copy resolves `user: 1001:1002` from
      `PUID`/`PGID`, still interpolates the other values from `.env`, and keeps
      the `./.env:/app/.env:ro` mount.
- Not run here: the host-level install and upgrade checks below need root and a
  Docker socket, neither of which is available in this session. After installing
  the new binary:
  - `stat -c '%U:%G %a' server/.env` must report `root:<PGID> 640`.
  - `sudo churn update` on an existing broken install must repair the file, and
    `docker compose exec -u <PUID>:<PGID> dashboard grep -c JELLYFIN_API_KEY /app/.env`
    must print `1`; the library and Continue watching then load without the
    unconfigured state.

## Summary of Changes

- `src/envfile.rs`: added `share(path, gid)` — chowns the group while keeping
  the owner, then sets mode 0640. `restrict()` (0600) remains for `torrent/.env`.
- `src/stack.rs`: `Stack::share_env()` reads `PGID` from the generated file and
  shares only the server stack; `Stack::apply()` calls it after every
  install/rerun write.
- `src/main.rs`: share after scripted admin-credential writes and at the start
  of `setup_jellyfin` (heals reruns that reuse a valid key); `churn update`
  heals an installed server `.env` before recreating containers.
- `server/docker-compose.yml`: the dashboard runs as
  `${PUID:-1000}:${PGID:-1000}` instead of hardcoded `1000:1000`.
- `server/backend/src/config.ts`: an unreadable `server/.env` now logs the path
  and error code instead of silently starting unconfigured.
- Tests/docs: `envfile::share` unit test, `tests/env_permissions.rs` integration
  test, README/server docs/web-ui docs/automation docs/OpenWiki updated.

Verified with `cargo test`, backend vitest (396 tests), backend typecheck and a
`docker compose config` interpolation check. The host install/upgrade check
remains manual because this session has neither root nor Docker socket access.

Note: unlike the plan's "warn/no-op when not root", `share()` returns an error
when it cannot set the group. churn already requires root for install/update,
and silently skipping would leave the dashboard broken.
