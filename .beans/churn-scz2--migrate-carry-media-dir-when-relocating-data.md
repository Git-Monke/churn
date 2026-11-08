---
# churn-scz2
title: 'Migrate: relocate MEDIA_DIR or DOWNLOAD_DIR independently'
status: completed
type: task
priority: low
tags:
    - storage
    - migrate
created_at: 2026-11-08T01:16:05Z
updated_at: 2026-11-08T02:00:06Z
---

## Goal

Follow-up on `churn migrate` (from bean `churn-eeni--relocate-data-with-a-churn-migrate-command`):
once the storage split lands, a relocate must move **both** the download directory and the
media directory.

## Scope

- `current_storage(root, stacks, target)` replaces `current_data_dir`: it reads the key for
  the requested `StorageTarget` (`MEDIA_DIR` or `DOWNLOAD_DIR`) from every stack's `.env`
  and still fails clearly when the stacks disagree. A pre-split file with only
  `DOWNLOAD_DIR` derives `MEDIA_DIR` as `<DOWNLOAD_DIR>/media`, matching the installer's
  default, so an older install can adopt the split without being reinstalled.
- `write_envs` takes the target and writes only that key, alongside `PUID` and `PGID`
  (dropping a stale `DATA_DIR`). A download move additionally rebases a nested `MEDIA_DIR`.
- The copy plan now handles the adoption case: media on a big disk or NAS, downloads on an
  SSD, each relocated independently. `--media` (the default) moves the library and leaves
  every in-flight torrent alone; `--download` moves the download directory and carries a
  nested library with it.
- The plan warns when a media move puts the library on a different filesystem from the
  download directory (`Plan::splits_imports`), because arr imports become copy-then-delete
  instead of hardlinks.
- Resumability is unchanged and per-move: one marker at the destination, one tree copied.
- Safety unchanged: never delete the source without `--move` after a verified copy.

## Summary of Changes

`churn migrate` now relocates either storage directory, selected with `--media` (the
default) or `--download`:

- `src/migrate.rs`: new `StorageTarget` enum (`Media` default, `Download`) with `env_key`,
  `label` and `carries_nested_other`; `current_data_dir` became `current_storage`, taking
  the target and deriving a default `MEDIA_DIR` for pre-split `.env` files; `plan` takes the
  target and records it on `Plan`, plus the new `splits_imports` field;
  `write_envs` takes the target and writes only that key; new `splits_imports` and
  `device_of` helpers compare `st_dev` of the library and the download directory.
- `src/main.rs`: `--media`/`--download` flags with validation that they require `migrate`,
  the target threaded through `migrate_storage`, a media directory created when it does not
  exist yet (a fresh install before the first import), plan output showing what is moving
  and warning about split imports, and updated `--help`.
- Tests: `current_storage_is_shared_and_rejects_a_mismatch` (renamed),
  `a_pre_split_env_derives_the_media_directory`,
  `relocating_the_media_directory_leaves_downloads_alone` and
  `a_download_move_never_splits_imports`.

The default changed from moving `DOWNLOAD_DIR` to moving `MEDIA_DIR`, per the point of the
command: the library is the large tree users outgrow, and moving it does not disturb
in-flight torrents.

## Acceptance criteria

- [x] `churn migrate --to <path>` relocates the selected directory and rewrites it in every
      stack's `.env` (legacy `DATA_DIR` accepted on read, never written).
- [x] Relocating only one of the two is possible and leaves the other alone.
- [x] An interrupted relocate resumes without re-copying completed data.
- [x] A media directory outside the data directory is handled and tested.
