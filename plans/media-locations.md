# Separate media + download locations, adopt an existing library in place

## Context

Two beans ask for the same storage change and are **merged into churn-jmu7**
(decision: user, this session):

- **churn-jmu7 — Separate media and download locations.** Today one `DATA_DIR` is
  mounted at `/data` everywhere; media, downloads and qBittorrent scratch share it.
- **churn-jl2c — Import an existing Jellyfin library and media folder.** Users with an
  existing library should adopt churn **without copying media** and without
  restructuring their folders.

Investigation confirmed churn never categorises by folder name — every library/show/
movie route branches on the Jellyfin item `Type` (`IncludeItemTypes=Movie,Series`), so
an existing tree can be mounted as-is.

## Design

Two host answers, one invariant:

| Answer (asked in this order) | `.env` key | Default | Container path | Purpose |
| --- | --- | --- | --- | --- |
| Download directory | `DOWNLOAD_DIR` (**renamed** from `DATA_DIR`) | `/data` | `/data` | qBittorrent scratch / in-progress downloads |
| Media directory | `MEDIA_DIR` (new) | `${DOWNLOAD_DIR}/media` | `/data/media` | the media library root Jellyfin indexes |

Prompt order is **downloads first, then media**: the media default is derived from the
download answer, and the hard-fail rule can be checked the moment the second answer
arrives. Each prompt carries a one-line recommendation — downloads on an SSD (they are
written and re-read while seeding), media on a HDD or NAS (large, streamed from). Because
`DATA_DIR` now means only downloads, its label changes from "Where should media and
downloads live?" to "Where should in-progress downloads live?".

- **Container paths do not change.** `MEDIA_DIR` is bind-mounted at `/data/media`
  (nested under the `/data` mount; Docker mounts parents first, so this is safe on
  Linux). Because `/data/media` is exactly today's path, `src/jellyfin.rs`,
  `server-init.sh`, `direct-grab.ts`, `stats.ts`, docs and `library-scan.ts
  pathsOverlap()` need **no path changes**.
- **Backward compatible in layout, not in key name.** Existing installs keep media at
  `/data/media`, so `MEDIA_DIR` defaulting to `${DOWNLOAD_DIR}/media` reproduces today's
  layout bit-for-bit. The single rewrite is `DATA_DIR` → `DOWNLOAD_DIR`: reading falls
  back to `DATA_DIR` when `DOWNLOAD_DIR` is absent, and writing emits `DOWNLOAD_DIR` and
  removes the stale key so the file never holds both.
- **Hard-fail invariant (validated at answer time, before anything is written):**
  `DOWNLOAD_DIR` must not be equal to or nested under `MEDIA_DIR`. If it is, the media
  root would contain the download scratch and Jellyfin would index partial files.
  `MEDIA_DIR` nested under `DOWNLOAD_DIR` (the default) is fine — downloads are the parent.
- **One mixed Jellyfin library at the media root.** `MEDIA_LIBRARIES` collapses from
  two typed libraries to a single library at `/data/media` (`collectionType` empty =
  mixed content). Jellyfin types each item itself; the frontend's type filter already
  works this way. `movies/` and `tv/` folders still exist and still feed Sonarr/Radarr
  root folders — they are just not separate libraries. (Verified: Jellyfin explicitly
  does not support overlapping/nested library paths — jellyfin/jellyfin#3797,
  jellyfin/jellyfin#14870 — so "root library + movies + tv" is not an option.)
- **Keep what the user has.** Churn never deletes or repoints a pre-existing library.
  A library that already includes `/data/media` (or an ancestor of it) is **reused**;
  otherwise a new mixed library is created. The existing guard that removes a library
  path equal to the download root (`/data`) stays — it no longer overlaps the media
  root, so it protects against indexing downloads without touching adopted media.
- **Create-only directories, never chown.** Missing `MEDIA_DIR` and its `movies/`/`tv`
  subfolders are created; existing trees are left completely alone.

### Behaviour

- **Fresh install:** `DOWNLOAD_DIR=/data`, `MEDIA_DIR=${DOWNLOAD_DIR}/media`; create the
  missing dirs + `movies`/`tv`; one mixed Jellyfin library at `/data/media`; arr root
  folders `movies`/`tv`.
- **Adopt existing media:** user points `MEDIA_DIR` at their old library; Jellyfin scans
  the whole root and types items. Their existing folders are untouched; new downloads
  land in `movies`/`tv`.
- **Adopt existing Jellyfin config (users/watch history):** still **optional and
  secondary** — see below.
- **Upgrade:** an old `.env` (`DATA_DIR=/data`) is read through the fallback and rewritten
  as `DOWNLOAD_DIR=/data` on rerun, while the media path still resolves to
  `/data/media` — so behaviour is unchanged until the user edits a path.

### Optional Jellyfin config import

- Default: fresh Jellyfin, churn's own admin + API key (today's flow).
- Opt-in: before the stack first starts, copy the existing Jellyfin `config/` + `data/`
  into `server/config/jellyfin` and `server/cache/jellyfin`. Preserves users + watch
  history. After import, replay only churn's settings (`ensure_libraries`,
  `ensure_tailnet_access`) and skip admin creation when the imported instance already
  has a valid key.
