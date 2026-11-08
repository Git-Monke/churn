---
type: Operations Reference
title: Configuration and operations reference
description: Where churn writes generated state, how .env values are merged and overridden, every port and DATA_DIR rule, the dashboard's environment variables and defaults, health checks, logs, and exactly what uninstall removes.
tags: [configuration, env, ports, data-dir, state, health, logs, uninstall]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-eb3a4811a02a8c92fe31b44a
    resource: repo://server/backend/src/config.ts
  - id: openwiki-source-39c3a003838d6a98a73bc87c
    resource: repo://server/docker-compose.yml
  - id: openwiki-source-7075c9448ba68f97f0f9ebf3
    resource: repo://server/README.md
  - id: openwiki-source-50ee81d89346e2a6fc06dbc3
    resource: repo://src/envfile.rs
  - id: openwiki-source-b55a21a31ede1b56cd31a6a6
    resource: repo://src/main.rs
  - id: openwiki-source-f2ea605531b64a07cd6035e4
    resource: repo://src/ports.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
  - id: openwiki-source-1b1c899ac6b7dde30be62ad2
    resource: repo://src/system.rs
  - id: openwiki-source-6f79f41844a77e3b22742109
    resource: repo://torrent/docker-compose.yml
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Configuration and operations reference

<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Everything churn installs lives under one root, each stack owns one `.env`, and the dashboard reads the same file the containers do. This page is the lookup table for those paths, keys and defaults; the installer's question flow is in [Installer provisioning and environment files](/openwiki/installer/provisioning.md).

## Install root

`envfile::root()` resolves the directory holding `server/`, `torrent/` and their `.env` files:

| Condition | Root |
| --- | --- |
| `CHURN_ROOT` set and non-empty | that path |
| current directory contains `server/docker-compose.yml` and `torrent/docker-compose.yml` | current directory |
| otherwise | `/var/lib/churn` (`envfile::DEFAULT_ROOT`) |

The checkout check is what keeps `cargo run` from writing into `/var/lib/churn`. A released binary run anywhere else installs under the default root.

## Generated file layout

```
<root>/
  server/.env
  server/config/{jellyfin,sonarr,radarr}/     # app config
  server/cache/{jellyfin}/                    # app caches
  server/.churn-state/auth-state.json         # dev state dir (container: /app/state)
  torrent/.env
  torrent/config/{gluetun,qbittorrent,prowlarr}/
```

`Stack::state_paths` is the authoritative list of what churn considers generated state (`src/stack.rs:99-105`, shown above): `config`, `cache` (server only) and `.env` per stack. `DATA_DIR` is never in that list.

`<root>` layout in the container differs: the dashboard mounts `server/.env` read-only at `/app/.env`, `server/config` at `/app/config`, the torrent configs at `/torrent/config/*`, and uses named volumes `churn-cache` → `/app/.churn-cache` and `churn-state` → `/app/state`.

## `.env` merge semantics

Writes from the installer go through `envfile::write_merged` (`src/envfile.rs:61-92`):

1. existing keys are read first;
2. every managed key is written in a fixed order after the generated preamble;
3. keys churn does not manage are appended under `# preserved from previous file`.

That is why a hand-added variable survives a rerun. Later, one-off values discovered at runtime (Jellyfin API key, dashboard image pin) go through `envfile::upsert`/`upsert_many`, which rewrite in place, keep comments and ordering, and carry over the file mode so secrets never become world-readable.

Every port is written to **both** stacks. The dashboard and `prowlarr-init` need ports owned by the other stack, and stored values win over defaults on rerun (`src/stack.rs:210-226`).

## Port variables

| Variable | Default | Container target | Stack | Bind |
| --- | --- | --- | --- | --- |
| `JELLYFIN_PORT` | 8096 | 8096 | server | `0.0.0.0` |
| `SONARR_PORT` | 8989 | 8989 | server | `0.0.0.0` |
| `RADARR_PORT` | 7878 | 7878 | server | `0.0.0.0` |
| `DASHBOARD_PORT` | 4000 | same | server | `0.0.0.0` (host network) |
| `QBITTORRENT_PORT` | 8080 | 8080 | torrent | `0.0.0.0` on gluetun |
| `PROWLARR_PORT` | 9696 | 9696 | torrent | `0.0.0.0` on gluetun |
| `VPN_STATUS_PORT` | 8098 | same | torrent | `127.0.0.1` only |

