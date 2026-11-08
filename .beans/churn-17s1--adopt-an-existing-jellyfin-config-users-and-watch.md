---
# churn-17s1
title: Adopt an existing Jellyfin config (users and watch history)
status: todo
type: feature
priority: normal
tags:
    - jellyfin
    - installer
created_at: 2026-11-08T01:16:02Z
updated_at: 2026-11-08T01:16:02Z
parent: churn-mcj1
blocked_by:
    - churn-e6xi
---

## Goal

Optionally adopt an existing Jellyfin config (users, watch history, API keys) so a user
migrating from their own Jellyfin keeps their accounts and progress. Media adoption is
already handled by `MEDIA_DIR` in the earlier children; this one is only about
`config/` + `data/`.

Deliberately last and separately reviewable: it is the only child that can leave an
install in an unrecoverable state.

## Scope

**Config import**

- Before the server stack starts, when the user opts in, copy the existing Jellyfin
  `config/` and `data/` into `server/config/jellyfin` and `server/cache/jellyfin`
  (the bind mounts in `server/docker-compose.yml`). Sizes are small (hundreds of MB), not
  media — a plain copy is fine; no need to reuse `migrate.rs`'s rsync machinery.
- Back up anything already present in those directories before overwriting, and make the
  operation interrupt-safe (temp dir then rename, or a marker file), so a failed import
  leaves a working fresh install.
- Set ownership to `PUID:PGID` on the imported config only (this is churn-created state,
  not user media — the never-chown rule does not apply here).

**Version compatibility**

- The compose file pins `jellyfin/jellyfin:10.11.11`. Read the imported config's version
  marker (or probe the server once it starts) and compare.
- On a mismatch: **warn clearly and stop**, telling the user the pinned version, the
  imported version, and that their original config is untouched. Do not silently let
  Jellyfin migrate a config from a different major version.

**Do not re-provision an adopted install**

- Today `setup_jellyfin` (`src/main.rs:618`) falls back to `jellyfin_credentials`
  (`src/main.rs:765`) whenever no valid `JELLYFIN_API_KEY` exists. After an import:
  - If the imported instance already has a stored key in `.env` that validates, use it.
  - If users exist but no key is available, add an "authenticate as the existing admin"
    path (username + password, password never stored) to mint a churn API key. Do **not**
    rerun the first-run wizard and do **not** create a new admin.
  - If the imported instance has no users, fall back to today's fresh setup.
- After the server is healthy, replay only churn's own settings: `ensure_libraries`
  (single mixed library, per the previous child) and `ensure_tailnet_access`.

**Installer surface**

- One prompt, server stack only: "Do you already have a Jellyfin install to bring over?"
  with a path answer and a "no, start fresh" default. Reruns infer the answer from `.env`
  state (for example `CHURN_IMPORT_JELLYFIN_FROM`) and never re-import. Never record
  passwords.

**Tests**

- Unit: version parsing/comparison, backup-then-copy ordering, marker resume, and that a
  declined import leaves `.env` and the config dirs untouched.
- Mock Jellyfin API: existing key validates → wizard skipped; users exist without a key →
  admin login path used; no users → fresh flow.
- Installer test: `Start fresh` is byte-for-byte today's behaviour.

## Acceptance criteria

- [ ] Declining the import produces an install identical to today's.
- [ ] Importing keeps users, watch history and libraries; no duplicate admin prompt.
- [ ] The dashboard works with the minted/inherited API key after an import.
- [ ] A version mismatch refuses with a clear message and leaves the source untouched.
- [ ] An interrupted import leaves a working fresh install.
- [ ] Passwords are never written to disk or `.env`.
- [ ] `cargo test` green.

## Open questions for review

- Accept a raw `config/` directory only, or also a Jellyfin backup archive?
- Is minting an API key via an existing admin login acceptable, or should churn require the
  user to paste an existing API key into `.env` (simpler, no password handling)?
- Should the prompt live in the normal question flow or in a separate pre-start stage
  (it changes `Stack::questions()` shape and the dry-run plan)?
