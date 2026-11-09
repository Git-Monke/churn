# churn

<a href="https://github.com/Git-Monke/churn">
  <img src="README.svg" alt="Churn logo" height="40" style="vertical-align: middle; margin-right: 8px;">
</a>

Interactive installer for a small self-hosted media + torrent setup.

Two roles, one machine each (or both on the same box):

| stack | what it runs | ports |
| --------- | --------------------------------------------- | ----- |
| `server` | Jellyfin + Sonarr + Radarr + dashboard | 8096, 8989, 7878, 4000 (configurable) |
| `torrent` | qBittorrent + Prowlarr + FlareSolverr tunnelled through Mullvad WireGuard | 8080, 9696, 8098 (localhost; configurable) |

Every published host port defaults to its conventional value. A free default is
used without asking; if it is already taken, churn suggests the nearest free
port and asks which one to use. The chosen values live in each stack's `.env`,
and reruns reuse them.

## Intro

**churn** is a media stack that automatically sets up the entire pipeline from
search to playback. With a single installer and one clean interface, it:

1. **Searches** for media across multiple indexers (jailled behind a VPN)
2. **Finds** the best torrent release
3. **Torrents** it directly to qBittorrent
4. **Stores** it in an organized media library
5. **Plays** it through Jellyfin

No more torrent stack headaches or security concerns — everything is configured
for you out of the box.

## Features

- **One-command installer** — sets up every component of the stack automatically:
  qBittorrent and indexers jailed behind a VPN, with several layers of VPN checks
  at release, download, and startup

- **Integrated indexers** — Prowlarr connects to seven public indexers (EZTV,
  YTS, The Pirate Bay, 1337x, LimeTorrents, Torrent Downloads, uIndex) with
  automatic FlareSolverr support for Cloudflare-protected sites

- **VPN leak protection** — fail-closed design: only gluetun joins the Docker
  network; all torrent apps use `network_mode: service:gluetun`; kill switch
  blocks all non-VPN traffic; `vpn-check` validates exit before any app starts

- **Automatic setup & wiring** — after installing, prowlarr-init automatically
  creates qBittorrent categories, registers indexers, wires Sonarr/Radarr, and
  configures all API connections — idempotent and re-runnable

- **Jailed & hardened containers** — qBittorrent runs with `network_mode: none`
  and only writes files; resolv.conf is bind-mounted with Gluetun's DNS-over-TLS;
  IPv6 is disabled in the shared namespace

- **Unified dashboard** — a single BFF interface (Fastify + React) at
  `http://127.0.0.1:5173` that shows service health, library status, and search
  across Radarr and Sonarr

- **Mixed library support** — Jellyfin indexes one mixed library covering both
  movies and TV from `/data/media/tv` and `/data/media/movies`

- **Session-based playback** — per-user Jellyfin sessions (12h inactive timeout),
  device persistence, household profiles with one-time PINs, and per-quality
  rememberance for episode playback

- **Migration support** — `churn migrate` moves `MEDIA_DIR` or `DOWNLOAD_DIR`
  to a new path without reinstalling, with rsync-based resume and rollback

- **VPN-aware indexer selection** — `SERVER_COUNTRIES` in `.env` pins the VPN
  exit country; indexers that are blocked in that country are automatically
  disabled with a legal-block warning

- **Release caching** — search snapshots persist in `server/cache/releases/prowlarr`;
  **Search again** starts fresh; tiers show "may be stale" warning when best
  option has < 50 seeders

- **Flexible indexer config** — override enabled indexers via
  `PROWLARR_INDEXERS=eztv,yts,thepiratebay,1337x,limetorrents,torrentdownloads,uindex`

- **Development & releasing** — `cargo test`, `scripts/release.sh`, and full
  VPN release gate with static, live, negative, and restore stages

## Quick start

On a fresh Linux machine (root required):

```bash
curl -fsSL https://raw.githubusercontent.com/Git-Monke/churn/main/install.sh | sudo sh
sudo churn
```

The installer will guide you through Mullvad WireGuard config, download and
media directories, and role selection. Once complete, visit the URLs reported
by `churn show` to open Jellyfin, Sonarr, Radarr, and the dashboard.