- Risk: compose pins `jellyfin/jellyfin:10.11.11`. Detect and **warn** on a version
  mismatch instead of silently migrating.
- This is the only part that adds real code; everything above is the core change.

## Files to modify

**Installer (Rust)**
- `src/question.rs` — rename `Question::DataDir` → `DownloadDir` (`env_key`
  `DOWNLOAD_DIR`, label "Where should in-progress downloads live?"). Add
  `Question::MediaDir` (label "Where should downloaded media be stored?"). Both go
  through `ask_directory` (`src/question.rs:180`); `MediaDir`'s default is the resolved
  download answer + `/media`. `Question::ALL` becomes 13 and orders downloads before
  media. Add the cross-field validation: `DOWNLOAD_DIR` must not be equal to or nested
  under `MEDIA_DIR` (new helper alongside `validate_data_dir`, `src/question.rs:311`).
- `src/envfile.rs` — add a `DOWNLOAD_DIR` → `DATA_DIR` read fallback (one helper) so a
  pre-epic `.env` still prefills.
- `src/stack.rs` — `questions()` (`src/stack.rs`) lists `DownloadDir` then `MediaDir`
  (both stacks); `Stack::apply` (`src/stack.rs:196`) writes `DOWNLOAD_DIR` and
  `MEDIA_DIR` (resolved, defaulting `MEDIA_DIR` to `<download>/media`) and removes any
  stale `DATA_DIR` key; derive `PUID`/`PGID` from the `MEDIA_DIR` owner (it needs write
  access for arr imports), falling back to `DOWNLOAD_DIR` then the current user; warn on
  a mismatch. `Stack::stored_answers` (`src/stack.rs`) prefills both answers on rerun.
- `src/main.rs` — rewrite the `Section::Storage` note (`src/main.rs:424-432`) around two
  locations and print a per-question hint immediately before each prompt (SSD for
  downloads, HDD/NAS for media). Extend `ensure_data_dir` (`src/main.rs:437`) to create
  only the missing `DOWNLOAD_DIR`, `MEDIA_DIR` and `movies/`/`tv`, **without chown**,
  confirming per path. Keep the
  `setup_jellyfin` (`src/main.rs:618`) call flow; pass the optional config import
  through it.
- `src/jellyfin.rs` — `DATA_ROOT` (`src/jellyfin.rs:19`) stays; `MEDIA_LIBRARIES`
  (`src/jellyfin.rs:24-26`) becomes a single mixed entry at `/data/media`. Rework
  `ensure_libraries` matching (`src/jellyfin.rs:353-360`): reuse an existing library
  whose locations include `/data/media` or an ancestor of it; else create one. Keep the
  `/data` removal loop (`src/jellyfin.rs:385-397`). Add the optional pre-start config
  import + version check.

**Compose / scripts (embedded via `src/assets.rs:24-70`)**
- `server/docker-compose.yml` — `jellyfin`, `sonarr`, `radarr`, `server-init`: add
  `${MEDIA_DIR:?...}:/data/media`.
- `torrent/docker-compose.yml` — `qbittorrent`: add `${MEDIA_DIR:?...}:/data/media`.
- `server/scripts/server-init.sh` — `media_root` stays `/data/media`; create `movies/`
  and `tv` only when missing; **drop the chown**; keep registering the two arr root
  folders.
- `torrent/scripts/qbittorrent-init.sh` — no path change (still `/data/`), because
  `DOWNLOAD_DIR` remains the download root at `/data`; only `${DATA_DIR}` key
  interpolation in compose/scripts changes to `${DOWNLOAD_DIR}`.

**Dashboard (TypeScript)**
- No path change required: `direct-grab.ts:18 DEFAULT_MEDIA_ROOT = "/data/media"` and the
  arr root folders still resolve under `/data/media`.

**Docs / beans**
- `docs/src/server.md` (Storage + a new "Adopting an existing library" note),
  `docs/src/torrent.md:123`, `docs/src/introduction.md:27`, `docs/src/web-ui.md:240`.
- `.beans/churn-jmu7-...md` — absorb jl2c scope, update acceptance criteria.
- `.beans/churn-jl2c-...md` — close as merged into jmu7.
- `churn-eeni` (migrate) — `migrate::write_envs` (`src/migrate.rs:781`) and the
  `DATA_DIR` detection (`src/migrate.rs:158-188`) must accept the renamed key and carry
  `MEDIA_DIR`; tracked as follow-up `churn-scz2`. `scripts/vpn-gate.sh:696` and
  `tests/vpn-gate/isolated.yml:7` also set/comment `DATA_DIR`.

