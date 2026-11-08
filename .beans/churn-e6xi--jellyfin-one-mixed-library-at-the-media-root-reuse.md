---
# churn-e6xi
title: 'Jellyfin: one mixed library at the media root, reuse existing libraries'
status: todo
type: feature
priority: high
tags:
    - jellyfin
created_at: 2026-11-08T01:16:01Z
updated_at: 2026-11-08T01:16:01Z
parent: churn-mcj1
blocked_by:
    - churn-iwpu
---

## Goal

Point Jellyfin at **one mixed library at the media root** instead of two typed libraries at
`/data/media/movies` and `/data/media/tv`, and never duplicate or destroy a library the user
already has. This is the child that makes "point `MEDIA_DIR` at my old library" actually
work.

Design: parent bean, "Design in one screen". Key constraint: Jellyfin does not support
overlapping/nested library paths (jellyfin/jellyfin#3797, jellyfin/jellyfin#14870), so a
root library **plus** `movies`/`tv` libraries is not an option.

## Scope

**`src/jellyfin.rs`**

- `DATA_ROOT` (`src/jellyfin.rs:19`) stays `/data`.
- `MEDIA_LIBRARIES` (`src/jellyfin.rs:24-26`) collapses to a single mixed entry:
  `("Media", "", "/data/media")` — name `Media`, empty `collectionType` so Jellyfin treats
  it as mixed content and types each item itself.
- `add_virtual_folder` (`src/jellyfin.rs:534`) must omit the `collectionType` query
  parameter when the collection type is empty (today it always sends it,
  `src/jellyfin.rs:544`). Send only `name` + `paths` in that case; verify against a mock
  that no empty `collectionType=` is emitted.
- `ensure_libraries` (`src/jellyfin.rs:349`) matching logic:
  - **Reuse** an existing library when any of its `Locations` is the media root or an
    **ancestor** of it (normalized prefix match — reuse `normalize_path` and the existing
    `pathsOverlap` semantics rather than string equality).
  - **Create** the mixed library at `/data/media` only when no library covers it.
  - Never remove or repoint a user's existing library, and never add `/data/media` to a
    library that already covers it via an ancestor (that is what would create the
    overlap/duplication problem).
  - Keep the `/data` removal loop (`src/jellyfin.rs:385-397`) — a library path equal to
    `DATA_ROOT` would index in-progress downloads. This is the only removal allowed.
- `enable_realtime_monitoring` pass (`src/jellyfin.rs:402-423`) follows the single entry.
- Keep `ensure_tailnet_access` and everything else untouched.

**`server/scripts/server-init.sh`**

- No path change needed (`/data/media/movies`, `/data/media/tv` root folders stay) — but
  confirm the script does not assume two Jellyfin libraries exist.

**Tests (`tests/jellyfin.rs`, currently asserting the two typed libraries at
`tests/jellyfin.rs:342-460`)**

- One library created at `/data/media`, with no `collectionType` parameter.
- A pre-existing library whose location is an **ancestor** (e.g. `/data/media` or `/`) is
  reused: no new library, no added path.
- A pre-existing library at exactly `/data/media` is reused: no duplicate.
- A pre-existing library elsewhere (e.g. `/mnt/other`) is left alone and churn's media
  library is created alongside it.
- A library path equal to `/data` is still removed.
- Rerun idempotency: second run produces no changes.

## Acceptance criteria

- [ ] Fresh install creates exactly one Jellyfin library at `/data/media`, mixed content.
- [ ] Movies and episodes both appear in the dashboard library (items typed `Movie` /
      `Series` by Jellyfin).
- [ ] An existing Jellyfin library covering the media root is reused, not duplicated.
- [ ] The user's other libraries are untouched.
- [ ] A library pointing at `/data` is still removed.
- [ ] `cargo test` (including `tests/jellyfin.rs`) green.

## Risks to weigh during review

- **Mixed-content metadata reliability.** Typed libraries are more deterministic for
  arr↔Jellyfin matching (`server/backend/src/library-scan.ts`, `direct-grab.ts`). Mixed
  libraries let Jellyfin guess, which is usually right but occasionally disagrees with
  Radarr/Sonarr about whether a folder is a movie or a series. Accepted: Jellyfin's typing
  is battle-tested and the frontend already filters on type. If this turns out to bite, the
  fallback is two typed libraries **both at the media root** (no overlap), at the cost of
  double scanning.
- **Ancestor matching is deliberately conservative** — we would rather leave a user's
  library alone and create ours than silently rewrite theirs.
