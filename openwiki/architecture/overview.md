---
type: Architecture Overview
title: System architecture overview
description: How the churn installer, the server and torrent Compose stacks, and the TypeScript dashboard fit together, including runtime topology, ports, state locations and configuration flow.
tags: [architecture, deployment, docker-compose, dashboard, installer]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-eb3a4811a02a8c92fe31b44a
    resource: repo://server/backend/src/config.ts
  - id: openwiki-source-39c3a003838d6a98a73bc87c
    resource: repo://server/docker-compose.yml
  - id: openwiki-source-b69ae949f0ed119b89509508
    resource: repo://src/assets.rs
  - id: openwiki-source-50ee81d89346e2a6fc06dbc3
    resource: repo://src/envfile.rs
  - id: openwiki-source-f2ea605531b64a07cd6035e4
    resource: repo://src/ports.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
  - id: openwiki-source-6f79f41844a77e3b22742109
    resource: repo://torrent/docker-compose.yml
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# System architecture overview

churn is three cooperating deliverables rather than one service:

1. **`churn`**, a Rust CLI that collects configuration, writes two Compose stacks, starts them, completes Jellyfin setup and keeps the installation updated (`src/main.rs`, `src/lib.rs`).
2. **Two Compose projects** under `server/` and `torrent/` that run the media services and the VPN-bound download stack.
3. **The dashboard**, a Fastify backend plus React SPA shipped as `ghcr.io/git-monke/churn-dashboard:<version>` and run as a hardened container in the server stack.

A source checkout and a released binary behave the same way; the binary simply embeds the Compose files and scripts with `include_str!` and writes them to disk on every install (`src/assets.rs`).

## Deployment shape

```
host
├── churn binary ──writes/updates──> /var/lib/churn (or the checkout)
│                                    ├── server/{docker-compose.yml,.env,config,cache}
│                                    └── torrent/{docker-compose.yml,.env,config}
│
├── Compose project "server"
│   ├── jellyfin   :8096  ─┐
│   ├── sonarr     :8989   ├─ all mount ${DATA_DIR} at /data
│   ├── radarr     :7878   │
│   ├── server-init (one-shot root-folder bootstrap)
│   └── dashboard  host network :4000  (reads server/.env, config/, torrent config)
│
└── Compose project "torrent"
    ├── gluetun  publishes 8080/9696 on the host, 127.0.0.1:8098 for vpn-status
    ├── vpn-check     (fail-closed startup gate, shares gluetun netns)
    ├── vpn-status    (on-demand leak check for the dashboard, loopback only)
    ├── qbittorrent   (shares gluetun netns)
    ├── prowlarr      (shares gluetun netns)
    ├── flaresolverr  (shares gluetun netns)
    ├── qbittorrent-init (no network; seeds a stable API key)
    └── prowlarr-init    (wires qBittorrent, indexers, Sonarr, Radarr)
```

The dashboard container uses `network_mode: host`, so the backend can reach every upstream over `127.0.0.1` while still presenting a LAN-facing UI. In contrast, the torrent apps deliberately have no independent network namespace: `qbittorrent`, `prowlarr`, `flaresolverr`, `vpn-check` and `vpn-status` all use `network_mode: "service:gluetun"`, and Docker publishes their Web UI ports on the gluetun container (`server/docker-compose.yml`, `torrent/docker-compose.yml`).

## Ports and addressability

| Purpose | Environment variable | Default | Published by |
| --- | --- | --- | --- |
| Jellyfin UI | `JELLYFIN_PORT` | 8096 | `jellyfin` |
| Sonarr UI | `SONARR_PORT` | 8989 | `sonarr` |
| Radarr UI | `RADARR_PORT` | 7878 | `radarr` |
| churn dashboard | `DASHBOARD_PORT` | 4000 | `dashboard` (host network) |
| qBittorrent UI | `QBITTORRENT_PORT` | 8080 | `gluetun` |
| Prowlarr UI | `PROWLARR_PORT` | 9696 | `gluetun` |
| VPN status agent | `VPN_STATUS_PORT` | 8098 | `gluetun`, bound to `127.0.0.1` |

