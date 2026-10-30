# Torrent stack

The torrent stack handles indexer searches and downloads. It is designed to
fail closed: if the VPN is not working, the applications that could leak
traffic are not allowed to start.

## Services

| Service | Role | Network |
| --- | --- | --- |
| `gluetun` | Mullvad WireGuard client, firewall, DNS resolver, and port publisher | VPN namespace |
| `vpn-check` | One-shot startup verification of VPN exit, DNS, and kill switch | Shares gluetun |
| `qbittorrent` | Download client | Shares gluetun |
| `prowlarr` | Indexer manager | Shares gluetun |
| `flaresolverr` | Solves Cloudflare challenges for indexers | Shares gluetun |
| `qbittorrent-init` | Seeds a stable qBittorrent API key | No network |
| `prowlarr-init` | Wires qBittorrent, indexers, FlareSolverr, Sonarr, and Radarr | Shares gluetun |

Only `gluetun` joins a Docker network. The other network-capable containers use
`network_mode: "service:gluetun"` and therefore have no independent route to
the internet. Web UI ports `8080` (qBittorrent) and `9696` (Prowlarr) are
published on the gluetun container.

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

## Wiring and storage

`prowlarr-init` is idempotent. It creates the `prowlarr`, `tv`, and `movies`
qBittorrent categories, registers qBittorrent in Prowlarr, adds enabled public
indexers, connects FlareSolverr, and links Sonarr and Radarr. It reads their API
keys from `../server/config`, so the current setup expects both stacks on the
same host.

The stack shares `${DATA_DIR}` with the server stack at `/data`, so completed
downloads are visible to Sonarr, Radarr, and Jellyfin without path translation.

## Useful commands

```bash
cd torrent
docker compose up -d                         # start the stack
docker logs vpn-check                        # inspect the last VPN check
docker compose up --force-recreate vpn-check # rerun the VPN check
docker compose run --rm prowlarr-init        # re-apply the wiring
```
