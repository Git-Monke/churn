---
type: Command Reference
title: churn CLI and orchestration
description: The churn binary's command surface and install pipeline, from argument validation and root/Docker preflight through question collection, Compose writes, stack startup, Jellyfin setup, uninstall and read-only show output.
tags: [cli, installer, orchestration, docker, preflight]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-69bbfbd0ddb4b95982624a14
    resource: repo://src/compose.rs
  - id: openwiki-source-c62244efcf002c91434df991
    resource: repo://src/live.rs
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-ef20700b890f582a5dc800e2
    resource: repo://src/show.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
  - id: openwiki-source-1b1c899ac6b7dde30be62ad2
    resource: repo://src/system.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# churn CLI and orchestration

`churn` is one binary with four modes:

| Invocation | Purpose |
| --- | --- |
| `churn` | Interactive install/rerun of the server and/or torrent stack |
| `churn show` | Print installed service URLs; read-only, no root, Docker or TTY |
<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| `churn update` | Update the binary and/or dashboard image (see [Updates, releases and version pinning](/openwiki/installer/update-and-release.md)) |
<!-- openwiki: broken internal link [/openwiki/installer/migration.md] link "/openwiki/installer/migration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| `churn migrate` | Move `DATA_DIR` to a new path (see [Data directory migration](/openwiki/installer/migration.md)) |
| `churn --uninstall` | Stop/remove stack containers and delete generated config |

The top-level module doc and help text in `src/main.rs` describe the same contract.

## Argument parsing and validation

`parse_args` accepts:

- `--stacks <LIST>` / `-s` / `--stacks=<LIST>` — comma-separated `server,torrent`, deduplicated and case-insensitive.
- `--uninstall`, `--dry-run`, `-y/--yes`, `-h/--help`
- `show`, `update`, `migrate`
- `--to <PATH|VERSION>`, `--image <REF>`, `--binary-only`, `--dashboard-only`, `--force`, `--check`
- `--move`/`--delete-old`, `--keep-old`/`--copy`, `--allow-network-fs`

`validate_args` rejects:

- combining `show`, `update`, `--uninstall`, `migrate`;
- update-only options without `update`;
- `--to` without `update` or `migrate`;
- migrate options without `migrate`;
- `--move` with `--keep-old`;
- `--binary-only` with `--dashboard-only`;
- `churn update` for anything except the `server` stack.

Invalid arguments print the message plus help and exit with code `2`. Unknown options are rejected rather than ignored.

`main()` dispatches:

| Mode | Success | Failure | Cancellation |
| --- | --- | --- | --- |
| `show` | 0 | 1 | — |
| `update --check` | 0 | 1 (not up to date or error) | — |
| `update` | 0 | 1 | — |
| `migrate` | 0 | 1 | 130 when interrupted |
| install / uninstall | 0 | 1 | 130 when the user cancels at a prompt |

## Install orchestration

`run(args)` executes these stages in order:

1. `--uninstall` short-circuits to the uninstall flow.
2. `ensure_root()` — reads the real uid from `/proc/self/status`; without root it prints a `sudo` hint and returns `false`.
3. `ensure_docker()` — checks `docker` on `PATH` and `docker compose version`. If missing, it detects Ubuntu/Debian/Fedora/Arch (including derivatives via `ID_LIKE`) and offers to run that distro's install recipe. Declining or an unsupported distro stops the run.
4. `choose_stacks()` — an explicit `--stacks` wins; otherwise a multiselect. The result is sorted so **server starts before torrent**, because `prowlarr-init` needs the Sonarr/Radarr API keys the server stack writes at startup.
5. `preflight()` — reports non-fatal findings and discovers existing published ports:
   - missing `/dev/net/tun` for the torrent stack;
   - an undetected or non-local `HOST_IP` that would break the VPN firewall exception.
6. `stack::collect_questions()` — deduplicates questions across selected stacks, ordered by section (VPN before storage), so `DATA_DIR` is asked once.
7. `ask_questions()` — reads defaults from any existing stack `.env`, then overlays ports observed from running/stopped Compose containers. Ports are resolved by `resolve_port` (stored → free default → nearest free suggestion → prompt).
8. `ensure_data_dir()` — offers to create a missing `DATA_DIR`.
9. `show_plan()` — prints the chosen stacks, answers (masking the WireGuard private key) and the Jellyfin setup note.
10. Confirmation (`--yes` skips it) or cancellation with nothing written.
11. `write_stacks()` — materializes the embedded Compose/script assets, then merges managed values into each `.env`.
12. `start_stacks()` — for the torrent stack, validates the effective Compose isolation and Docker's default route first, then runs `docker compose up -d`. Each stack gets a `LiveLog` view.
<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
13. `setup_jellyfin()` when the server stack was selected — first-run setup, libraries and API key; see [Jellyfin first-run setup from churn](/openwiki/installer/jellyfin-setup.md).
14. Prints per-stack next-step URLs and finishes.