The `Port` enum in `src/ports.rs` is the single source of truth for these defaults, environment keys, owning Compose service and container-side target ports. Every chosen value is written to **both** stack `.env` files because the dashboard and `prowlarr-init` need ports owned by the other stack (`src/stack.rs`).

The VPN status agent is the only intentionally loopback-only listener; the churn backend is its only client (`torrent/docker-compose.yml`).

## State and persistence

The installer's root is resolved by `envfile::root()` in this order:

1. `CHURN_ROOT` when set and non-empty.
2. The current working directory when it contains both `server/docker-compose.yml` and `torrent/docker-compose.yml` (development checkout).
3. `/var/lib/churn` for a released binary run elsewhere.

`src/envfile.rs`, constant `DEFAULT_ROOT`.

Within that root:

| Path | Owner | Contents |
| --- | --- | --- |
| `server/.env` | churn | `DATA_DIR`, `PUID`/`PGID`, `TZ`, host ports, `CHURN_DASHBOARD_IMAGE`, `JELLYFIN_API_KEY` written after setup |
| `torrent/.env` | churn | the same shared values plus WireGuard credentials, `SERVER_COUNTRIES`, `HOST_IP` |
| `server/config`, `server/cache` | Jellyfin/Sonarr/Radarr containers | application SQLite/config and Jellyfin cache |
| `torrent/config` | torrent containers | qBittorrent, Prowlarr and FlareSolverr config |
| Docker volumes `churn-cache`, `churn-state` | dashboard | release/media caches and persisted profiles/sessions |

The installer only treats `server/config`, `server/cache`, `torrent/config` and each `.env` as generated state that uninstall may remove; `DATA_DIR` is never included (`src/stack.rs`, `Stack::state_paths`).

## Configuration flow

Configuration has one direction: interactive answers and host detection become `.env` keys, and Compose plus the dashboard consume those values at runtime.

1. `stack::collect_questions` deduplicates questions across selected stacks, so selecting server and torrent asks for `DATA_DIR` once (`src/stack.rs`).
2. `ask_questions` prefills from any existing `.env`, detects currently published container ports, and resolves port conflicts (`src/main.rs`).
3. `Stack::apply` merges managed keys into each `.env` while preserving unrelated hand-added keys (`src/envfile.rs`, `write_merged`).
4. `assets::materialize` overwrites the Compose file and scripts so they always match the installed binary (`src/assets.rs`).
5. Docker Compose interpolates the `.env`; `server-init` and `prowlarr-init` read API keys directly from generated `config.xml` files.
6. The backend reads process environment first, then `server/.env`, then defaults (`server/backend/src/config.ts`).

## Version coupling

<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
The crate version in `Cargo.toml` is also the dashboard image tag: `stack::dashboard_image()` defaults to `ghcr.io/git-monke/churn-dashboard:<CARGO_PKG_VERSION>` unless `CHURN_DASHBOARD_IMAGE` overrides it (`src/stack.rs`). CI verifies that `Cargo.toml`, `Cargo.lock` and a release tag agree (`scripts/check-version.sh`) and refuses to publish a release until the matching dashboard image exists (`.github/workflows/release.yml`). This coupling is why updating only one half is explicitly supported by `churn update` flags described in [Updates, releases and version pinning](/openwiki/installer/update-and-release.md).

## Runtime dependency on the VPN boundary

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
The torrent stack is fail-closed: `vpn-check` must complete successfully before qBittorrent, Prowlarr, FlareSolverr or `prowlarr-init` start, and churn additionally validates the effective Compose configuration and the Compose network route before `docker compose up` (`src/system.rs`, `src/security.rs`). The full invariant set is documented in [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md).

## Where to go next

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Command behaviour and install flow: [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Generated values and stack files: [Installer provisioning and environment files](/openwiki/installer/provisioning.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Media stack composition: [Server stack topology](/openwiki/stack-topology/server-stack.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Dashboard internals: [Dashboard backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Environment variable reference: [Configuration and operations reference](/openwiki/operations/configuration.md)