Rules from `src/ports.rs`:

- `validate_port` accepts `1024..=65535` only; privileged ports and non-numerics are rejected.
- `nearest_free` scans upward from the default, then downward, skipping reserved ports — `8080` taken gives `8081`, not `8079`.
- qBittorrent, Prowlarr and the VPN status agent all share gluetun's namespace, so Docker reports their published ports on the `gluetun` service. `Port::published_in` matches by compose service plus target port, and for the VPN agent additionally requires a loopback publisher URL.
- The VPN status agent is the only port bound to `127.0.0.1`.
- `DASHBOARD_PORT` and `VPN_STATUS_PORT` have no fixed container target because the process listens on the same port it publishes.

## `DATA_DIR`

`DATA_DIR` is the single host path mounted as `/data` into Jellyfin, Sonarr, Radarr, qBittorrent and Prowlarr. It is chosen once during install and written to both stacks.

- `PUID`/`PGID` are derived from the owner of `DATA_DIR` (falling back to 1000/1000), so containers write as the same user that owns the media.
- `TZ` is detected from the host.
- Compose uses `${DATA_DIR:?run churn to set DATA_DIR}`, so a missing value fails the stack instead of silently mounting `/`.

## Dashboard environment

Precedence: **process environment → `<root>/server/.env` → built-in defaults** (`loadConfig` in `server/backend/src/config.ts:204-283`). Process environment always wins, which is why `churn update` refuses to change the dashboard image while `CHURN_DASHBOARD_IMAGE` is set in the shell.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Container overrides to `0.0.0.0` |
| `PORT` | 4000 | dev script uses 4001 so it can coexist with a container on 4000 |
| `CHURN_SERVER_DIR` | resolved from the backend module | overrides the `server/` root |
| `CHURN_STATE_DIR` | `server/.churn-state`, container `/app/state` | profiles + `auth-state.json` (0600) |
| `CHURN_SESSION_TTL_MS` | 43 200 000 (12 h) | clamped to 5 min – 30 days, slides on activity |
| `CHURN_COOKIE_SECURE` | `auto` | `auto`/`true`/`false`; invalid values throw |
| `REQUEST_TIMEOUT_MS` | 5000 | 250 – 60 000 |
| `SEARCH_TIMEOUT_MS` | 20000 | 1 000 – 120 000 |
| `RELEASE_TIMEOUT_MS` | 120000 | 30 000 – 300 000 |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | backend-side base URL |
| `JELLYFIN_PUBLIC_URL` | request host, LAN fallback | browser-facing stream URL |
| `JELLYFIN_API_KEY` | — | written by churn after setup |
| `SONARR_URL` / `RADARR_URL` | `…:8989` / `…:7878` | backend-side |
| `SONARR_API_KEY` / `RADARR_API_KEY` | `server/config/<app>/config.xml` | optional override |
| `SONARR_PUBLIC_URL` / `RADARR_PUBLIC_URL` | request host, LAN fallback | browser-facing links |
| `PROWLARR_URL` / `PROWLARR_API_KEY` | `…:9696` / `torrent/config/prowlarr/config.xml` | progressive release search |
| `QBITTORRENT_URL` / `QBITTORRENT_API_KEY` | `…:8080` / `torrent/config/qbittorrent/qBittorrent/qBittorrent.conf` | live progress, grabs, duplicate recovery |
| `INTRODB_URL` / `INTRODB_TIMEOUT_MS` | `https://api.introdb.app` / 5000 | unauthenticated intro/recap/credits |
| `VPN_STATUS_URL` / `VPN_STATUS_TIMEOUT_MS` | `http://127.0.0.1:8098` / 25000 | loopback agent; checks make external requests |
| `CHURN_DASHBOARD_IMAGE` | `ghcr.io/git-monke/churn-dashboard:<cargo version>` | pinned by the installer |
| `JELLYFIN_ADMIN_USER` / `JELLYFIN_ADMIN_PASSWORD` | `admin` / — | optional non-interactive setup; password is not persisted |

