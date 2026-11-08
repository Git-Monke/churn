---
# churn-pvb9
title: 'Installer: DOWNLOAD_DIR/MEDIA_DIR answers, migration, prompts'
status: completed
type: feature
priority: high
tags:
    - installer
    - storage
created_at: 2026-11-08T01:15:59Z
updated_at: 2026-11-08T01:44:10Z
parent: churn-mcj1
---

## Goal

Turn the installer's single storage question into **two**, in this order, and rename the
old key:

1. **"Where should in-progress downloads live?"** → `DOWNLOAD_DIR`, default `/data`
2. **"Where should downloaded media be stored?"** → `MEDIA_DIR`, default `${DOWNLOAD_DIR}/media`

Both prompts need a short explanation so the user understands *why* they are separate. Then
wire both into `.env`, directory creation and `PUID`/`PGID`. **No layout change with default
answers** — same host paths as today, only the key rename.

Parent: epic `churn-mcj1`. Design: `plans/media-locations.md` and the parent bean's
"Design in one screen".

## Prompt copy (the part that matters for comprehension)

Today `Section::Storage` shows one note and one question labelled *"Where should media and
downloads live?"* (`src/question.rs:89`, note at `src/main.rs:424-432`). That framing no
longer holds. New shape:

```
 Storage layout
 Two locations keep streaming smooth: downloads happen on fast local
 disk, then the finished files live on your media drive.
 Paths: Tab completes, ↑/↓ choose, Enter submits.

┌ Where should in-progress downloads live?
│ 💡 Recommended on an SSD or fast local disk — downloads are written
│    and re-read while seeding, so a slow drive stutters playback.
│ > /data
└

┌ Where should downloaded media be stored?
│ 💡 Recommended on a large hard drive or a NAS — this is the library
│    Jellyfin streams from, so space matters more than speed.
│ > /data/media
└
```

Implement the per-question hint with `cliclack::note` (or `log::info`) printed immediately
before the corresponding `input`, not as a single note for the whole section — the hint has
to be adjacent to the prompt it explains. Keep the section-level note short (what the two
paths are, and the completion keys).

## Scope

**`src/question.rs`**

- Rename the variant `DataDir` → `DownloadDir` (`src/question.rs:27`).
  - `env_key()` → `"DOWNLOAD_DIR"`.
  - `label()` → `"Where should in-progress downloads live?"`.
- New variant `Question::MediaDir`:
  - `env_key()` → `"MEDIA_DIR"`.
  - `label()` → `"Where should downloaded media be stored?"`.
  - `section()` → `Section::Storage`.
- `ask()` (`src/question.rs:137`): `DownloadDir` keeps `/data` as its default/placeholder.
  `MediaDir` defaults to the resolved `DOWNLOAD_DIR` answer + `/media` when nothing is
  stored. Both go through `ask_directory` (`src/question.rs:180`).
- `Question::ALL`: 12 → 13 entries, `DownloadDir` first in the storage group, `MediaDir`
  immediately after it.
- New cross-field validation next to `validate_data_dir` (`src/question.rs:311`): reject when
  `DOWNLOAD_DIR` is equal to or nested under `MEDIA_DIR` after `normalize_path`, with a
  message naming the consequence ("Jellyfin would index files that are still downloading").
  `MEDIA_DIR` nested under `DOWNLOAD_DIR` must stay valid — that is the default. Compare
  normalized paths only; do not canonicalize, the dirs may not exist yet.

**`src/stack.rs`**

- `questions()` for both stacks (`src/stack.rs:60-77`): `DownloadDir` where `DataDir` was,
  then `MediaDir`.
- `Stack::apply` (`src/stack.rs:196`): read `DownloadDir`, then
  `answers.get(MediaDir)` falling back to `format!("{download_dir}/media")`; write
  `DOWNLOAD_DIR` and `MEDIA_DIR` as **resolved paths** (not `${DOWNLOAD_DIR}/media`), and
  remove any stale `DATA_DIR` key left in the `.env`.
- `PUID`/`PGID`: derive from `envfile::owner` of `MEDIA_DIR` (`src/envfile.rs:155`),
  falling back to `DOWNLOAD_DIR`, then the current user — Sonarr/Radarr need write access to
  the media root, so the media owner is the more correct source. If the media root is
  root-owned and the resolved UID is not 0, warn; never chown, never abort.

**`src/envfile.rs` / migration**

- Wherever the env map is read for a known key, `DOWNLOAD_DIR` falls back to `DATA_DIR` when
  absent (one helper, e.g. `envfile::legacy_data_dir`), so an install made before this epic
  prefills correctly.
- Writing drops `DATA_DIR` (managed key list, `src/stack.rs:199-205`) so the file never
  carries both.

