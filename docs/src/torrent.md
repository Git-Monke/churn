# Torrent stack

The torrent stack handles indexer searches and downloads. It is designed to
fail closed: if the VPN is not working, the applications that could leak
traffic are not allowed to start.

## Services

| Service | Role | Network |
| --- | --- | --- |
| `gluetun` | Mullvad WireGuard client, firewall, DNS resolver, and port publisher | VPN namespace |
| `vpn-check` | One-shot startup verification of VPN exit, DNS, and kill switch | Shares gluetun |
| `vpn-status` | On-demand leak test for the dashboard's VPN tab | Shares gluetun |
| `qbittorrent` | Download client | Shares gluetun |
| `prowlarr` | Indexer manager | Shares gluetun |
| `flaresolverr` | Solves Cloudflare challenges for indexers | Shares gluetun |
| `qbittorrent-init` | Seeds a stable qBittorrent API key | No network |
| `prowlarr-init` | Wires qBittorrent, indexers, FlareSolverr, Sonarr, and Radarr | Shares gluetun |

Only `gluetun` joins a Docker network. The other network-capable containers use
`network_mode: "service:gluetun"` and therefore have no independent route to
the internet. Web UI ports `8080` (qBittorrent) and `9696` (Prowlarr) are
published on the gluetun container. Port `8098` is the dashboard's VPN status
agent and is bound to the host loopback only.

The published host ports are configurable as `QBITTORRENT_PORT` (default 8080),
`PROWLARR_PORT` (default 9696), and `VPN_STATUS_PORT` (default 8098, loopback).
churn suggests the nearest free port when a default is taken and passes the
chosen values to the dashboard. Internally qBittorrent and Prowlarr keep their
standard ports inside the VPN namespace.

The qBittorrent WebUI is published on all host interfaces over plain HTTP and is
protected by the API key seeded by `qbittorrent-init`. The churn backend reads
that key from the qBittorrent config file and uses it read-only from the host
(`/api/v2/torrents/info`) to show live Library progress; the key stays
server-side and is never sent to the browser. If you do not need the WebUI from
other machines, bind the published port to
`127.0.0.1:${QBITTORRENT_PORT:-8080}:8080` in `torrent/docker-compose.yml`.

## VPN and leak protection

- gluetun connects to Mullvad over WireGuard.
- Its firewall, or kill switch, blocks egress except through the tunnel. The
  only non-VPN exception is `HOST_IP/32`, used so Prowlarr can reach Sonarr and
  Radarr on the host's LAN address.
- Every networked sidecar mounts `torrent/resolv.conf`, which contains only
  `nameserver 127.0.0.1`. DNS is answered by gluetun's local DoT resolver.
- IPv6 is disabled in the shared namespace because the Mullvad import
  configures an IPv4 tunnel only.
- `vpn-check` requires a Mullvad exit, verifies that direct `eth0` egress is
  blocked, and verifies the DNS configuration. qBittorrent, Prowlarr, and
  FlareSolverr wait for it to complete successfully.
- `vpn-status` runs the same checks on demand from the same network namespace
  and serves them as JSON on `127.0.0.1:8098`. The dashboard's Services → VPN
  tab uses it to show the live exit IP, boundary checks, and which torrent apps
  are reachable inside the protected namespace.

## Wiring and storage

`prowlarr-init` is idempotent. It creates the `prowlarr`, `tv`, and `movies`
qBittorrent categories, registers qBittorrent in Prowlarr, adds enabled public
indexers, connects FlareSolverr, and links Sonarr and Radarr. The default
indexers are EZTV, YTS, The Pirate Bay, 1337x, LimeTorrents, Torrent Downloads,
TorrentDownload and Uindex; override them with `PROWLARR_INDEXERS`. It reads
their API keys from `../server/config`, so the current setup expects both
stacks on the same host. The Sonarr/Radarr application sync categories only
include normal TV and movie categories, excluding the adult XXX (`6000`-series)
categories. Prowlarr's own Search page has no equivalent global filter.
Filtering is by category, so miscategorised adult releases can still appear.

Indexer results also depend on where the VPN exits. Some countries have
court-ordered blocks for sites such as EZTV, 1337x, YTS, The Pirate Bay and
LimeTorrents; Cloudflare serves those as HTTP 451, which FlareSolverr cannot
bypass. churn derives `SERVER_COUNTRIES` from the selected Mullvad config
filename (for example `us-atl-wg-001.conf` becomes `USA`). Set
`SERVER_COUNTRIES` in `torrent/.env` to pin an exit country explicitly.

The stack shares `${DATA_DIR}` with the server stack at `/data`, so completed
downloads are visible to Sonarr, Radarr, and Jellyfin without path translation.

## Useful commands

```bash
cd torrent
docker compose up -d                         # start the stack
docker compose logs vpn-check                # inspect the last VPN check
docker compose up --force-recreate vpn-check # rerun the VPN check
docker compose up -d --no-deps --force-recreate vpn-status  # restart the check agent
curl -s http://127.0.0.1:8098/status                         # run the live check directly
docker compose run --rm prowlarr-init                        # re-apply the wiring
```

Do not recreate `gluetun` by itself: qBittorrent, Prowlarr, FlareSolverr and
`vpn-status` share its network namespace. If Gluetun is recreated, recreate the
whole stack:

```bash
docker compose down && docker compose up -d
```
