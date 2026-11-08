---
# churn-jl2c
title: Import an existing Jellyfin library and media folder during install
status: scrapped
type: feature
priority: normal
tags:
    - jellyfin
    - installer
    - storage
created_at: 2026-11-06T07:26:02Z
updated_at: 2026-11-08T01:16:06Z
---

## Problem

churn always builds a brand-new media server. It assumes there is no existing Jellyfin and no existing media:

- `src/jellyfin.rs` completes first-run setup, asks for a new admin, creates `Movies`/`Shows` libraries at `/data/media/movies` and `/data/media/tv`, and removes any library path pointing at `/data` itself.
- `src/main.rs::setup_jellyfin` prompts for admin credentials whenever no valid `JELLYFIN_API_KEY` exists; there is no "reuse the existing users" path.
- `server/docker-compose.yml` bind-mounts `./config/jellyfin` and `./cache/jellyfin`; nothing ever populates them from an existing install.
- Media is expected under `DATA_DIR` (mounted at `/data`) in churn's own `media/movies` + `media/tv` layout. There is no way to point Jellyfin at a pre-existing library or to bring an existing library in.
- `churn migrate` (`src/migrate.rs`) only relocates a churn-managed `DATA_DIR`; it is not an import path for media that is not already under `/data`.

Someone with a working Jellyfin (users, watch history, libraries) and a media folder on another disk, a NAS, or an old Docker host currently has to: hand-copy the media, hand-copy/repair the Jellyfin config, remap every library path, recreate the users or recover the DB, and then re-add root folders in Sonarr/Radarr. That is the main adoption blocker for churn.

## Desired behaviour

The installer detects an existing Jellyfin/media setup early and offers to bring it over so that, after install, the same users, watch state and playable library are there.