**`src/main.rs`**

- `explain(Section::Storage)` (`src/main.rs:424`): new section note, plus the two
  adjacent hints described above.
- `ensure_data_dir` (`src/main.rs:437`) → `ensure_directories`: create only the missing
  `DOWNLOAD_DIR`, `MEDIA_DIR` and `MEDIA_DIR/{movies,tv}`; never chown, never touch existing
  contents. Keep today's confirm-before-create behaviour, and confirm for each path
  separately so the user knows which one is being created.
- Show both paths in the plan/summary (`show_plan`, `src/main.rs:465`), so `--dry-run` proves
  the layout.
- Grep for remaining `DataDir` uses (`src/main.rs:438` is the only one) and any user-facing
  string that still says "media and downloads" as one path.

**Tests**

- `tests/installer.rs`: question lists grow and reorder (`tests/installer.rs:18-60`); the
  dedupe test now covers both storage questions; summary test (`tests/installer.rs:169-180`)
  uses the renamed variant.
- Validation cases: default accepted; `MEDIA_DIR == DOWNLOAD_DIR` rejected; `DOWNLOAD_DIR`
  nested under `MEDIA_DIR` rejected; `MEDIA_DIR` under `DOWNLOAD_DIR` accepted; trailing
  slashes normalized (mirror `tests/installer.rs:158`).
- `stack::apply`: writes `DOWNLOAD_DIR` + `MEDIA_DIR` to both `.env` files; default derives
  `MEDIA_DIR` from `DOWNLOAD_DIR`; a pre-existing `DATA_DIR=/old` line is migrated and removed
  (extend `tests/installer.rs:185-200`).
- A rerun fixture with only `DATA_DIR` in `.env` prefills the download prompt from it.

## Acceptance criteria

- [x] Fresh install asks downloads first, media second, with the SSD/NAS hints visible next
      to each prompt.
- [x] Default answers produce `DOWNLOAD_DIR=/data`, `MEDIA_DIR=/data/media` and the same
      on-disk layout as today.
- [x] Both keys round-trip through `.env` and prefill on rerun.
- [x] An `.env` containing only `DATA_DIR` works: prefills, and is rewritten to
      `DOWNLOAD_DIR` without leaving both keys.
- [x] `PUID`/`PGID` come from the media dir owner when it exists and is not root-owned.
      A root-owned media tree is deliberately *not* adopted: `stack_owner` falls back to
      the download directory and `storage_warning` reports why.
- [x] Missing `DOWNLOAD_DIR`/`MEDIA_DIR`/`movies`/`tv` are created; existing dirs untouched.
- [x] `DOWNLOAD_DIR` equal to or inside `MEDIA_DIR` fails before anything is written.
- [x] `cargo test` green.

## Summary of Changes

- `src/question.rs`: `DataDir` → `DownloadDir`, new `MediaDir`, `Question::ALL` 12 → 13,
  new `validate_storage_paths` rejecting `download == media` and `download` under `media`
  (normalised, not canonicalised).
- `src/envfile.rs`: `storage_path` falls back from `DOWNLOAD_DIR` to legacy `DATA_DIR`;
  `write_merged` drops `DATA_DIR` whenever `DOWNLOAD_DIR` is managed; new `remove_keys`.
- `src/stack.rs`: `managed_env`/`managed_env_with` split out of `apply` so env output is
  testable without a root directory; `download_dir`/`media_dir`/`MEDIA_SUBDIR`;
  `stack_owner` and `storage_warning`.
- `src/main.rs`: per-question SSD/NAS hints, media default derived from the download
  answer, the pair re-asked in place on a bad combination, `ensure_data_dir` →
  `ensure_directories` with per-path confirmation and no chown.
- Tests: `tests/installer.rs` (+5 tests), `tests/jellyfin.rs` and `src/migrate.rs` fixtures
  updated for the new key.

Note on scope: the compose/script rename from `churn-iwpu` landed in the same working tree
(one branch, both beans), which is why this bean also touched `server/docker-compose.yml`,
`torrent/docker-compose.yml`, `server/scripts/server-init.sh` and `scripts/vpn-gate.sh`.

## Notes

- Compose mounts and the Jellyfin library change are the **next two children**. After this
  child the two paths exist in `.env` but change nothing, because `/data` and `/data/media`
  are already what the containers mount.
- The rename touches `server/docker-compose.yml`, `torrent/docker-compose.yml`,
  `server/scripts/server-init.sh`, `scripts/vpn-gate.sh:696` and `tests/vpn-gate/isolated.yml`.
  Those edits belong to `churn-iwpu` (compose) to keep this child to the Rust installer —
  except that this child must not break `cargo test`, so if any Rust test asserts on the
  compose key, update it here.
