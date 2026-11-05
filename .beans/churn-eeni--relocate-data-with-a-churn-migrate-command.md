---
# churn-eeni
title: Relocate data with a churn migrate command
status: in-progress
type: feature
priority: normal
tags:
    - storage
created_at: 2026-11-05T04:05:47Z
updated_at: 2026-11-05T05:16:42Z
---

## Problem

`DATA_DIR` is a one-time installer answer. Once an install is running it is baked into several places:

- `server/.env` and `torrent/.env` (`DATA_DIR`, plus `PUID`/`PGID` derived from the path owner)
- the Compose bind mounts in both stacks
- qBittorrent's save and temp paths (`torrent/scripts/qbittorrent-init.sh`)
- Sonarr/Radarr root folders (`server/scripts/server-init.sh`, dashboard direct grabs)
- Jellyfin library paths (`src/jellyfin.rs`)
- dashboard cache/config assumptions and any in-flight downloads

A user who starts on a laptop-sized disk and later adds an external drive has to stop everything, copy potentially hundreds of GB by hand, edit both `.env` files, fix every service's path config, and hope nothing was missed. churn should offer this as a guided operation instead.

## Desired behaviour

A new command (name to settle: `churn migrate`, `churn relocate`, or `churn storage move`) that:

1. Detects the current storage location(s) from the existing `.env` files.
2. Asks for the new location with the same path validation/autocomplete as install.
3. Shows a plan: source, destination, estimated size, free space, which stacks stop/restart, and whether the old data will be kept.
4. Refuses unsafe targets: destination inside the source (or vice versa), destination not writable, insufficient free space, destination on a read-only or network path that would break SQLite/interactive use unless explicitly acknowledged.
5. Stops the affected stacks, copies all data, verifies it, updates every config path, restarts the stacks, and runs the same health checks as install.
6. **Keeps the old data by default** so the user can verify playback/imports before deleting it manually. Offer `--delete-old`/`--move` for users who want it cleaned up after verification.
7. Is safe to interrupt and re-run: a partial copy is detected and resumed, and `.env` is only switched after a successful, verified copy.
8. Supports both media and download locations once `Separate media and download locations` lands — each can be migrated independently, and `--dry-run`/`-y` follow the existing CLI conventions.

## Implementation sketch

- Add a `migrate`/`relocate` subcommand to `src/main.rs` (mirroring `show`/`update` argument handling) with `--stacks`, `--to <PATH>`, `--download`/`--media`, `--move`/`--copy`, `--keep-old`, `--dry-run`, `--yes`.
- New module `src/migrate.rs`:
  - **Preflight**: resolve current paths from both env files, validate destination, check free space via `statvfs`, detect nesting and same-filesystem.
  - **Quiesce**: `system::compose_ps` + `docker compose stop` (not `down`) for the affected stacks; refuse to continue if active torrents would be lost, or warn clearly. Consider pausing qBittorrent via its API first.
  - **Copy**: prefer `rsync -aH --info=progress2 --partial` when available, fall back to `cp -a`; preserve ownership/perms/xattrs; skip/verify when resuming. Report progress through the existing live-log style.
  - **Verify**: byte/size comparison at minimum; optional checksum pass. Do not delete source data until verification passes.
  - **Reconfigure**: update `DATA_DIR`/`DOWNLOAD_DIR`, recompute `PUID`/`PGID` (`envfile::owner`), rewrite both env files atomically with a backup; then re-run the relevant init steps:
    - qBittorrent save/temp paths (existing torrent paths may need rewriting; document whether seeding torrents are relocatable).
    - Sonarr/Radarr root folders and any download-client path config via their APIs.
    - Jellyfin library paths via `src/jellyfin.rs`, then a library refresh.
  - **Restart and verify**: `docker compose up -d`, wait for health, then print the resulting paths and how to roll back.
- Rollback: keep a copy of the old `.env` files and print a one-command recovery hint; do not start stacks pointing at a half-copied destination.
- Reuse install helpers where possible (`ensure_data_dir`, path normalization/validation, plan note rendering) rather than duplicating prompts.
- Docs: new section in `README.md` and `docs/src/server.md`; mention downtime, free-space requirements, and that cross-filesystem moves change arr import behaviour (hardlinks/atomic moves stop working, imports become copy+delete, so media and downloads should ideally live on the same filesystem when imports matter).