1. **Ask once, on the server stack:** "Do you already have Jellyfin and a media library to bring over?" Options: `Start fresh` (today's behaviour), `Import media folders only`, `Import an existing Jellyfin + media`. Reruns infer the previous answer from a recorded state/marker and do not re-import.
2. **Media import**
   - Ask for the existing media root(s) — ideally separate movie and TV paths, and tolerate one shared root with `Movies`/`TV`/`Films`/`Shows`/`Series` subfolders.
   - Inspect before copying: file/video count, total size, available free space, filesystem (local vs network), and detected layout. Show a plan and require confirmation, following the existing `churn migrate` plan style.
   - Copy into `DATA_DIR/media/movies` and `DATA_DIR/media/tv` (hardlinks not needed — these are final files), preserving relative paths, ownership (`PUID`/`PGID`) and permissions. Reuse the `migrate.rs` machinery: `rsync -aH --numeric-ids --partial`/`cp -a`, size/symlink verification, resumable marker, progress feed, keep the source by default, `--move` only after verification.
   - Refuse the obvious foot-guns before touching anything: source == target, nested paths, insufficient space, unreadable files, destination on a filesystem that breaks ownership.
   - A symlinked library is common; either resolve it to a real path with confirmation or copy the symlink targets, never copy dangling links silently.
3. **Existing Jellyfin adoption**
   - Ask for the host path of the existing Jellyfin config (the directory containing `config/`, `data/`, `cache/`, or a full Jellyfin backup), plus whether it is a live config or a backup.
   - Back up anything already in `server/config/jellyfin`, then copy the config and user data (`config/`, `data/`, and only the cache if the user asks) with correct ownership.
   - Remap library paths. Old paths may be host paths (`/mnt/media/...`) or another container mount (`/media/...`, `/data/media/...`); after churn starts the stack they must resolve to `/data/media/...`. Prefer rewriting via the Jellyfin API once the server is up, using the existing admin credentials to get a token; if a path cannot be mapped, list it and ask how to map it instead of dropping the library.
   - Warn about version compatibility: churn pins `jellyfin/jellyfin:10.11.11`. An adopted config from a much older/newer Jellyfin may migrate or fail; refuse clearly rather than looping on a broken container, and mention the config backup for rollback.
   - Do **not** create a new admin or rerun the first-run wizard when users already exist. If authentication is needed, ask for the existing admin username/password (password not stored), authenticate, create the churn API key, and continue. If no users exist, fall back to today's setup.
   - Preserve existing libraries/users/watch state; only add library paths that are missing and only remove a library path that points at `/data` itself (the current download-indexing safeguard).
4. **Make it work with the rest of churn**
   - After media import, register `DATA_DIR/media/movies` and `DATA_DIR/media/tv` as Sonarr/Radarr root folders if they are not already configured, matching what `server/scripts/server-init.sh` and dashboard direct grabs expect.
   - Rename nothing inside the imported library: Jellyfin indexes existing names, and an arr rename pass is a separate opt-in.
   - Trigger a library scan and verify via the Jellyfin API that items appeared; report counts and the dashboard/Jellyfin URLs. Do not claim success on a copied-but-unindexed library.
5. **Safety and resumability**
   - Interrupt-safe: marker file in the destination, re-run resumes; `.env`/config only switch after verification and a healthy start.
   - Never delete the source without an explicit `--move`/confirmation after verification.
   - A failed or declined import must leave a working fresh install and an unmodified source.
   - Existing churn installs that rerun with no import keep today's flow.
6. **Non-interactive path:** the same import must be available to an existing install (for example `churn import --media /mnt/old/movies --jellyfin /srv/jellyfin`) with `--yes`/`--dry-run`, not just during install.

## Implementation sketch

- New `src/import.rs` (or a clearly separated module next to `migrate.rs`): detection (media tree stats, layout heuristics, existing Jellyfin config/version/user probe), plan rendering, copy/verify/resume reusing `migrate` helpers, path remapping, rollback notes.
- `src/question.rs`: import-mode select (`ImportMode::{Fresh, MediaOnly, JellyfinAndMedia}`), `Question::ExistingMediaRoot`, `Question::ExistingTvRoot` (or one root + detected subfolders), `Question::ExistingJellyfinConfig`, `Question::ExistingJellyfinAdmin`, `Question::ExistingJellyfinPassword`. These are conditional, so either add a pre-question wizard stage in `main.rs` before `collect_questions` or model them as a mode-dependent question set in `Stack::questions()`.
- `src/main.rs`: insert the import stage between stack choice and the normal VPN/storage questions; skip `jellyfin_credentials` when adoption supplied users; pass the import plan into setup so `setup_jellyfin` runs reconcile instead of first-run.
- `src/jellyfin.rs`: `adopt()`/`reconcile_libraries()` path that lists users, validates an existing admin login, tolerates existing library names/types, only creates churn libraries when absent, rewrites paths via `/Library/VirtualFolders/Paths`, keeps real-time monitoring on, and returns a change report.
- `server/docker-compose.yml`: keep the `./config/jellyfin` mount; imported config must be copied into it before `up`. No new volumes needed for a copy-based import.
- `server/scripts/server-init.sh`: run as `PUID:PGID`, register root folders for imported media, and leave existing arr configs alone.
- State: record import provenance in `server/.env` (for example `CHURN_IMPORT_MEDIA_FROM`, `CHURN_IMPORT_JELLYFIN_FROM`) or a marker file so reruns know not to re-ask/re-copy. Never record passwords.
- Tests: layout detection, size/free-space preflight, nested/overlap rejection, path remapping (host path, other container path, unmapped), marker resume, Jellyfin reconcile unit tests with a mock API, and an installer test that `Fresh` is byte-for-byte the current behaviour.
- Docs: README section "Already have Jellyfin and media?", `docs/src/server.md` (downtime, disk space, ownership, rollback), and the fresh-vs-adopt choice.

## Acceptance criteria

- [ ] Fresh install with `Start fresh` behaves exactly as today (no new prompts beyond the import question).
- [ ] Importing a `Movies`/`TV` tree copies it into `DATA_DIR/media/{movies,tv}` with `PUID`/`PGID` ownership; Jellyfin indexes it and a title plays.
- [ ] Adopting an existing Jellyfin keeps its users, watch state and libraries; no duplicate admin prompt; the dashboard works with the provisioned API key.
- [ ] Old library paths are remapped to `/data/media/...` or reported for manual mapping, never silently ignored.
- [ ] Sonarr/Radarr get root folders that match the imported media paths so future grabs import correctly.
- [ ] An interrupted import resumes safely; the source is kept unless explicitly moved.
- [ ] Insufficient space, nested/overlapping paths and unreadable sources fail before any copy or container change.
- [ ] Existing churn installs are unaffected by a rerun.
- [ ] `churn import` works on an already-installed stack with `--dry-run`/`-y`.
- [ ] Docs cover both import modes, expected downtime and rollback.

## Open questions

- **Copy vs reference in place.** Copying into `DATA_DIR` is the simple, portable, arr-compatible path. Keeping media on an existing external drive/NAS is also valid; that needs either bind-mounting that path at `/data/media/...` or a split-location layout (see `Separate media and download locations`). Scope this bean to copy-first and decide whether reference-in-place is a follow-up or part of it.
- **Existing Sonarr/Radarr/qBittorrent configs.** This bean only adopts Jellyfin + media. Users with an existing *arr stack probably want their series/movie records, API keys and torrents too. Separate bean, or extend this one?
- **Jellyfin config from a different version/host.** Is a copied config directory safe to adopt, or should churn only accept a Jellyfin backup and restore it through Jellyfin's own mechanism?
- **Non-Movies/TV libraries.** Adopt Music/Books/Home Videos libraries too, or only reconcile the movie/TV libraries churn understands?
- **Library layout.** Guarantee churn's `media/movies` + `media/tv` layout (rename/move on import), or preserve the source layout and add its paths to Jellyfin/arr? Current code assumes the former.
- **Multiple media roots.** One root with detected subfolders is the common case; how many explicit roots should the prompt support before it becomes a config file?
- **Where does import run?** Install prompt only, or also `churn import` on a live install (this bean assumes both)?
- **Progress UI.** Reuse `migrate`'s live rsync progress bar, and what timeout/lockout applies while Jellyfin is scanning a large library?
- **Hardlinks/dedup.** Media imported from another disk has no hardlinks to preserve, but a source with existing hardlinks should not be expanded into full copies silently.

## Related

- `Relocate data with a churn migrate command` — shares rsync/verify/resume, marker and rollback mechanics; import should reuse them rather than fork them.
- `Separate media and download locations` — decides whether media can stay outside `DATA_DIR`, which affects the copy-vs-reference answer.
- `Resume interrupted installs` — import must be resumable in the same way.



---

**Superseded** by epic `churn-mcj1`. The copy-based import described above is out of scope: churn references an existing media library **in place** by pointing `MEDIA_DIR` at it (no copy, no restructuring), and Jellyfin is pointed at one mixed library at that root. Only the optional Jellyfin `config/`+`data/` adoption survives, as child bean `churn-17s1`. See `plans/media-locations.md` and the epic.