### Dry run

`--dry-run` still asks questions and prints the plan, but writes no assets/`.env`, starts nothing, and replaces Jellyfin setup with an informational line. Its confirmation prompt is phrased "Write these files?" rather than "Write these files and start the services?".

### Preflight and port reuse

`existing_ports()` only inspects stacks that already have a `.env` and a Compose file, so a fresh install stays offline. It runs `docker compose ps --all --format json`, maps publishers back to `Port` values, and separately reads the dashboard container's `PORT` environment because host networking produces no published-port entry.

The reinstall case is deliberate: churn must not treat its own Jellyfin on 8096 as a conflict and move the service. Stored `.env` values win over detection for same-stack ports; detection fills gaps for older `.env` files that predate configurable ports.

### Question flow

`ask_questions` iterates the deduplicated list and prints section notes once. Port questions use `resolve_port`; the WireGuard archive question loops until `mullvad::select_config` succeeds, then stores the archive, chosen config filename, private key and addresses. Every other question delegates to `question.ask`, which supports path autocomplete and prefilled defaults.

## Compose execution and live output

`system::compose_up` runs `docker compose up -d` through `run_streaming`, which drains stdout/stderr on separate threads, reassembles lines on the calling thread and keeps a 200-line tail for failure messages. Compose is invoked with `--progress json` where applicable.

`LiveLog` and `compose::Event` turn that stream into one stable row per process:

- layer events are grouped under their parent image;
- container/network/volume events use their own id;
- on a terminal, the latest line per process is shown under a spinner;
- off a terminal, lines print plainly, and determinate bars print at most once per 10%.

## Uninstall

`--uninstall`:

1. Requires root.
2. Defaults to both stacks, or uses `--stacks`.
3. Prints exactly which generated paths will be deleted.
4. Requires confirmation (`--yes` skips).
5. Unless `--dry-run`, calls `docker compose down --remove-orphans` for each selected stack.
6. If any Compose removal fails, returns before deleting **any** config, so containers and credentials stay consistent.
7. Removes `server/config`, `server/cache`, `torrent/config` and each stack's `.env`.

`DATA_DIR`, images, the Compose files and scripts are left untouched. With Docker unavailable it warns and proceeds to delete only generated files.

## `churn show`

`show_services` calls `churn::show`:

- `installed()` treats a stack as installed only when `<stack>/.env` exists.
- `host_ip()` prefers `CHURN_HOST_IP`, then the persisted `HOST_IP` in `torrent/.env`, then route detection.
- `services()` prints dashboard, Jellyfin, Sonarr, Radarr, qBittorrent, Prowlarr and VPN status, reading each port from either stack's `.env`.
- The VPN status agent is always printed on `127.0.0.1`, because its port is published loopback-only.
- IPv6 hosts are bracketed.

The command never starts or changes anything.

## Cancellation semantics

A user declining a prompt returns `Ok(true)` from the relevant flow ("cancelled — nothing written") rather than an error. An actual interrupt/error returns exit code 130 or prints `failed: ...` and returns 1. Compose failures include the retained output tail.

## Where the pieces live

| Concern | Module |
| --- | --- |
| Argument parsing, orchestration, prompts | `src/main.rs` |
| Stack definitions, questions, `.env` application | `src/stack.rs` |
| Port defaults and conflict resolution | `src/ports.rs` |
| Mullvad archive parsing | `src/mullvad.rs` |
| Embedded assets | `src/assets.rs` |
| `.env` read/merge/atomic write | `src/envfile.rs` |
| Docker/distro/Compose execution | `src/system.rs`, `src/compose.rs` |
| Live terminal output | `src/live.rs` |
| Jellyfin API provisioning | `src/jellyfin.rs` |
| Read-only URL listing | `src/show.rs` |
| Migration | `src/migrate.rs` |
| Self/dashboard update | `src/update.rs` |

## Relevant tests

`tests/installer.rs` covers question deduplication and stack-specific questions, `tests/system.rs` covers distro detection, `tests/jellyfin.rs` exercises provisioning against a fake Jellyfin, and `tests/migrate.rs` covers rsync progress plumbing. Unit tests in `src/ports.rs`, `src/stack.rs`, `src/compose.rs`, `src/envfile.rs`, `src/show.rs` and `src/security.rs` cover the pure logic.

## Related pages

<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Installer provisioning and environment files](/openwiki/installer/provisioning.md)
<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Jellyfin first-run setup from churn](/openwiki/installer/jellyfin-setup.md)
<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Updates, releases and version pinning](/openwiki/installer/update-and-release.md)
<!-- openwiki: broken internal link [/openwiki/installer/migration.md] link "/openwiki/installer/migration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Data directory migration](/openwiki/installer/migration.md)
