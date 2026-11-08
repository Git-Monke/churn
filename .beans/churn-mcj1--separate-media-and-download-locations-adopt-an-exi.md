---
# churn-mcj1
title: Separate media and download locations, adopt an existing library in place
status: todo
type: epic
priority: high
tags:
    - storage
    - jellyfin
    - installer
created_at: 2026-11-08T01:15:39Z
updated_at: 2026-11-08T01:16:13Z
---

## Goal

Split churn's single `DATA_DIR` into a **download location** and a **media location**, and
make it possible to adopt an existing Jellyfin media library **in place** — no media copy,
no folder restructuring.

Design agreed in `plans/media-locations.md` (read it first; it is the source of truth).

## Design in one screen

| Answer (asked in this order) | `.env` key | Default | Container path | Purpose |
| --- | --- | --- | --- | --- |
| Download directory | `DOWNLOAD_DIR` (**renamed** from `DATA_DIR`) | `/data` | `/data` | qBittorrent scratch, in-progress downloads |
| Media directory | `MEDIA_DIR` (new) | `${DOWNLOAD_DIR}/media` | `/data/media` | library root Jellyfin indexes |

Prompt order is **downloads first, then media**: the media default derives from the download
answer, and the hard-fail rule can be checked the moment the second answer arrives.

Invariants:

- **Container paths never change.** Downloads keep `/data`; `MEDIA_DIR` bind-mounts at
  `/data/media`, the exact path used today. So `src/jellyfin.rs`, `server-init.sh`,
  `server/backend/src/direct-grab.ts`, `stats.ts` and `library-scan.ts pathsOverlap()` keep
  working unchanged.
- **Defaults keep today's layout on disk**, so existing installs find their data where they
  left it; only the `.env` key is renamed, via a migration.
- **Hard fail** if `DOWNLOAD_DIR` is equal to or nested under `MEDIA_DIR` (downloads inside
  the indexed root ⇒ Jellyfin indexes partial files). `MEDIA_DIR` nested under
  `DOWNLOAD_DIR` is the default and is fine.
- **`DATA_DIR` → `DOWNLOAD_DIR` migration.** Existing `.env` files only have `DATA_DIR`.
  Reading falls back to `DATA_DIR` when `DOWNLOAD_DIR` is absent; writing emits
  `DOWNLOAD_DIR` and removes the stale key, so a rerun never leaves both. `churn migrate`
  (`src/migrate.rs:155 current_data_dir`) accepts either key.
- **One mixed Jellyfin library** at the media root (`collectionType` empty). `movies/` and
  `tv` still exist and still feed Sonarr/Radarr root folders — they are *not* separate
  libraries. Overlapping libraries are unsupported by Jellyfin (jellyfin/jellyfin#3797,
  jellyfin/jellyfin#14870), so "root + movies + tv" is not an option.
- **Never delete or repoint a pre-existing library.** A library already covering
  `/data/media` (or an ancestor) is reused; otherwise one is created. The existing
  `/data`-library removal guard stays (downloads must never be indexed).
- **Create missing dirs only, never chown.**

Adoption for users: point `MEDIA_DIR` at the old library. Jellyfin types every item
itself and the frontend already filters on `IncludeItemTypes=Movie,Series`, so arbitrary
folder layouts (`Films/`, `Series/`, a flat dump) work as-is. New downloads land in
`movies/`/`tv`.

## Why an epic

This touches the installer, both compose stacks, the init scripts, the Jellyfin
provisioning path and the docs. Each child bean is a self-contained, independently
reviewable increment that leaves the tree green, so review can happen per-bean instead of
one giant diff.

Every child must keep these properties after its own change:

- `cargo test` + `cd server/backend && npm test` pass.
- A `.env` written before this epic (containing `DATA_DIR`) keeps working across the
  rename, and a rerun leaves exactly one of the two keys.
- `./target/debug/churn --dry-run` with default answers still produces the current layout.
- `cargo test --test compose_gate` (renders the real torrent compose; never skips).

## Children (in order)

1. **`churn-pvb9` — Installer: `DOWNLOAD_DIR`/`MEDIA_DIR` answers, migration, prompts** —
   downloads asked before media, each prompt carrying the SSD/HDD recommendation; the key
   rename with read fallback; the nesting hard-fail, `.env` output, create-only directories,
   `PUID`/`PGID` from the media owner. No layout change with defaults.
2. **`churn-iwpu` — Compose: mount `MEDIA_DIR` at `/data/media`** — both compose files
   (including the `${DOWNLOAD_DIR}` rename), `server-init.sh` create-only and no chown. Still
   no layout change with defaults.
3. **`churn-e6xi` — Jellyfin: one mixed library at the media root** — collapse `MEDIA_LIBRARIES`, reuse
   instead of duplicating, keep the `/data` removal, refresh the Jellyfin tests. This is the
   behaviour change.

   2 and 3 are the ones that make "point `MEDIA_DIR` at my old library" work end to end.
4. **`churn-17s1` — Adopt an existing Jellyfin config (optional)** — copy `config/` + `data/` before first
   start, version check against the pinned `jellyfin/jellyfin:10.11.11`, skip admin creation
   when a valid key already exists. Separate because it is the only child that can break an
   install irretrievably and should be reviewed with more care.
5. **`churn-ouq0` — Docs, beans and OpenWiki** — `docs/src/{server,torrent,introduction,web-ui}.md`, close
   out the superseded beans, regenerate the OpenWiki pages via its documented process.

## Out of scope

- Copying or moving media between locations (that is `churn migrate`, bean `churn-eeni`).
  Follow-up bean `churn-scz2` covers carrying `MEDIA_DIR` through `migrate.rs`; not built here.
- Renaming/renaming-pass inside an adopted library.
- Adopting an existing Sonarr/Radarr/qBittorrent config (still a separate question).
- Splitting direct grabs through the download location; they keep saving into the media
  root.

## Verification (whole epic)

- Default install: `--dry-run` plan matches today's paths exactly.
- `MEDIA_DIR=/mnt/disk/media` install: mount `/mnt/disk/media -> /data/media`, one library
  at `/data/media`, no copy, arbitrary subfolders indexed and typed correctly by Jellyfin.
- `MEDIA_DIR=/data` or `/` ⇒ hard fail before any file is written.
- Pre-existing Jellyfin library covering the media root is reused, never duplicated.
- `churn-direct` download still matches `content_path` to `JellyfinItem.Path`.
- Rerunning churn on an install made before the epic leaves the on-disk layout,
  qBittorrent paths and Jellyfin libraries unchanged; the only `.env` difference is
  `DATA_DIR` becoming `DOWNLOAD_DIR`.
