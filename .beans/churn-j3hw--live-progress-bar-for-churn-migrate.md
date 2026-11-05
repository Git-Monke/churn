---
# churn-j3hw
title: Live progress bar for churn migrate
status: completed
type: feature
priority: normal
tags:
    - cli
    - storage
created_at: 2026-11-05T19:45:22Z
updated_at: 2026-11-05T19:53:37Z
---

`churn migrate` showed a frozen spinner for the whole copy: `migrate::copy` already passed `--info=progress2` to rsync, but `LiveLog::push` only accepted `docker compose` JSON, so every rsync progress frame was dropped.

Plan: `plans/migrate-progress-bar.md`

- [x] Parse `--info=progress2` frames in `migrate.rs` into a typed `CopyEvent::Progress`; unit-test the parser
- [x] Add a determinate `LiveLog::progress` variant with non-tty decile throttling and Ctrl-C-safe `Drop`
- [x] Switch `migrate_storage` to the bar when rsync is present, spinner for the `cp -a` fallback
- [x] Filter progress frames out of the rsync error tail
- [x] Docs: one sentence in `docs/src/server.md` migrate section
- [x] `cargo test`, `cargo fmt --check`, `cargo clippy` clean

## Deferred

Count-aware spinners for `plan`/`scan_tree`, `verify_tree` (would need `Plan::total_files`) and `remove_old_data` were dropped by request; the copy bar was the goal.

## Summary of Changes

- `src/migrate.rs`: new `Progress2` struct and `CopyEvent::{Progress,Line}`; `parse_progress2` (hand-rolled, no new deps, rejects anything that is not a progress frame); `copy` takes a typed callback and strips progress frames from the rsync failure tail.
- `src/live.rs`: `LiveLog::progress(title, len)` draws a determinate cliclack bar (detail line + bar line) and `LiveLog::update(position, detail)` moves it; non-terminal output is throttled to one line per decile.
- `src/main.rs`: `migrate_storage` renders the bar when rsync is installed and keeps the spinner for the `cp -a` fallback; `copy_detail` formats bytes/rate/ETA/file counts without claiming a total, because rsync's percentage is relative to the bytes still to transfer.
- `tests/migrate.rs`: fake `rsync` on `PATH` proves frames reach the callback and that the failure message keeps the rsync complaint.
- `docs/src/server.md`: documents the live progress and the non-terminal throttle.
