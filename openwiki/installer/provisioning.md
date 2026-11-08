---
type: Provisioning Workflow
title: Installer provisioning and environment files
description: How installer questions become answers, how host ports are chosen and reused, how Mullvad WireGuard archives are parsed, how embedded stack assets are materialized, and how .env values are merged.
tags: [installer, provisioning, env, ports, mullvad, assets]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-b69ae949f0ed119b89509508
    resource: repo://src/assets.rs
  - id: openwiki-source-50ee81d89346e2a6fc06dbc3
    resource: repo://src/envfile.rs
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-9279f527d0654cab96ef56b5
    resource: repo://src/mullvad.rs
  - id: openwiki-source-f2ea605531b64a07cd6035e4
    resource: repo://src/ports.rs
  - id: openwiki-source-828528a3225f1b6161c76ddc
    resource: repo://src/question.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
  - id: openwiki-source-fd81537e52881c1d4eb8b4ae
    resource: repo://tests/installer.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Installer provisioning and environment files

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
The installer asks only what it cannot derive, writes one `.env` per selected stack plus static Compose assets, and preserves hand-edited values on rerun. This page covers the data flow behind those writes; command modes and startup order are in [churn CLI and orchestration](/openwiki/installer/churn-cli.md).

## Questions, sections and deduplication

Each stack declares its questions in `src/stack.rs`:

| Stack | Questions |
| --- | --- |
| server | `DataDir`, ports for Jellyfin, Sonarr, Radarr, Dashboard |
| torrent | `WireguardArchive`, `DataDir`, ports for qBittorrent, Prowlarr, VPN status |

`collect_questions` walks sections in `Vpn` → `Storage` order and adds each unique question once. Selecting both stacks therefore asks for one data directory, and the VPN archive is asked before storage even though the torrent stack is second.

`choose_stacks` uses `--stacks` when given, otherwise a multiselect prompt, and always sorts the result so server starts before torrent.

## Prefilling from previous runs

`ask_questions` builds defaults from both stacks' `.env` files:

- A port default is taken only from the stack that owns that port; the other stack's copy may be stale after a partial install.
- Non-port answers use the first stack that has them, so a torrent-only rerun still reuses the media path chosen by the server installer.
- Ports published by already-running churn containers are added as defaults. This matters for older `.env` files that predate configurable ports: without it, churn's own listeners would look like conflicts.

`existing_ports` inspects Compose projects only for stacks that already have generated state, so a fresh install stays offline and does not run `docker compose ps` against nothing.

## Port resolution

Port defaults are the conventional service ports:

| Service | Default | Published by |
| --- | --- | --- |
| Jellyfin | 8096 | `jellyfin` |
| Sonarr | 8989 | `sonarr` |
| Radarr | 7878 | `radarr` |
| Dashboard | 4000 | `dashboard` |
| qBittorrent | 8080 | `gluetun` (shared namespace) |
| Prowlarr | 9696 | `gluetun` |
| VPN status | 8098 | `gluetun`, loopback only |

`resolve_port` applies these rules in order:

1. A stored port that validates and is not already assigned in this run is reused silently. Reruns do not churn ports.
2. If the default is unassigned and bindable, it is used without prompting.
3. Otherwise `nearest_free` scans upward from the default, then downward, skipping ports already assigned and every other service's default. Upward-first keeps the common case predictable (`8080` taken → `8081`).
4. With `--yes`, the suggestion is accepted with a warning.
5. Otherwise the user is prompted with the suggestion as the default; a reserved or in-use answer is rejected and re-prompted.

Validation accepts only `1024..=65535`. `is_free` binds on the address the service will actually use; the VPN status agent binds `127.0.0.1`, everything else `0.0.0.0`.

When reading an existing installation, `Port::published_in` matches publishers by Compose service and target port, and for the status agent additionally requires a loopback URL. This lets a rerun adopt a moved host port such as `8081 -> 8080`.

## Mullvad WireGuard archives

`Question::WireguardArchive` accepts a `.zip` of `.conf` files. The prompt supports path completion and expands `~`; under `sudo`, `~/...` resolves against the invoking account from `/etc/passwd` (`SUDO_USER`/`SUDO_UID`), not root's home.

`mullvad::entries` lists non-directory entries ending in `.conf`, sorts them and rejects an archive with none. Every file in a Mullvad download shares the same private key and interface address, so `select_config` takes the first sorted entry rather than asking the user to choose among hundreds.

`parse` reads the INI text and:

- takes `PrivateKey`, validates it as base64 decoding to exactly 32 bytes (catching the account key being pasted instead of a WireGuard key);
- takes `Address`, selects the first entry that parses as IPv4, and validates CIDR form and prefix `<= 32`.

The archive path, selected entry name, private key and address are stored as `WIREGUARD_ARCHIVE`, `WIREGUARD_CONFIG`, `WIREGUARD_PRIVATE_KEY` and `WIREGUARD_ADDRESSES`. The private key is masked in the plan summary.

