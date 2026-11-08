---
type: Stack Topology
title: Torrent stack services and bootstrapping
description: qBittorrent, Prowlarr and FlareSolverr behind the VPN namespace, plus the two one-shot initializers that seed the qBittorrent API key and wire indexers, applications and download clients for Sonarr and Radarr.
tags: [compose, torrent-stack, qbittorrent, prowlarr, flaresolverr, bootstrap, api-keys]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-6f79f41844a77e3b22742109
    resource: repo://torrent/docker-compose.yml
  - id: openwiki-source-4439f7c3dd0e1723a9e2a33e
    resource: repo://torrent/resolv.conf
  - id: openwiki-source-0d23b1f99e7da2dcdab5ac84
    resource: repo://torrent/scripts/prowlarr-init.sh
  - id: openwiki-source-c8f878b3bc0816223e4f0d26
    resource: repo://torrent/scripts/qbittorrent-init.sh
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Torrent stack services and bootstrapping

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
The torrent stack runs three long-lived services — qBittorrent, Prowlarr and FlareSolverr — all inside gluetun's network namespace, plus two one-shot containers that make the stack self-configuring on first run. The VPN boundary itself is documented in [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md); this page covers what the services do and how the bootstrapping wires them together.

## Services

| Service | Image | Namespace | Restart |
| --- | --- | --- | --- |
| `gluetun` | `qmcgaw/gluetun:v3.41.3` | owns the namespace, publishes 8080/9696/8098 | `unless-stopped` |
| `vpn-check` | `curlimages/curl:8.23.0` | gluetun | `"no"` |
| `vpn-status` | `curlimages/curl:8.23.0` | gluetun | `unless-stopped` |
| `flaresolverr` | `flaresolverr/flaresolverr:v3.5.2` | gluetun | `unless-stopped` |
| `qbittorrent-init` | `curlimages/curl:8.23.0` | **none** | `"no"` |
| `qbittorrent` | `lscr.io/linuxserver/qbittorrent:5.3.0_v2.1.2-ls485` | gluetun | `unless-stopped` |
| `prowlarr` | `lscr.io/linuxserver/prowlarr:2.7.0.5723-ls166` | gluetun | `unless-stopped` |
| `prowlarr-init` | `curlimages/curl:8.23.0` | gluetun | `"no"` |

Because the web UIs share gluetun's namespace, the port mappings live on `gluetun`, not on `qbittorrent` or `prowlarr`:

```yaml
- "${QBITTORRENT_PORT:-8080}:8080"
- "${PROWLARR_PORT:-9696}:9696"
- "127.0.0.1:${VPN_STATUS_PORT:-8098}:${VPN_STATUS_PORT:-8098}"
```

That is also why `Port::compose_service` reports `gluetun` for those three ports — Docker attributes published ports to the namespace owner.

## Startup dependency chain

```
gluetun (healthy)
  └─ vpn-check (completed successfully)
       ├─ flaresolverr
       ├─ vpn-status
       ├─ qbittorrent  ← qbittorrent-init (completed)
       ├─ prowlarr
       └─ prowlarr-init ← flaresolverr, qbittorrent-init, qbittorrent, prowlarr
```

Every consumer requires `vpn-check` to have exited successfully, so nothing that can leak starts before the tunnel is proven. `prowlarr-init` is the last to run because it needs Prowlarr's API, qBittorrent's API, the seeded qBittorrent key and FlareSolverr.

## Shared mounts

| Mount | Purpose |
| --- | --- |
| `./resolv.conf:/etc/resolv.conf:ro` | Gluetun's own DoT resolver at `127.0.0.1`; Docker rejects `dns:` alongside `network_mode: service:gluetun`, so it is a bind mount |
| `./config/<service>:/config` | persistent app config |
| `${DATA_DIR}:/data` | qBittorrent and Prowlarr data (`:?` form fails fast when unset) |
| `../server/config/sonarr:/sonarr-config:ro`, `../server/config/radarr:/radarr-config:ro` | `prowlarr-init` reads the server stack's API keys directly |

The `resolv.conf` file is deliberately minimal:

```
nameserver 127.0.0.1
options edns0
```

