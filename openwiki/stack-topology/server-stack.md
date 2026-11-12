---
type: Stack Topology
title: Server stack topology
description: The server Compose stack — Jellyfin, Sonarr, Radarr, the one-shot server-init bootstrap, and the hardened host-networked dashboard container — including images, mounts, root folders and how configuration reaches each service.
tags: [compose, server-stack, jellyfin, sonarr, radarr, dashboard, server-init, containers]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-39c3a003838d6a98a73bc87c
    resource: repo://server/docker-compose.yml
  - id: openwiki-source-11188a592edb7e1f2a5551d1
    resource: repo://server/Dockerfile
  - id: openwiki-source-7075c9448ba68f97f0f9ebf3
    resource: repo://server/README.md
  - id: openwiki-source-be63d498b9a50e07ebfeeddc
    resource: repo://server/scripts/server-init.sh
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Server stack topology

The server stack (`server/docker-compose.yml`) runs the media server, the two arr apps, a one-shot bootstrap container and the churn dashboard. All of them read a single generated `.env`, share one `DATA_DIR`, and never talk to the internet through a VPN — that boundary belongs to the torrent stack.

## Services

| Service | Image | Host port | Restart |
| --- | --- | --- | --- |
| `jellyfin` | `jellyfin/jellyfin:10.11.11` | `${JELLYFIN_PORT:-8096}` → 8096 | `unless-stopped` |
| `sonarr` | `lscr.io/linuxserver/sonarr:4.0.20.3014-ls1` | `${SONARR_PORT:-8989}` → 8989 | `unless-stopped` |
| `radarr` | `lscr.io/linuxserver/radarr:6.4.4.10685-ls324` | `${RADARR_PORT:-7878}` → 7878 | `unless-stopped` |
| `server-init` | `curlimages/curl:8.23.0` | none | `"no"` (one-shot) |
| `dashboard` | `${CHURN_DASHBOARD_IMAGE:-ghcr.io/git-monke/churn-dashboard:latest}` | host network, `${DASHBOARD_PORT:-4000}` | `unless-stopped` |

Images are version-pinned in the Compose file rather than floated. Only the dashboard reference is variable, and the installer pins it to the matching release tag; the `latest` default is a safety net for older installs such as a `compose down` during uninstall.

## Shared data and configuration mounts

| Container path | Source | Services |
| --- | --- | --- |
| `/data` | `${DATA_DIR:?run churn to set DATA_DIR}` | jellyfin, sonarr, radarr, server-init |
| `/config` | `./config/<service>` | jellyfin, sonarr, radarr |
| `/cache` | `./cache/jellyfin` | jellyfin only |
| `/sonarr-config/config.xml`, `/radarr-config/config.xml` | `./config/sonarr`, `./config/radarr` (read-only) | server-init |

`DATA_DIR` uses Compose's `:?` form, so an unset value fails the stack instead of mounting `/`. The arr apps keep `/config` and `/data` on separate mounts, which is what lets their root folders be registered without any path mapping.

Ownership comes from `.env`: Jellyfin runs as `user: "${PUID:-1000}:${PGID:-1000}"`, and Sonarr/Radarr receive `PUID`, `PGID` and `TZ` as LinuxServer environment variables. `PUID`/`PGID` were derived from the owner of `DATA_DIR` at install time.

## `server-init` bootstrap

`server-init` is a one-shot root container that makes the media tree and arr root folders exist before anyone browses:

```yaml
entrypoint: ["/bin/sh", "/server-init.sh"]
depends_on:
  sonarr: { condition: service_started }
  radarr: { condition: service_started }
```

`server/scripts/server-init.sh` is idempotent and safe to re-run after config changes:

1. `mkdir -p /data/media/tv /data/media/movies` and `chown $PUID:$PGID` the three paths (`MEDIA_ROOT` overrides `/data/media`).
2. `wait_for_key` polls `config.xml` for `<ApiKey>` until both apps have written one — the API key does not exist on a first boot, so this is a file watcher, not an HTTP call.
3. `wait_for` probes `/api/v3/system/status` on each app with that key.
4. `ensure_root_folder` lists `GET /api/v3/rootfolder` and only `POST`s `{"path": "/data/media/tv"}` (Sonarr) or `{"path": "/data/media/movies"}` (Radarr) when the path is absent.

Every wait is bounded by `INIT_TIMEOUT_SECONDS` (default 180) and exits non-zero with `timed out after 180s waiting for …` rather than hanging. Because it is `restart: "no"`, a failed bootstrap shows up as an exited container and never loops.

## Dashboard container

The dashboard is the only service with a bespoke security posture:

```yaml
image: ${CHURN_DASHBOARD_IMAGE:-ghcr.io/git-monke/churn-dashboard:latest}
network_mode: host
init: true
user: "${PUID:-1000}:${PGID:-1000}"
read_only: true
cap_drop: [ALL]
security_opt:
  - no-new-privileges:true
pull_policy: missing
tmpfs:
  - /tmp
```

Reasons for each choice:

- **host network** — every upstream stays on `127.0.0.1`, including the torrent stack's loopback-only VPN status agent, and the backend can discover the host's LAN address for browser-facing Jellyfin streams. It also means `DASHBOARD_PORT` is a real listener port, not a mapping.
- **read-only root** with a `/tmp` tmpfs — nothing in the image needs to be written; the two writable paths are named volumes.
- **`cap_drop: ALL` + `no-new-privileges`** — the process is a Node server, not an init system.
- **`init: true`** — reaps orphaned children from process spawns.
- **`user: ${PUID:-1000}:${PGID:-1000}`** — the dashboard reads `server/.env` for the Jellyfin API key. Churn writes that file as `root:PGID` with mode `0640`: the container runs as the group that can read it, and root keeps ownership so only root can change the values Compose interpolates.
- **`pull_policy: missing`** — a pinned image that already exists locally is not re-pulled on every restart.

Environment is entirely loopback URLs built from the port variables:

```
NODE_ENV=production  HOST=0.0.0.0  PORT=${DASHBOARD_PORT:-4000}
CHURN_SERVER_DIR=/app  CHURN_STATE_DIR=/app/state
JELLYFIN_URL=http://127.0.0.1:${JELLYFIN_PORT:-8096}
SONARR_URL=http://127.0.0.1:${SONARR_PORT:-8989}
RADARR_URL=http://127.0.0.1:${RADARR_PORT:-7878}
QBITTORRENT_URL=http://127.0.0.1:${QBITTORRENT_PORT:-8080}
PROWLARR_URL=http://127.0.0.1:${PROWLARR_PORT:-9696}
VPN_STATUS_URL=http://127.0.0.1:${VPN_STATUS_PORT:-8098}
```

`HOST=0.0.0.0` is required because the container is on the host network; the config default is `127.0.0.1`.

### Mounts

| Container path | Source | Mode |
| --- | --- | --- |
| `/app/.env` | `./.env` | read-only |
| `/app/config` | `./config` | read-only |
| `/torrent/config/prowlarr` | `../torrent/config/prowlarr` | read-only |
| `/torrent/config/qbittorrent` | `../torrent/config/qbittorrent` | read-only |
| `/app/.churn-cache` | named volume `churn-cache` | writable |
| `/app/state` | named volume `churn-state` | writable |

The torrent config mounts are how the backend finds the Prowlarr and qBittorrent API keys without them being duplicated into `.env`. The read-only `./config` mount is what lets it fall back to `config/sonarr/config.xml` and `config/radarr/config.xml`.

`churn-cache` holds release and media caches (release snapshots preferred at `server/cache/releases/prowlarr`, falling back to `/app/.churn-cache/releases/prowlarr` when `server/cache` is not writable). `churn-state` holds profiles and `auth-state.json`. Both are removed by `docker compose down --volumes` during uninstall.

### Image build

`server/Dockerfile` is a three-stage build: a `build` stage running `npm ci` and `npm run build`, a `prod-deps` stage installing only `@churn/backend` production dependencies, and a `runtime` stage on `node:22-bookworm-slim` that copies `backend/dist` and `frontend/dist` only. React, Radix and Vite never reach the runtime image. It creates `/app/.churn-cache` and `/app/state` owned by `node` so fresh named volumes inherit writable ownership, drops to `USER node`, and declares the healthcheck that polls `/api/health`.

## Ordering and dependencies

`server-init` waits only for `sonarr` and `radarr` to start; it does not gate on Jellyfin. The dashboard declares no `depends_on` at all — it tolerates every upstream being down and reports per-service status, which is why a dashboard restart never cascades.

<!-- openwiki: broken internal link [/openwiki/installer/churn-cli.md] link "/openwiki/installer/churn-cli.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Startup order across stacks is enforced by churn, not Compose: the server stack is started before the torrent stack so `prowlarr-init` can read Sonarr and Radarr API keys from `server/config/*/config.xml`. See [churn CLI and orchestration](/openwiki/installer/churn-cli.md).

## Jellyfin specifics

- Jellyfin is the only service with a separate `./cache/jellyfin` mount.
- `TZ` is passed as an environment variable; there is no `PUID`/`PGID` env because the image uses `user:`.
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- The backend reaches Jellyfin at `http://127.0.0.1:<JELLYFIN_PORT>` but hands the browser a rewritten host, so playback works over LAN, Tailscale or a MagicDNS name without extra configuration. See [Configuration and operations reference](/openwiki/operations/configuration.md).
<!-- openwiki: broken internal link [/openwiki/installer/jellyfin-setup.md] link "/openwiki/installer/jellyfin-setup.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- Library paths inside Jellyfin are `/data/media/movies` and `/data/media/tv`, created by `server-init` and registered by the Jellyfin setup step in [Jellyfin first-run setup from churn](/openwiki/installer/jellyfin-setup.md).

## Related pages

<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/backend-architecture.md] link "/openwiki/dashboard/backend-architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Dashboard backend architecture](/openwiki/dashboard/backend-architecture.md)
<!-- openwiki: broken internal link [/openwiki/architecture/overview.md] link "/openwiki/architecture/overview.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [System architecture overview](/openwiki/architecture/overview.md)