## Acceptance criteria

- [x] `churn migrate` discovers the current path without re-asking and prompts for a new one.
- [x] Data is copied with progress, verified, and the old copy is retained unless explicitly deleted.
- [x] Both `.env` files, Compose mounts, qBittorrent paths, arr root folders, and Jellyfin libraries point at the new location after the command finishes.
- [ ] Services come back healthy and existing media still plays / imports still work.
- [x] Insufficient space, nested destinations, and unwritable destinations fail before any copy or container stop.
- [x] An interrupted run can be re-run safely and does not leave `.env` pointing at incomplete data.
- [x] `--dry-run` prints the full plan and changes nothing.
- [ ] Works for media-only, download-only, and combined migrations once the split-locations bean is implemented.

## Open questions

- Command name and whether it should be offered automatically on rerun when the stored path no longer exists or is not writable.
- Whether to stop the whole stack or only the services that touch storage (Jellyfin/Sonarr/Radarr/qBittorrent) to minimise downtime.
- How to handle currently seeding torrents: relocate their files and update paths, or require those torrents to be paused/finished first.
- Cross-filesystem arr imports: warn only, or refuse a layout that breaks hardlink imports?

## Related

- `Separate media and download locations` — land first if possible so migration can cover both locations in one design.


## Progress

Scoped to the existing single `DATA_DIR` layout by decision; split media/download
locations remain a follow-up (see `Separate media and download locations`).

Implemented:

- `churn migrate` (alias confirmed over `relocate`/`storage move`) with
  `--to <PATH>`, `--stacks`, `--move`/`--delete-old`, `--keep-old`/`--copy`,
  `--allow-network-fs`, `--dry-run` and `-y`.
- `src/migrate.rs`: discovers `DATA_DIR` from both stacks and refuses a
  mismatch; rejects same/nested paths, non-empty unmarked destinations,
  read-only and network filesystems (`--allow-network-fs` override), and
  insufficient free space before stopping anything.
- Stops every installed stack (not just storage services), copies with
  `rsync -aH --numeric-ids --partial` or `cp -a`, verifies every file size and
  symlink target, then rewrites `DATA_DIR`/`PUID`/`PGID` in both `.env` files
  atomically. The previous files become `.env.churn-migrate.bak`.
- Keeps the old copy by default. `--move` removes it only after verification
  and a healthy restart. A destination marker lets an interrupted run resume;
  `.env` is never switched before verification.
- Rolls back `.env` and restarts the old layout if the new layout fails to
  start; prints the exact rollback commands after success (when the old copy is
  kept) and on health failure.
- Copy, verification, env-write and startup failures keep the destination
  marker and restart the original stacks, so re-running the same command
  resumes. The marker is only cleared after the copy is verified and the stacks
  start, so a clean command error is as resumable as a hard interruption.
- When rsync reports source read errors or failed verification, churn explains
  that a same-size destination file can still be corrupt, that `.env` is
  unchanged, and how to proceed. A resumed plan showing `0 B` left now warns
  that this is only a size estimate, not proof of a valid copy.
- No per-service path changes are needed: containers still mount the host
  `DATA_DIR` at `/data`, so qBittorrent, Sonarr/Radarr root folders, Jellyfin
  libraries and Compose mounts all remain valid. Only the host path moves.
- `src/system.rs`: `compose_stop` plus streaming-command access for progress.
  `src/envfile.rs`: atomic multi-key `upsert_many`. `src/question.rs`: shared
  directory prompt so migrate uses install's autocomplete/validation.
- README and `docs/src/server.md` document usage, downtime, free space and
  rollback.

Checks run: `cargo test` (72 unit + 17 installer + 9 Jellyfin + 6 system tests
pass), `cargo fmt --check`. Clippy only reports pre-existing warnings in
`src/question.rs`/`src/security.rs`; the new code adds none.

Remaining before completing this bean: a real host run against Docker to
confirm a healthy restart and playable media (the checkboxes for that and for
split-location support are intentionally still open).