## `qbittorrent-init`: stable API key and Host-header validation

`torrent/scripts/qbittorrent-init.sh` runs with `network_mode: none` — it writes a file and never touches the network.

Why it exists:

- qBittorrent generates a **new** WebUI API key when none is present, so anything that cached the old key breaks after a container recreation.
- qBittorrent validates the `Host` header port against its internal `8080`. Publishing the WebUI on any other host port makes **every** request fail with `401`.

What it does:

1. reads `[WebUI] APIKey=` with awk (`read_webui_key`);
2. otherwise migrates a legacy `WebUI\APIKey=` entry from `[Preferences]`, which qBittorrent 5.x ignores;
3. otherwise generates `qbt_` + 28 alphanumeric characters from `/dev/urandom`;
4. rewrites the config so `[WebUI]` contains `APIKey=` and `HostHeaderValidation=false`, dropping stale copies of both keys;
5. if there is no config at all, writes a seed file with `[LegalNotice] Accepted=true`, `Connection\UPnP=false`, `Downloads\SavePath=/data/`, `Downloads\TempPath=/data/incomplete/`, `[WebUI] Address=*` and `ServerDomains=*`;
6. `chown -R $PUID:$PGID` on the config root when running as root, because the container runs qBittorrent as `PUID:PGID`.

The key format is constrained: `qbt_` followed by exactly 28 characters.

## `prowlarr-init`: stack wiring

`torrent/scripts/prowlarr-init.sh` is the largest piece of bootstrap logic in the repo. It is fully idempotent — every step updates an existing record rather than skipping it, so a rerun repairs drift such as a rotated qBittorrent key.

### Inputs

| Source | Value |
| --- | --- |
| `prowlarr/config.xml` | Prowlarr `<ApiKey>` (polled until it appears, `INIT_TIMEOUT_SECONDS` default 180) |
| `qbittorrent/qBittorrent/qBittorrent.conf` | `[WebUI] APIKey=`, falling back to legacy `WebUI\APIKey=` |
| `sonarr/config.xml`, `radarr/config.xml` | server-stack API keys |
| `HOST_IP` | cross-stack address; without it Sonarr/Radarr wiring is skipped with `HOST_IP is not set; skipping Sonarr/Radarr wiring` |
| `HOST_IP` + `SONARR_PORT`/`RADARR_PORT` | `SONARR_URL`/`RADARR_URL` |
| `FLARESOLVERR_URL` | default `http://localhost:8191` |
| `PROWLARR_INDEXERS` | default `eztv,yts,thepiratebay,1337x,limetorrents,torrentdownloads,uindex` |

### JSON parsing without jq

The image is plain `curlimages/curl`, so the script parses Prowlarr's pretty-printed JSON with awk/sed helpers keyed to its indentation:

- `json_id_for_implementation` — id of the object whose `"implementation"` matches (download clients, indexer proxies, applications);
- `json_object_for_name` — the whole top-level object for an indexer name;
- `json_id_from_object` — `^    "id": N` (four-space indent) so nested resources like `IndexerCapabilityResource`, which also serialize an `id`, are ignored;
- `json_string_for_key` / `json_bool_for_key` / `json_array_for_key` — read a top-level `name`, `enable` or `tags` back out of an existing object;
- `json_id_for_label` — id of a tag by `label`.

Helper failure is treated as a warning, not an abort: `warning: could not enable X in Prowlarr` and similar messages keep the rest of the wiring running.

### qBittorrent categories

`GET /api/v2/torrents/categories` then `POST /api/v2/torrents/createCategory` for `prowlarr`, `tv` and `movies` — each created only when absent. Authentication is `Authorization: Bearer <key>`.

### Prowlarr download client

Registers/updates qBittorrent with `host=localhost`, `port=8080` (inside the shared namespace), `apiKey=<seeded key>` and `category=prowlarr`.

### Sonarr and Radarr as Prowlarr applications

`syncLevel: fullSync` with `prowlarrUrl` set to `http://$HOST_IP:9696` (the external address Sonarr/Radarr can reach), `baseUrl` to the app, and `apiKey` to the key read from `server/config`.

Sync categories deliberately exclude adult 6000-series codes:

- Sonarr: `[5000, 5010, 5020, 5030, 5040, 5045, 5050, 5090]`, anime `[5070]`, `syncAnimeStandardFormatSearch: true`
- Radarr: `[2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080, 2090]`

Existing records keep their `name`, `enable` and `tags` values; only the sync categories are rewritten.

### FlareSolverr indexer proxy

If `POST {flaresolverr}/v1 {"cmd":"sessions.list"}` answers, the script ensures a Prowlarr tag `flaresolverr` exists, then registers or updates an `indexerProxy` with `implementation: FlareSolverr`, `host` set to the FlareSolverr base URL and `requestTimeout: 60`. If FlareSolverr is unreachable it prints `warning: FlareSolverr is not reachable at …; skipping proxy setup` and continues.

### Indexers

Each indexer is created **disabled** first, then enabled through the bulk endpoint:

```json
{ "ids": [<id>], "enable": true, "tags": [<flaresolverr tag>], "applyTags": "add" }
```

The two-step approach is intentional: `POST /api/v1/indexer` runs a connectivity test that fails when a site is temporarily Cloudflare-blocked, and a failure there would abort the rest of the wiring. The bulk `PUT /api/v1/indexer/bulk` does not test.

Mapping (`ensure_indexer`):

| Key | Prowlarr name | Base URL |
| --- | --- | --- |
| `1337x` | 1337x | `https://1337x.to/` |
| `eztv` | EZTV | `https://eztvx.to/` |
| `yts` | YTS | `https://yts.gg/` |
| `thepiratebay` | The Pirate Bay | `https://thepiratebay.org/` |
| `limetorrents` | LimeTorrents | `https://www.limetorrents.fun/` |
| `torrentdownloads` | Torrent Downloads | `https://www.torrentdownloads.pro/` |
| `torrentdownload` | TorrentDownload | `https://www.torrentdownload.info/` |
| `uindex` | Uindex | `https://uindex.org/` |

Unknown keys produce `unknown indexer 'x' in PROWLARR_INDEXERS; skipping`.

A documented caveat lives right above the list: Cloudflare returns HTTP 451 for some sites from countries with court-ordered blocks (EZTV, 1337x, YTS and The Pirate Bay from a Dutch exit), and FlareSolverr cannot solve a 451. `SERVER_COUNTRIES` (derived from the selected Mullvad config filename) therefore determines whether those indexers work.

### qBittorrent in Sonarr and Radarr

Registers/updates a `QBittorrent` download client in each app with `host=$HOST_IP`, `port=$QBITTORRENT_PORT`, the seeded key, and category `tv` (Sonarr) or `movies` (Radarr). This is why the app must go through the host address: qBittorrent only listens inside gluetun's namespace.

### Server-stack readiness

If neither `sonarr/config.xml` nor `radarr/config.xml` is non-empty within `SERVARR_TIMEOUT_SECONDS` (default 90), the script exits 0 with:

```
no Sonarr/Radarr config found after 90s; skipping
start the server stack, then: docker compose run --rm prowlarr-init
```

That instruction is the recovery path for a torrent-first install. Per-app failures are equally soft: `skipping Sonarr wiring (no API key or API unreachable)`.

## Cross-stack contract

| Direction | Mechanism |
| --- | --- |
| torrent → server | `../server/config/{sonarr,radarr}` read-only mount for API keys; `HOST_IP:<port>` URLs |
| server → torrent | dashboard mounts `../torrent/config/{prowlarr,qbittorrent}` read-only and reads the keys from file |
| both | every port is written to both `.env` files by `Stack::apply` |

No API key is ever duplicated into an `.env` by the wiring scripts; the keys stay in the owning app's config file and are read by whoever needs them.

## Related pages

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-vpn-boundary.md] link "/openwiki/stack-topology/torrent-vpn-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack and VPN boundary](/openwiki/stack-topology/torrent-vpn-boundary.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Server stack topology](/openwiki/stack-topology/server-stack.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
<!-- openwiki: broken internal link [/openwiki/dashboard/upstream-integrations.md] link "/openwiki/dashboard/upstream-integrations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Upstream integrations and upstream state](/openwiki/dashboard/upstream-integrations.md)