`server_countries` derives `SERVER_COUNTRIES` from the selected filename (for example `us-atl-wg-001.conf` → `USA`) using a 50-country ISO map. A hand-edited non-default value wins. The legacy hardcoded value `Netherlands` is treated as generated state and replaced by the derived country on rerun. Unknown filenames fall back to an existing value or `Netherlands`.

## Embedded stack assets

A released binary runs without a source checkout, so Compose files and scripts are compiled in with `include_str!` (`src/assets.rs`) and written to `<root>/<stack>/` on every install and rerun.

| Stack | Assets |
| --- | --- |
| server | `docker-compose.yml` (0644), `scripts/server-init.sh` (0755) |
| torrent | `docker-compose.yml`, `resolv.conf` (0644), `scripts/prowlarr-init.sh`, `scripts/qbittorrent-init.sh`, `scripts/vpn-check.sh`, `scripts/vpn-lib.sh`, `scripts/vpn-status.sh` (0755) |

Each file is written to a temporary sibling, given its mode, then renamed into place, so a running stack never reads a half-written script. Reruns overwrite modified assets: the Compose files and scripts are always those of the installed binary. `.env`, generated config and caches are untouched.

Asset paths are relative and checked by tests never to contain `..`.

## Environment file generation

`Stack::apply` builds an ordered `managed` list and calls `envfile::write_merged`:

```
DATA_DIR, PUID, PGID, TZ,
JELLYFIN_PORT, SONARR_PORT, RADARR_PORT, DASHBOARD_PORT,
QBITTORRENT_PORT, PROWLARR_PORT, VPN_STATUS_PORT,
[server] CHURN_DASHBOARD_IMAGE
[torrent] VPN_SERVICE_PROVIDER=mullvad, VPN_TYPE=wireguard,
          WIREGUARD_ARCHIVE, WIREGUARD_CONFIG, WIREGUARD_PRIVATE_KEY,
          WIREGUARD_ADDRESSES, SERVER_COUNTRIES, HOST_IP
```

Key behaviors:

- **Every host port is written to both stacks.** The dashboard and `prowlarr-init` need ports owned by the other stack. Answers win, then stored values from either `.env`, then the default.
- **Rerun values survive.** `write_merged` reads the existing file, writes the managed keys in a fixed order after a generated preamble, then appends every unmanaged key under `# preserved from previous file`.
- **Dashboard image** is `ghcr.io/git-monke/churn-dashboard:<version>` unless `CHURN_DASHBOARD_IMAGE` overrides it (trimmed, non-empty).
- **VPN provider and type** are always forced to `mullvad`/`wireguard`.
- **HOST_IP** is written only when detection finds a non-loopback address, so a hand-edited value is kept when detection fails.

`write_merged` creates parent directories and replaces the whole file. In-place updates (`envfile::upsert`) are reserved for values that appear later, such as `JELLYFIN_API_KEY`, and preserve comments and ordering.

### Ownership

`PUID`/`PGID` come from the data directory's owner, falling back to the invoking process's uid/gid from `/proc/self/status` when the directory does not exist yet. Containers then create files as the same user that owns the media tree.

### Timezone

`TZ` resolution order: the `TZ` environment variable, `/etc/timezone`, the target of `/etc/localtime` after `zoneinfo/`, then `UTC`.

### Host IP

`HOST_IP` resolution order: `CHURN_HOST_IP`, then the source address the kernel would use for an internet route (a UDP connect that sends no packets, so it is offline-safe), then `127.0.0.1`. The address matters because Prowlarr inside gluetun's namespace and Sonarr/Radarr in the server stack cannot use `localhost` across namespaces; the host LAN address works for both on one machine.

## Root selection and paths

Generated state lives under `envfile::root()`:

1. `CHURN_ROOT`, when set and non-empty;
2. the current directory when it looks like a checkout (both Compose files present);
3. `/var/lib/churn`.

The data directory itself is created after the plan is confirmed if it does not exist, with a y/N prompt whose default is yes. Declining aborts with an interrupted error.

## Relevant tests

- `tests/installer.rs`: one data-dir question for both stacks, section order, secret masking, env rewrite preserving hand-added keys, upsert not reformatting a file, country derivation, and config parser/archive rejection.
- `src/ports.rs`: distinct defaults, validation bounds, upward-then-downward search, reserved-port skipping, and published-port matching.
- `src/assets.rs`: every asset lands with the expected content and mode, reruns replace hand edits, and paths stay inside the stack root.
- `src/envfile.rs`: root override/checkout/default selection, owner fallback, timezone and host-IP behavior.
- `src/stack.rs`: dashboard image override, server-before-torrent start order, country migration, and uninstall state paths.

## Related pages

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Server stack topology](/openwiki/stack-topology/server-stack.md)
