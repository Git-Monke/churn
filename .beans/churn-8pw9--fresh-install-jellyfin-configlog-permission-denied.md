---
# churn-8pw9
title: 'Fresh install: Jellyfin /config/log permission denied'
status: completed
type: bug
priority: critical
tags:
    - installer
    - jellyfin
    - docker
created_at: 2026-11-14T02:30:14Z
updated_at: 2026-11-14T02:45:00Z
---

## Problem

A fresh `sudo churn` install failed as soon as Jellyfin booted. Jellyfin's logs repeated:

```
Unhandled exception. System.UnauthorizedAccessException: Access to the path '/config/log' is denied.
 ---> System.IO.IOException: Permission denied
   at System.IO.FileSystem.CreateDirectory(String fullPath, UnixFileMode unixCreateMode)
   at Jellyfin.Server.Helpers.StartupHelpers.CreateApplicationPaths(StartupOptions options)
```

## Root cause

`server/docker-compose.yml` mounts `./config/jellyfin:/config` (and `./cache/jellyfin:/cache`,
`./config/sonarr:/config`, `./config/radarr:/config`) and runs every container as
`user: "${PUID:-1000}:${PGID:-1000}"`. Nothing in churn ever created those host
directories. Docker auto-creates a missing bind-mount source as **root:root 0755**,
so the container (running as PUID:PGID) could not write there and Jellyfin died trying to
`mkdir /config/log`.

Confirmed by a minimal `docker compose up` repro: image `jellyfin/jellyfin:10.11.11`,
`user: "1000:1000"`, volume `./config/jellyfin:/config` → `touch: cannot touch '/config/log':
Permission denied` and the host dir ended up `drwxr-xr-x root root`.

qBittorrent avoided this because `torrent/scripts/qbittorrent-init.sh:119` chowns its config
tree. Jellyfin/Sonarr/Radarr had no equivalent.

## Changes

- `src/stack.rs`: new `Stack::config_dirs()` listing each stack's bind-mount config/cache
  trees (server: `config/jellyfin`, `config/sonarr`, `config/radarr`, `cache/jellyfin`;
  torrent: `config/qbittorrent`, `config/prowlarr`), plus `prepare_config_dirs(base, stack,
  owner)` that creates each and chowns it to `PUID:PGID`. A directory already owned by a
  non-root identity is left untouched, so an adopted config keeps its owner (the same rule
  the media tree follows). Also `stack::env_owner(stack)` reads `PUID`/`PGID` back from a
  stack's `.env` (default 1000) for the non-interactive `churn update` path.
- `src/envfile.rs`: new shared `pub fn chown(path, uid, gid)`; `share()` now builds on it.
- `src/migrate.rs`: `set_owner()` delegates to `envfile::chown`.
- `src/main.rs`: `write_stacks()` creates/owns the config dirs before `compose up`
  (new `stack_owner_for(answers)` derives the owner from the storage answers, matching
  `managed_env`); `reconcile_stacks()` heals an existing install on `churn update`.
- `tests/config_dirs.rs`: new test rendering each shipped compose file and asserting every
  `./config/*` / `./cache/*` bind-mount source has a matching `config_dirs()` entry, so a new
  mount cannot be added without a prepared directory.

## Verification

- `cargo test --offline`: 134 lib + all integration tests pass.
- `cargo clippy --offline --all-targets` and `cargo fmt` clean.
- Live repro: pre-creating `config/jellyfin` owned by `1000:1000` and running the Jellyfin
  image as `1000:1000` now writes `/config/log` (`WRITE_OK`), versus the root-owned
  `Permission denied` before the fix.