## Reuse

- `question::ask_directory` + `question::validate_data_dir` (`src/question.rs:180,311`).
- `envfile::owner` (`src/envfile.rs:155`) for PUID/PGID.
- `Stack::stored_answers` (`src/stack.rs`) — prefill for free once `MediaDir` is a
  `Question` (with the `DATA_DIR` fallback for the renamed key).
- `assets::materialize` / `write_asset` (`src/assets.rs:91`) — compose/scripts are
  rewritten on every install, so the new mount ships automatically.
- `Jellyfin::add_virtual_folder` / `add_media_path` / `remove_media_path`
  (`src/jellyfin.rs:534,553,563`) and `enable_realtime_monitoring`
  (`src/jellyfin.rs:404`) for the single-library setup.

## Steps

1. [ ] Rename `Question::DataDir` → `DownloadDir` (`DOWNLOAD_DIR`, new label) and add
   `Question::MediaDir`; update `Question::ALL` (13), `env_key`, `label`, `section`, `ask`
   (media default = download answer + `/media`); add the nesting validation; add the
   `DOWNLOAD_DIR` → `DATA_DIR` read fallback; update `tests/installer.rs` question-list
   tests (`tests/installer.rs:18-40`).
2. [ ] Write `DOWNLOAD_DIR` + `MEDIA_DIR` in `Stack::apply` (drop a stale `DATA_DIR`);
   derive PUID/PGID from `MEDIA_DIR`; rewrite the `Section::Storage` note and the two
   per-question hints; extend `ensure_data_dir` to create only missing dirs, no chown.
3. [ ] Rename `${DATA_DIR}` → `${DOWNLOAD_DIR}` in both compose files, `server-init.sh`,
   `scripts/vpn-gate.sh:696` and `tests/vpn-gate/isolated.yml:7`; add
   `${MEDIA_DIR}:/data/media` to both compose files.
4. [ ] Update `server-init.sh` (create-if-missing, no chown) — `qbittorrent-init.sh`
   unchanged.
5. [ ] Collapse `MEDIA_LIBRARIES` to one mixed library at `/data/media`; rework
   `ensure_libraries` matching (reuse, never duplicate) and keep the `/data` removal;
   refresh `tests/jellyfin.rs:342-460`.
6. [ ] Optional Jellyfin config import: copy `config/`+`data/` before first start,
   version-check, skip admin creation when a valid key exists; wire a prompt/flag.
7. [ ] Update docs and bean files; regenerate the OpenWiki pages via its documented
   process.
8. [ ] Tests: installer question dedupe/order, nesting validation (accept default,
   reject download-inside-media), `stack::apply` env output, single-library setup.

## Verification

- `cargo test` (installer, `tests/jellyfin.rs`, `tests/installer.rs`).
- `cd server/backend && npm test && npm run build`.
- `./target/debug/churn --dry-run` with defaults: plan shows `DOWNLOAD_DIR=/data`,
  `MEDIA_DIR=/data/media` and `/data/media` mounts — i.e. identical layout to today.
- `./target/debug/churn --dry-run` with `MEDIA_DIR=/mnt/disk/media`: plan mounts
  `/mnt/disk/media -> /data/media`, library at `/data/media`, no media copy.
- Negatives: setting `MEDIA_DIR=/data` or `MEDIA_DIR=/` (downloads inside media) hard-
  fails with a clear message before any file is written.
- `cargo test --test compose_gate` and `scripts/vpn-gate.sh` — new mount must not
  host-net a networked service.
- Manual: point `MEDIA_DIR` at a folder with a couple of arbitrary subfolders; confirm
  Jellyfin lists the items typed `Movie`/`Series` and that a pre-existing library is not
  duplicated; `churn-direct` still matches `content_path` to `JellyfinItem.Path`.
- Upgrade regression: rerun `churn` on an install made before this change; `.env`,
  qBittorrent paths and Jellyfin libraries must be unchanged.

## Resolved decisions

- Media layout → one root; `movies/` + `tv` are arr folders, **not** Jellyfin libraries.
- Jellyfin libraries → **one mixed library** at the media root.
- Jellyfin config → fresh by default, optional import.
- Permissions → create only, never chown.
- Downloads-inside-media → **hard fail** at answer time.
- Beans → merge jl2c into churn-jmu7.

## Open question

- ~~Keep `DATA_DIR` as the download key, or rename it to `DOWNLOAD_DIR`?~~ **Resolved
  (user, m00372): rename to `DOWNLOAD_DIR`, migrating the old key.**
- Prompt order and copy: downloads first with an SSD hint, then media with a HDD/NAS
  hint (user, m00372). Default stays `/data`; no disk detection.
