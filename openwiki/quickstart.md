---
type: Quickstart
title: Churn quickstart
description: Entry point for the repository wiki — what churn is, how the installer, the two Compose stacks and the dashboard fit together, and which page to read for each task.
tags: [quickstart, index, routing, overview]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-84d9c8d9032517d6b9bf87c5
    resource: repo://docs/src/SUMMARY.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-7075c9448ba68f97f0f9ebf3
    resource: repo://server/README.md
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Churn quickstart

`churn` installs and maintains a small self-hosted media stack on Linux: a Rust installer that writes and starts two Docker Compose projects, plus a TypeScript dashboard that ties them together.

```
churn (Rust CLI)                      ┌── server stack ──────────────┐
  install / show / update   ────────► │ Jellyfin  Sonarr  Radarr     │  ports 8096, 8989, 7878
  migrate / uninstall                 │ + one-shot server-init       │
                                      │ + dashboard container        │  port 4000
                                      └──────────────────────────────┘
                                      ┌── torrent stack ─────────────┐
                                      │ gluetun (Mullvad WireGuard)  │  owns the namespace
                                      │ qBittorrent  Prowlarr        │  ports 8080, 9696
                                      │ FlareSolverr                 │
                                      │ + vpn-check / prowlarr-init  │
                                      └──────────────────────────────┘
```

Both stacks mount one host directory at `/data`, so Jellyfin and qBittorrent agree on media paths. They talk to each other over `HOST_IP` and read each other's API keys from the sibling `config/` directory, which assumes both stacks run on the same machine.

## The three deployables

| Piece | Language | Entry point | Role |
| --- | --- | --- | --- |
| Installer | Rust 2024 | `src/main.rs` | asks questions, writes `server/` and `torrent/` assets and `.env` files, verifies the VPN boundary, starts stacks, finishes Jellyfin setup |
| Server stack | Compose + shell | `server/docker-compose.yml` | Jellyfin, Sonarr, Radarr, a one-shot initializer, and the dashboard container |
| Torrent stack | Compose + shell | `torrent/docker-compose.yml` | Gluetun owning the network namespace, qBittorrent, Prowlarr, FlareSolverr and two initializers |
| Dashboard | TypeScript (Fastify + React) | `server/backend/src/index.ts` | a backend-for-frontend over Jellyfin/Sonarr/Radarr plus the VPN status agent, serving a React SPA |

## First run in brief

```bash
curl -fsSL https://raw.githubusercontent.com/Git-Monke/churn/main/install.sh | sudo sh
sudo churn
```

`churn` requires root, checks Docker (offering a distro-specific install), asks for a Mullvad WireGuard zip, a data directory and any non-default ports, then writes the stacks, pulls the dashboard image and starts them. Follow-ups: `sudo churn update`, `churn show`, `sudo churn uninstall`.

<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Full detail: [Provisioning and first-run flow](/openwiki/installer/provisioning.md).

## Routing map

### I want to install or operate it

| Task | Page |
| --- | --- |
<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Run the installer, understand the wizard and its preflight checks | [Provisioning and first-run flow](/openwiki/installer/provisioning.md) |
<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Know every CLI mode, flag and exit code | [churn CLI](/openwiki/installer/churn-cli.md) |
<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Understand the Jellyfin wizard, API key and library setup | [Jellyfin setup](/openwiki/installer/jellyfin-setup.md) |
<!-- openwiki: broken internal link [/openwiki/installer/migration.md] link "/openwiki/installer/migration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Move an existing install to a new host or data disk | [Migration](/openwiki/installer/migration.md) |
<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Update the binary and dashboard, or cut a release | [Release and update flow](/openwiki/installer/update-and-release.md) |
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Look up a config key, port, path or log location | [Configuration and operations reference](/openwiki/operations/configuration.md) |
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Diagnose "is my traffic actually going through the VPN?" | [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md) |

### I want to understand the architecture

| Task | Page |
| --- | --- |
<!-- openwiki: broken internal link [/openwiki/architecture/overview.md] link "/openwiki/architecture/overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Get the whole picture in one page | [System architecture overview](/openwiki/architecture/overview.md) |
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Understand the server stack's services, mounts and hardening | [Server stack topology](/openwiki/stack-topology/server-stack.md) |
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Understand qBittorrent/Prowlarr/FlareSolverr and how they self-configure | [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md) |
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Understand the kill switch, DNS, IPv6 and the preflight guards | [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md) |

