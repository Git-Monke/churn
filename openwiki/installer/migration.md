---
type: Provisioning Workflow
title: Data directory migration
description: How churn migrate discovers installed stacks and the current DATA_DIR, validates a target, resumes a verified rsync copy, switches .env files with rollback, and optionally deletes the old data.
tags: [migration, data-dir, rsync, rollback, storage]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-50cc5dfadfcddc2cc1745fd4
    resource: repo://src/migrate.rs
  - id: openwiki-source-b0b076c44e2bc590deeaa467
    resource: repo://tests/migrate.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Data directory migration

`churn migrate` moves an existing data directory to a new host path without reinstalling. Only the host `DATA_DIR` changes: every container keeps mounting it at `/data`, so qBittorrent, Sonarr, Radarr and Jellyfin see identical paths and need no per-service changes.

```bash
sudo churn migrate --to /mnt/media --dry-run   # plan only
sudo churn migrate --to /mnt/media             # copy, verify, restart; keep old copy
sudo churn migrate --to /mnt/media --move      # delete the old copy afterwards
sudo churn migrate                             # prompt for the destination
```

`--keep-old`/`--copy` is the explicit form of the default; `--move`/`--delete-old` and `--keep-old` are mutually exclusive. `--allow-network-fs` is only meaningful with `migrate`.

## Discovery

`installed_stacks` selects a stack only when both `<stack>/.env` and `<stack>/docker-compose.yml` exist. If nothing is installed, churn prints "Nothing to migrate" and exits without side effects.

`current_data_dir` reads `DATA_DIR` from every installed stack, normalizes the path and requires agreement:

- one common path → used as the source;
- stacks disagree → error telling the user to fix both `.env` files;
- no `DATA_DIR` at all → "run the installer first".

Because both stacks share the directory, `migrate --stacks` may not select a subset: passing a partially installed set is rejected with an explanation, and requesting an uninstalled stack fails.

The source is canonicalized (symlinks resolved). If it does not exist, migration stops before stopping anything.

## Planning and validation

`plan` runs before anything is stopped and rejects:

- a relative destination path;
- any `..` path component;
- a destination failing the installer's path checks (writable target or writable nearest existing parent);
- source equal to destination;
- destination nested inside the source, or source nested inside destination;
- a destination on a read-only filesystem;
- a network filesystem unless `--allow-network-fs` is given;
- insufficient free space.

Network filesystems are recognized by `statfs` type: NFS, SMB, SMB2, CIFS, FUSE (which covers sshfs and similar), AFS and 9p. The warning exists because SQLite databases and interactive media playback are unsafe on those mounts.

Free-space accounting scans the source tree without following symlinks, counting regular-file bytes, files, directories and links. For a resumed copy the destination's current size (minus the marker file) is subtracted so only the remaining bytes must fit.

`canonical_target` resolves symlinks in the existing ancestors of a not-yet-created destination and appends missing components unchanged, so nesting checks compare real paths.

### Resume detection

A copy is resumable only when the destination contains `.churn-migrate.json` whose `source` matches the current source. The marker records version, source, destination and start time.

| Destination state | Result |
| --- | --- |
| missing or empty directory | fresh copy |
| marker from the same source | resume, bytes already copied are subtracted |
| marker from another source | refuse: never merge copies |
| non-empty without a marker | refuse: choose an empty directory |
| a regular file | refuse: not a directory |

## Confirmation and dry run

The plan screen shows source, destination, total and remaining bytes, available space, whether the run resumes, whether the filesystem is networked, and the affected stacks. Unless `--yes` is passed, churn asks for confirmation; the default is yes.

`--dry-run` prints the plan, asks "Show this migration plan?" and stops nothing, writes no marker and changes no `.env`.

## Copy phase

Docker must be ready before a real run, because the stacks are stopped for the copy. SQLite databases and active downloads must not change underneath it.

The marker is written before stopping the stacks. If stopping fails, the marker is kept so a rerun can still resume, and churn attempts to restart the stacks.

