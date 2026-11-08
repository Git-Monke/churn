---
# churn-iwpu
title: 'Compose: mount MEDIA_DIR at /data/media and stop chowning media'
status: completed
type: feature
priority: high
tags:
    - storage
    - docker
created_at: 2026-11-08T01:16:00Z
updated_at: 2026-11-08T01:44:10Z
parent: churn-mcj1
blocked_by:
    - churn-pvb9
---

## Goal

Bind-mount the new `MEDIA_DIR` answer at `/data/media` in both stacks, rename the download
key in compose/scripts, and make `server-init.sh` create missing media subfolders without
chowning anything. With the default answers the rendered compose must be equivalent to
today's apart from the variable name.

Parent: epic `churn-mcj1`. Design: `plans/media-locations.md` and the parent bean's
"Design in one screen".

## Scope

**`server/docker-compose.yml`** (embedded via `include_str!`, `src/assets.rs:24-70`)

- Rename `${DATA_DIR:?run churn to set DATA_DIR}:/data` → `${DOWNLOAD_DIR:?run churn to set
  DOWNLOAD_DIR}:/data` for `jellyfin`, `sonarr`, `radarr` and `server-init`
  (lines 13, 26, 39, 62). Keep the `:?` guard so a missing key fails loudly.
- Add, next to those mounts:
  ```yaml
  - "${MEDIA_DIR:?run churn to set MEDIA_DIR}:/data/media"
  ```
  for `jellyfin`, `sonarr`, `radarr` and `server-init`. This is a nested bind (Docker mounts
  the parent `/data` first — it orders by path length), which is safe on Linux. No `:ro`:
  arr must be able to import into it.

**`torrent/docker-compose.yml`**

- Rename the same interpolation for `qbittorrent` (lines 134, 152).
- Add `${MEDIA_DIR:?...}:/data/media` to `qbittorrent` (volumes at
  `torrent/docker-compose.yml:132`) so seeding and save-path moves see finished files. The
  VPN isolation gate (`src/security.rs:21 verify_torrent_isolation`) is unaffected by a bind
  mount, but `tests/compose_gate.rs` renders the real file — keep it green.

**`server/scripts/server-init.sh`**

- `media_root=${MEDIA_ROOT:-/data/media}` stays (`server/scripts/server-init.sh:9`).
- Replace the unconditional `mkdir -p` + `chown` block (lines ~76-89) with create-only
  behaviour:
  - `mkdir -p` the media root and `movies/`/`tv` **only when missing**.
  - **Drop the `chown -R`** of the media tree entirely.
  - If the media root exists but is not writable by `PUID:PGID`, log a clear warning and
    continue (do not chown, do not abort the stack).
- Keep registering `/data/media/movies` and `/data/media/tv` as Sonarr/Radarr root folders
  (`ensure_root_folder`), unchanged.
- Update the header comment (line 4) which still says "under DATA_DIR".

**`torrent/scripts/qbittorrent-init.sh`**

- No path change: `Downloads\SavePath=/data/` and `TempPath=/data/incomplete/` remain
  correct, because `DOWNLOAD_DIR` still mounts at `/data`.

**Tests / fixtures**

- `tests/compose_gate.rs` renders the real torrent compose — must stay green with the new
  mount and the renamed variable.
- `scripts/vpn-gate.sh:696 export DATA_DIR=$tmp/data` → `DOWNLOAD_DIR`, plus any
  `${DATA_DIR}` interpolation it feeds the compose files.
- `tests/vpn-gate/isolated.yml:7` comment mentioning `DATA_DIR`.
- Any test or fixture asserting `server-init.sh` content needs the chown removal reflected.
- If a test renders compose and asserts the volume list, add the `/data/media` mount.

## Acceptance criteria

- [x] Both compose files use `${DOWNLOAD_DIR}` for `/data` and mount
      `${MEDIA_DIR}:/data/media` for every service that needs the library (jellyfin, sonarr,
      radarr, server-init, qbittorrent).
- [x] `docker compose config` with default answers renders the same host paths as today —
      only the variable names and one extra explicit mount differ.
- [x] `server-init.sh` no longer runs `chown` on the media tree and creates dirs only when
      missing.
- [x] A pre-existing media tree with foreign ownership is untouched; the stack still starts
      and the warning is visible in the logs.
- [x] `cargo test --test compose_gate`, `scripts/vpn-gate.sh` and `cargo test` green.

## Summary of Changes

- `server/docker-compose.yml` and `torrent/docker-compose.yml`: every service that needs the
  library now mounts both paths, written with a legacy fallback so an install that has not
  rerun the installer keeps working:
  `"${DOWNLOAD_DIR:-${DATA_DIR:?run churn to set DOWNLOAD_DIR}}:/data"` and
  `"${MEDIA_DIR:-${DOWNLOAD_DIR:-${DATA_DIR:?run churn to set MEDIA_DIR}}/media}:/data/media"`.
- `server/scripts/server-init.sh`: create-only `mkdir -p` for the media root, `movies` and
  `tv`; the `chown -R` is gone; a non-writable media root now logs a warning instead of
  being silently adopted. `ensure_root_folder` unchanged.
- `scripts/vpn-gate.sh` and `tests/vpn-gate/{fixture.env,isolated.yml}`: `DATA_DIR` →
  `DOWNLOAD_DIR`/`MEDIA_DIR`.
- `tests/compose_gate.rs`: new `render_with_storage` + `bind_sources` helpers and two tests
  locking in the upgrade path — a legacy `.env` holding only `DATA_DIR` must still render
  and mount `<DATA_DIR>` and `<DATA_DIR>/media`, and each of the three storage combinations
  must mount the paths the installer would write.

### Deviation from the plan, and why

The plan had the compose using the hard `${DOWNLOAD_DIR:?...}` / `${MEDIA_DIR:?...}` guards
only. That breaks a real upgrade path: `churn update` runs `assets::materialize` and
recreates the dashboard **without** rerunning the installer, so a pre-split `.env` (which by
definition has neither new key) makes `docker compose config` fail with
`required variable DOWNLOAD_DIR is missing a value: run churn to set DOWNLOAD_DIR`. The
nested `:-` fallbacks keep that path rendering today's layout unchanged. Verified with a
five-combination `docker compose config` probe (legacy only, new download only, both new,
legacy + explicit media, neither → the only failure is "neither", which is correct).

## Notes

- Nothing reads `MEDIA_DIR` in the backend yet; the container path is unchanged, so
  `direct-grab.ts`, `stats.ts` and `library-scan.ts` keep working.
- With `MEDIA_DIR == ${DOWNLOAD_DIR}/media` the same host directory is mounted twice
  (`/data` and `/data/media`). Harmless, and it keeps the compose file free of conditionals.
- The `DATA_DIR` → `DOWNLOAD_DIR` rename is user-visible in `.env`: `churn-pvb9` writes the
  new key and drops the old one, so this child must land before anyone reruns an install.
