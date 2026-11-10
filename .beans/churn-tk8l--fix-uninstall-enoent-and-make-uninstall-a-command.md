---
# churn-tk8l
title: Fix --uninstall ENOENT and make uninstall a command
status: completed
type: bug
priority: normal
created_at: 2026-11-10T21:12:55Z
updated_at: 2026-11-10T21:14:17Z
---

Running uninstall against a stack that was never installed fails with 'failed to remove server' / bare 'No such file or directory (os error 2)', because system::compose_down sets current_dir to a directory that does not exist and Command::spawn fails before docker runs. Also, uninstall should be a command rather than a flag: `churn uninstall` instead of `churn --uninstall`.

## Todo
- [x] Skip a stack whose directory/compose file is missing instead of erroring, reporting it as not installed
- [x] Turn uninstall into a command and reject `--uninstall` with a helpful message
- [x] Update HELP text and docs
- [x] Add tests for the skip path and the argument parsing
- [x] Run tests, clippy and fmt

## Summary of Changes

`churn uninstall` is now a command, and it no longer fails on a stack that was
never installed.

- `src/stack.rs`: added `compose_path()` and `is_installed_in(root)` /
  `is_installed()`; `next_steps` reuses `compose_path()`.
- `src/main.rs`: the removal loop only includes installed stacks, and each
  skipped stack gets one `... is not installed (<dir>) — nothing to remove`
  note, so a never-installed stack no longer reaches `docker compose down` with
  a non-existent `current_dir` (the bare `os error 2`). The docker-availability
  warning now only fires when there is something to remove. The closing line
  distinguishes "nothing to uninstall" from a real uninstall.
- `src/main.rs`: `uninstall` parses as a command; `--uninstall` is rejected with
  "uninstall is a command: run 'churn uninstall'". HELP, USAGE and the combined-
  command error message were updated.
- `README.md`: uninstall section uses `churn uninstall` and documents the skip.
- Tests: `tests::uninstall_is_a_command`, `tests::uninstall_accepts_the_shared_options`,
  `tests::the_old_uninstall_flag_points_at_the_command`,
  `tests::uninstall_cannot_be_combined_with_another_command`, and
  `stack::tests::a_stack_is_installed_only_once_its_compose_file_exists`.
- Verified end to end with `CHURN_ROOT=/tmp/ut` under `unshare -r`: missing
  stacks are skipped and the command exits 0; a stack with a compose file but a
  broken `.env` still stops before deleting config.
