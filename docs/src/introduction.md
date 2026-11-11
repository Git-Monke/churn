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
| [Torrent](torrent.md) | Finds releases and downloads them through a VPN | qBittorrent, Prowlarr, FlareSolverr, gluetun, vpn-status |

## The two paths

The **server stack** is the long-lived media side. Jellyfin plays media, while
Sonarr and Radarr manage TV and movies. These containers run on the normal
host network without a VPN.

The **torrent stack** is the acquisition side. Prowlarr talks to indexers,
qBittorrent downloads releases, and FlareSolverr handles Cloudflare challenges.
Every one of those containers shares gluetun's network namespace, so all of
their traffic leaves through the VPN tunnel churn configured — Mullvad, IVPN,
ProtonVPN, NordVPN or Surfshark over WireGuard, or Private Internet Access over
OpenVPN because Gluetun has no native WireGuard support for it.

The stacks share two host paths, mounted at fixed container paths everywhere: a
download directory (`DOWNLOAD_DIR`) at `/data` and a media directory
(`MEDIA_DIR`) at `/data/media`. That keeps media paths consistent between the
downloader, the automation apps, and Jellyfin, while letting downloads live on a
fast disk and the library on a large one. The media directory can point at an
existing library, which churn adopts in place.

## Updating

Once installed, update the churn binary, the server dashboard and the installed
stacks together:

```bash
sudo churn update
```

This verifies the release binary's checksum, replaces the running CLI, pulls the
matching dashboard image, and reconciles every installed stack with the compose
files that ship in the new binary: containers a release added are created,
removed ones are pruned, and changed ones are recreated, while unchanged
containers keep running. The torrent stack is reconciled only after the VPN
isolation and default route checks pass. Use `churn update --check` to compare
versions without changing anything, and `churn update --dry-run` to see what
would be created or recreated.

## Driving it without prompts

Everything the wizard asks can be supplied up front, so the same install runs
unattended: `sudo churn --stacks server,torrent --non-interactive --answers
./churn-answers.env`. Ports and other incidental choices are made by churn
itself, and an incomplete answer set stops with exit status 2 before anything is
written. [Non-interactive installs](automation.md) covers the answer sources,
the failure modes, and `churn llm-install`, which prints a prompt for an agent
driving the install.

## This book

These pages are a living description of the stack: what each service does, how
the pieces connect, and which safety properties the configuration is meant to
preserve. The compose files remain the source of truth for exact images,
versions, and environment variables.
