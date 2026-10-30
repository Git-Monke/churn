# churn

`churn` is an interactive installer for a small self-hosted media and torrent
setup. It collects a few answers, writes the environment files each stack
needs, and starts the selected Docker Compose stacks.

The project is split into two roles. They can run on the same machine or, for
the server stack alone, on separate hardware. The current automatic wiring
between them assumes they share one host.

| Stack | Purpose | Services |
| --- | --- | --- |
| [Server](server.md) | Serves the media library and runs the automation apps | Jellyfin, Sonarr, Radarr |
| [Torrent](torrent.md) | Finds releases and downloads them through a VPN | qBittorrent, Prowlarr, FlareSolverr, gluetun |

## The two paths

The **server stack** is the long-lived media side. Jellyfin plays media, while
Sonarr and Radarr manage TV and movies. These containers run on the normal
host network without a VPN.

The **torrent stack** is the acquisition side. Prowlarr talks to indexers,
qBittorrent downloads releases, and FlareSolverr handles Cloudflare challenges.
Every one of those containers shares gluetun's network namespace, so all of
their traffic leaves through the Mullvad WireGuard tunnel.

The stacks share a single `DATA_DIR`, mounted at `/data` everywhere. That keeps
media paths consistent between the downloader, the automation apps, and
Jellyfin.

## This book

These pages are a living description of the stack: what each service does, how
the pieces connect, and which safety properties the configuration is meant to
preserve. The compose files remain the source of truth for exact images,
versions, and environment variables.
