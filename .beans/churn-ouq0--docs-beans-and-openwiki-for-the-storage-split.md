---
# churn-ouq0
title: Docs, beans and OpenWiki for the storage split
status: todo
type: task
priority: normal
tags:
    - docs
created_at: 2026-11-08T01:16:03Z
updated_at: 2026-11-08T01:16:03Z
parent: churn-mcj1
blocked_by:
    - churn-17s1
---

## Goal

Document the two storage locations and the adopt-in-place flow, retire the superseded
beans, and refresh the OpenWiki pages. Purely docs/bean bookkeeping — no behaviour change.

## Scope

**Docs** (`docs/src/` contains `introduction.md`, `server.md`, `SUMMARY.md`,
`torrent.md`, `web-ui.md`)

- `docs/src/server.md` — "Storage" section (lines ~19-48 today): the `MEDIA_DIR` answer,
  what it mounts, that its default keeps today's layout, and the adopt-in-place flow
  (point `MEDIA_DIR` at an existing library; Jellyfin types items itself; new downloads
  land in `movies/`/`tv`). Replace the current claims that media must live under
  `/data/media` (lines ~20, 27-28, 39-43, 48).
- `docs/src/server.md` — state the hard rule: the download directory (`DOWNLOAD_DIR`) must
  not be equal to or inside `MEDIA_DIR`, and why (Jellyfin would index partial downloads).
  Update the sentence about removing a `/data` library path (line ~43) to say the library
  is now a single mixed one at the media root. Document the prompts in the order they are
  asked, including the SSD-for-downloads / HDD-or-NAS-for-media recommendation, and note
  that an older `.env` holding `DATA_DIR` is migrated to `DOWNLOAD_DIR` on rerun.
- `docs/src/server.md` / `torrent.md` — the rename is user-visible: every mention of
  `DATA_DIR` in prose becomes `DOWNLOAD_DIR`, with one upgrade note that the old key is
  still accepted.
- `docs/src/torrent.md:123`, `docs/src/introduction.md:27`, `docs/src/web-ui.md:240` —
  update any `/data/media` path claims and the library-layout description.
- Note for existing installs: nothing changes unless `MEDIA_DIR` is set to a different path.

**Beans**

- Declare this epic and its children authoritative. Update the old `churn-jl2c` and
  `churn-jmu7` beans' bodies so they no longer contradict the design (mark them superseded
  with a pointer to the epic), or archive them once the children land.
- Note on `churn-eeni` (`Relocate data with a churn migrate command`) that `migrate` must
  now also carry `MEDIA_DIR` (`src/migrate.rs:158-188` detection, `write_envs` at
  `src/migrate.rs:781`).

**OpenWiki**

- Pages covering installer questions, storage layout and Jellyfin provisioning need a
  refresh. Follow the repository's documented OpenWiki maintenance process: check its
  configuration and completed runs before relying on automatic updates, then trigger a run
  through the documented workflow.
- Do not hand-edit generated OpenWiki pages.

## Acceptance criteria

- [ ] Docs describe the `MEDIA_DIR` question, its default, the nesting rule and the
      adopt-in-place flow.
- [ ] No doc still claims media must live under `<data>/media`.
- [ ] Superseded beans point at the epic.
- [ ] `churn-eeni` notes the `MEDIA_DIR` follow-up.
- [ ] OpenWiki pages refreshed via the documented process (or a recorded reason why a run
      was not needed).
- [ ] The docs build succeeds (mdBook: `mdbook build docs` or the repo's documented command).