### I want to work on the dashboard

| Task | Page |
| --- | --- |
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| See how the Fastify BFF is structured and what it caches | [Backend architecture](/openwiki/dashboard/backend-architecture.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/frontend.md] link "/openwiki/dashboard/frontend.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| See the React app's routing, state and styling | [Dashboard frontend](/openwiki/dashboard/frontend.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/auth-and-profiles.md] link "/openwiki/dashboard/auth-and-profiles.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Work on login, sessions, users and profiles | [Auth and profiles](/openwiki/dashboard/auth-and-profiles.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/release-discovery.md] link "/openwiki/dashboard/release-discovery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Work on release search, ranking and direct grabs | [Release discovery](/openwiki/dashboard/release-discovery.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/downloads-and-sync.md] link "/openwiki/dashboard/downloads-and-sync.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Work on downloads, imports, queue and recovery | [Downloads and sync](/openwiki/dashboard/downloads-and-sync.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/library-and-requests.md] link "/openwiki/dashboard/library-and-requests.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Work on the library, shows, episodes and requests | [Library and requests](/openwiki/dashboard/library-and-requests.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/playback.md] link "/openwiki/dashboard/playback.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Work on playback, resume, subtitles and intro skipping | [Playback](/openwiki/dashboard/playback.md) |
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Understand how Jellyfin/Sonarr/Radarr/qBittorrent/Prowlarr are called | [Upstream integrations](/openwiki/dashboard/upstream-integrations.md) |

### I want to change code

| Task | Page |
| --- | --- |
<!-- openwiki: broken internal link [/openwiki/testing/testing-strategy.md] link "/openwiki/testing/testing-strategy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| Know what to run and what CI enforces | [Testing strategy and CI](/openwiki/testing/testing-strategy.md) |

## Where things live

| Path | Contents |
| --- | --- |
| `src/` | installer crates: `main.rs` dispatch, `stack.rs` assets and `.env`, `system.rs` root/Docker/compose, `security.rs` VPN audit, `jellyfin.rs`, `migrate.rs`, `update.rs`, `ports.rs`, `question.rs` |
| `tests/` | Rust integration tests (fake HTTP server, fake rsync, zip fixtures, os-release parsing) |
| `server/backend/src/` | Fastify BFF, ~40 modules plus `routes/` |
| `server/frontend/src/` | React SPA, feature folders under `features/` |
| `server/scripts/`, `torrent/scripts/` | one-shot initializers and the VPN check/status agents |
| `openwiki/` | this wiki |
| `docs/` | mdBook user documentation (introduction, server, web UI, torrent) |
| `.github/workflows/` | dashboard image, release, OpenWiki update |

<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Runtime state (created by `churn`, not committed): `server/.env`, `server/config/<service>/`, `torrent/.env`, `torrent/config/<service>/`, and the data directory. See [Configuration and operations reference](/openwiki/operations/configuration.md).

## Reading order for newcomers

<!-- openwiki: broken internal link [/openwiki/architecture/overview.md] link "/openwiki/architecture/overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
1. [System architecture overview](/openwiki/architecture/overview.md) — the topology and the data flow.
<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
2. [churn CLI](/openwiki/installer/churn-cli.md) — how the installer gets you there.
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
3. [Server stack topology](/openwiki/stack-topology/server-stack.md) and [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md) — what actually runs.
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
4. [Backend architecture](/openwiki/dashboard/backend-architecture.md) — how the UI reaches it all.

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Security-sensitive work should start at [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md) instead; the fail-closed invariants there are enforced by both Compose and `src/security.rs`, and a change to either side breaks the installer's preflight.

## Related pages

<!-- openwiki: broken internal link [/openwiki/architecture/overview.md] link "/openwiki/architecture/overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [System architecture overview](/openwiki/architecture/overview.md)
<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Provisioning and first-run flow](/openwiki/installer/provisioning.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/testing/testing-strategy.md] link "/openwiki/testing/testing-strategy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Testing strategy and CI](/openwiki/testing/testing-strategy.md)