Invalid numbers throw at startup with messages such as `invalid PORT: abc`, `invalid REQUEST_TIMEOUT_MS: 10`, `invalid CHURN_SESSION_TTL_MS: 0` and `invalid CHURN_COOKIE_SECURE: maybe`. URL values must be `http`/`https` or `loadConfig` throws `service URL must use http or https: …`.

### Browser-facing URL rewriting

`serviceUrlForRequest` (`server/backend/src/config.ts:358-378`) rewrites a service URL the browser cannot resolve. A loopback host, `localhost`, or a single-label name (a Docker service such as `jellyfin`) is replaced with the hostname the browser used — `x-forwarded-host`, then `forwarded;host=`, then `host` — keeping scheme, port and base path. Without a usable request host it falls back to the detected LAN address, then to the configured URL. Setting `<ID>_PUBLIC_URL` disables the rewrite for that service. Backend probes always keep using `service.url`.

## Torrent stack variables

| Variable | Default | Notes |
| --- | --- | --- |
| `VPN_SERVICE_PROVIDER` / `VPN_TYPE` | `mullvad` / `wireguard` | always written |
| `WIREGUARD_ARCHIVE` / `WIREGUARD_CONFIG` | — | recorded so reruns can prefill the zip and file choice |
| `WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES` | — | private key is written here and nowhere else |
| `SERVER_COUNTRIES` | derived from the config filename | `us-atl-wg-001.conf` → `USA`; hand edits kept |
| `HOST_IP` | auto-detected | must be loopback/LAN; it is the only non-VPN destination the kill switch allows |
| `FLARESOLVERR_URL` | `http://localhost:8191` | shares gluetun's namespace |
| `VPN_STATUS_PORT` | 8098 | loopback only; keep `server/.env` `VPN_STATUS_URL` in sync |

`Stack::preflight` (`src/stack.rs:151-179`) reports, without failing:
- `/dev/net/tun` missing → gluetun cannot start;
- no detectable LAN IP → Prowlarr cannot reach Sonarr/Radarr;
- `HOST_IP` that is not loopback/LAN → the torrent stack will refuse to start.

## Health checks

| What | How |
| --- | --- |
| dashboard image | Dockerfile `HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3`, fetching `http://127.0.0.1:${PORT}/api/health` |
| `GET /api/health` | backend liveness, no session required |
| torrent stack | gluetun's own image healthcheck; `vpn-check`, `qbittorrent-init` and `prowlarr-init` gate on `service_healthy` |
| after `churn update` | `wait_for_dashboard` polls `/api/health` for 60 seconds, then rolls back |

## Logs

- `docker compose logs --tail <n> <service>` is what `system::compose_logs` wraps; `churn update` prints the last 100 dashboard lines on failure.
- Installer and update progress runs `docker compose --ansi never --progress json`, parses the JSON events and keeps one line per process; the retained tail is 200 normalized lines.
- The dev backend logs the resolved browser-facing Jellyfin URL at startup: `video streams follow the request host (fallback …)`. Use it to confirm the LAN/Tailscale fallback that `JELLYFIN_PUBLIC_URL` would override.

## What `churn uninstall` removes

Order matters. `churn uninstall` (`src/main.rs:828-905`):

1. prints the stacks and every `state_paths()` entry, plus the reminder that `DATA_DIR`, media, downloads and images are left untouched;
2. requires confirmation unless `--yes`;
3. runs `docker compose down --remove-orphans --volumes` per stack — this is what deletes the `churn-cache` and `churn-state` volumes, and with them `auth-state.json` and all profiles;
4. only if every `down` succeeded, deletes each `state_paths()` entry (`config/`, `cache/`, `.env`).

A failed `down` aborts before any file is deleted: `could not remove all containers; config files were left untouched`. When Docker is unavailable, container removal is skipped with a warning and only the files are removed.

## Related pages

<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Installer provisioning and environment files](/openwiki/installer/provisioning.md)
<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [churn CLI and orchestration](/openwiki/installer/churn-cli.md)
<!-- openwiki: broken internal link [/openwiki/installer/update-and-release.md] link "/openwiki/installer/update-and-release.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Updates, releases and version pinning](/openwiki/installer/update-and-release.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Server stack topology](/openwiki/stack-topology/server-stack.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Backend architecture](/openwiki/dashboard/backend-architecture.md)