Copy strategy:

- **rsync** (`-aH --numeric-ids --partial --info=progress2 --delete --exclude .churn-migrate.json`, trailing slashes on both sides): `--partial` makes an interrupted file resumable, and `--delete` removes files at the destination that no longer exist at the source. The marker is excluded.
- **`cp -a` fallback** when rsync is unavailable: preserves ownership and permissions but restarts the affected file and reports no progress.

`--info=progress2` frames are parsed strictly (`1,234,567  45%  3.00GB/s  0:00:12 (xfr#12, to-chk=48/60)`). Anything else — file names, `deleting …`, rsync errors, the closing summary — is treated as a plain line. Progress frames are kept out of failure messages so the 200-line output tail still contains the real complaint.

A failed copy leaves the old data untouched and restarts the stacks.

## Ownership and verification

Before verification, the destination root is chowned to the `PUID`/`PGID` found in the existing `.env` files, falling back to the destination's own owner. A chown failure is only a warning; the copy is still verified.

`verify_tree` walks the source and requires every entry to exist at the destination with:

- the same type (directory/file/symlink),
- the same size for files,
- the same link target for symlinks.

This is the gate before any configuration changes. A missing file or size mismatch aborts and restarts the original stacks, which still point at the old data.

## Switching `.env` and rollback

`write_envs` rewrites `DATA_DIR`, `PUID` and `PGID` in every installed stack's `.env`:

1. Copy the original to `.env.churn-migrate.bak` in the same directory, preserving its permissions.
2. Atomically upsert the three keys while keeping every other value.
3. On any failure, restore all files already changed from their in-memory originals.

Backups are retained after a successful migration. `rollback_hint` prints the exact `cp` commands plus "then restart the stacks with `docker compose up -d`".

If the stacks fail to start with the new location, churn restores the `.env` files and restarts the original stacks. Partial outcomes are reported explicitly:

- rollback and restart both succeeded;
- `.env` restored but restart failed;
- `.env` restore itself failed, in which case the manual `cp` commands are printed.

The destination and its marker are kept on a startup failure, so rerunning the same command retries.

## Health checks and completion

After a successful start, the marker is cleared and churn verifies the services:

- server stack: runs the normal Jellyfin setup/health path (`setup_jellyfin`);
- torrent stack: waits up to 120 seconds for qBittorrent and Prowlarr TCP ports.

A health-check failure reports that the data is already at the new location and the stacks are running, and prints the rollback commands.

`--move` then empties the old directory:

- directories are removed recursively;
- files and symlinks are removed;
- the old directory itself is kept so the mount point still exists.

A removal error is a spinner error message, not a failed migration, because the new location is already active. Finally, the marker is cleared again and the summary either says the old copy was removed and rollback is no longer possible, or shows where the old copy remains and how to roll back.

## Dry-run and destructive-action summary

| Action | Copied/rewritten | Old data deleted |
| --- | --- | --- |
| `--dry-run` | nothing | no |
| default | yes | no |
| `--move` | yes | yes, after health checks |

## Relevant tests

Unit tests in `src/migrate.rs` cover installed-stack discovery, `DATA_DIR` agreement, target validation, destination inspection and marker handling, tree scanning and verification, and progress parsing. `tests/migrate.rs` adds a fake-rsync test proving progress frames reach the callback, stay out of the error tail, and that rsync errors are explained.

## Operational caveats

- Docker must be running; migration is not an offline-only operation.
- Both installed stacks always migrate together; split media/download locations are not yet supported as separate migrations.
- `--move` is irreversible after the old directory is emptied.
- The destination marker is the resume contract; do not delete it manually during a partial copy.

## Related pages

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/testing/testing-strategy.md] link "/openwiki/testing/testing-strategy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Testing strategy](/openwiki/testing/testing-strategy.md)
<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Jellyfin first-run setup from churn](/openwiki/installer/jellyfin-setup.md)
