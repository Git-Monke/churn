---
# churn-jmu7
title: Separate media and download locations
status: scrapped
type: feature
priority: normal
tags:
    - storage
created_at: 2026-11-05T04:05:39Z
updated_at: 2026-11-08T01:16:06Z
---

## Problem

churn currently collects one `DATA_DIR` and mounts it at `/data` in every container. Media libraries, qBittorrent's save path, its incomplete temp path, and Sonarr/Radarr imports all live under that single path.

That works on one machine, but it forces a compromise when a user wants to stream from a media drive while downloads happen on a fast local disk. With one mount, a qBittorrent download writes to the same drive Jellyfin is reading from, which can cause I/O contention/stutter and makes it impossible to put scratch data on a small SSD while media lives on a large HDD.

## Desired behaviour

Two storage locations instead of one:

- **Media location** (`DATA_DIR`, current behaviour) — the final library. Mounted at `/data` everywhere. Jellyfin libraries stay pinned to subfolders here (`/data/media/movies`, `/data/media/tv`).
- **Download location** (`DOWNLOAD_DIR`) — qBittorrent's save and incomplete paths. **Defaults to `DATA_DIR`**, so a fresh install and all existing installs keep working exactly as they do now. Users can optionally point it at another host path (for example an SSD).
- The installer asks for the download location only after the media location, and prefills `DATA_DIR` as the default so pressing Enter keeps today's single-location layout.
- When the two differ:
  - qBittorrent saves completed torrents under the download location and uses a temp/incomplete folder there.
  - Sonarr/Radarr must see the download location at a container path that matches what qBittorrent reports, so imports need no remote path mapping. They import (move/copy) from downloads into the media location as usual.
  - Jellyfin must never index the download staging folder; libraries remain restricted to the media subfolders.
- Reruns prefill the stored value, and choosing the same path as `DATA_DIR` is valid and collapses back to the single-location layout.

## Implementation sketch

- Add `Question::DownloadDir` (`DOWNLOAD_DIR`) next to `DataDir` in `src/question.rs`: same absolute-path/writability validation, default `DATA_DIR`, directory suggestions.
- `src/stack.rs::apply` writes `DOWNLOAD_DIR` to both `.env` files; `src/main.rs::ensure_data_dir` and the install plan/summary handle both paths.
- Compose mounts:
  - Media at `${DATA_DIR}:/data` as today (server, torrent, `server-init`, dashboard env as needed).
  - Downloads at `${DOWNLOAD_DIR}:/downloads` in qBittorrent, Sonarr, Radarr and `server-init`. A distinct `/downloads` path avoids nested-bind subtleties and keeps media paths stable independent of where downloads live.
  - When `DOWNLOAD_DIR == DATA_DIR`, keep qBittorrent on its current `/data/` paths and skip the extra mount so existing installs are untouched. When split, qBittorrent switches to `/downloads/` and `/downloads/incomplete/`, and the init script must rewrite those paths (including for existing configs, not only the seed config).
- `torrent/scripts/qbittorrent-init.sh`: seed `Downloads\SavePath` / `Downloads\TempPath` from the configured download root instead of hardcoded `/data/`, and update an existing config on rerun when the paths differ.
- `torrent/scripts/prowlarr-init.sh`: no change if Sonarr/Radarr mount the download path at the same container path qBittorrent reports; confirm no remote path mapping is needed.
- `server/scripts/server-init.sh`: create the download root and incomplete folder with `PUID:PGID`, and keep arr root folders on `MEDIA_ROOT`.
- Dashboard direct grabs (`server/backend/src/direct-grab.ts`) bypass the arr and currently save straight into the media root. Decide/document: keep direct grabs in the media root (they are final-location downloads and start streaming when done) or add a completion move into the media root. Keeping them in the media root is the smaller first step and avoids a new background mover.
- README + `docs/src/server.md`, `docs/src/torrent.md`, `docs/src/introduction.md`: document the two locations, the default, and the streaming-vs-download trade-off.

## Acceptance criteria

- [ ] Fresh install with defaults produces the same `/data` paths as today (no regression).
- [ ] Setting a different download location makes qBittorrent save/temp under `/downloads`, while media stays under `/data/media`.
- [ ] Sonarr/Radarr can import a completed torrent from the download location into the media location without remote path mapping.
- [ ] Jellyfin libraries never point at the download staging folder.
- [ ] Rerun prefill works for both locations and validates them independently.
- [ ] Existing installs are not rewritten unless the user changes a location.

## Open questions

- Exact prompt order/copy: ask both even when only one stack is selected (answers shared), consistent with the current single storage question.
- Should `churn show` / the dashboard surface the download location and free space? Probably a follow-up.
- qBittorrent path rewriting for existing torrents: preserve seeding by relocating files and updating paths, or accept that the user re-checks after migration (the migrate bean should cover this).

## Related

- `Relocate data with a churn migrate command` — must handle both locations once this lands.



---

**Superseded** by epic `churn-mcj1` (Separate media and download locations, adopt an existing library in place) after a design session. The final design differs from this bean: no `DOWNLOAD_DIR`/`/downloads` third path — `DATA_DIR` stays the download root at `/data` and a new `MEDIA_DIR` mounts at `/data/media`. See `plans/media-locations.md` and the epic for the authoritative design.
