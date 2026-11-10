# Torrent stack

The torrent stack handles indexer searches and downloads. It is designed to
fail closed: if the VPN is not working, the applications that could leak
traffic are not allowed to start.

## Services

| Service | Role | Network |
| --- | --- | --- |
| `gluetun` | VPN client (any supported provider), firewall, DNS resolver, and port publisher | VPN namespace |
| `vpn-check` | One-shot startup verification of VPN exit, DNS, and kill switch | Shares gluetun |
| `vpn-status` | On-demand leak test for the dashboard's VPN tab | Shares gluetun |
| `qbittorrent` | Download client | Shares gluetun |
| `qbit-watch` | Restarts qBittorrent when its tracker session falls behind the tunnel | Shares gluetun |
| `prowlarr` | Indexer manager | Shares gluetun |
| `flaresolverr` | Solves Cloudflare challenges for indexers | Shares gluetun |
| `qbittorrent-init` | Seeds a stable qBittorrent API key | No network |
| `prowlarr-init` | Wires qBittorrent, indexers, FlareSolverr, Sonarr, and Radarr | Shares gluetun |

Before starting the stack, churn starts a throwaway probe container on the
Compose network and verifies it has an IPv4 default route. A gluetun log line
`default route not found` means Docker's bridge or the existing Compose network
is broken, not that the VPN credentials are wrong.

Only `gluetun` joins a Docker network. The other network-capable containers use
`network_mode: "service:gluetun"` and therefore have no independent route to
the internet. Web UI ports `8080` (qBittorrent) and `9696` (Prowlarr) are
published on the gluetun container. Port `8098` is the dashboard's VPN status
agent and is bound to the host loopback only.

The published host ports are configurable as `QBITTORRENT_PORT` (default 8080),
`PROWLARR_PORT` (default 9696), and `VPN_STATUS_PORT` (default 8098, loopback).
churn suggests the nearest free port when a default is taken and passes the
chosen values to the dashboard and `prowlarr-init`. Internally qBittorrent and
Prowlarr keep their standard ports inside the VPN namespace.

Because the published qBittorrent port can differ from its internal 8080,
`qbittorrent-init` sets `WebUI\HostHeaderValidation=false`. qBittorrent's
default Host header check rejects requests whose port does not match its
internal port, which would otherwise make the WebUI and API return 401 when
the stack is published on a different host port. API requests still require
the seeded API key.

The qBittorrent WebUI is published on all host interfaces over plain HTTP and is
protected by the API key seeded by `qbittorrent-init`. The churn backend reads
that key from the qBittorrent config file and uses it read-only from the host
(`/api/v2/torrents/info`) to show live Library progress; the key stays
server-side and is never sent to the browser. If you do not need the WebUI from
other machines, bind the published port to
`127.0.0.1:${QBITTORRENT_PORT:-8080}:8080` in `torrent/docker-compose.yml`.

## VPN and leak protection

- gluetun connects to the VPN provider churn was configured with. Mullvad,
  IVPN, ProtonVPN, NordVPN and Surfshark run over WireGuard, which is the
  default: torrenting is throughput-bound and WireGuard is markedly faster than
  OpenVPN. Private Internet Access is the exception, because Gluetun has no
  native WireGuard support for it, so it runs over OpenVPN with a VPN
  configuration username and password.
- Its firewall, or kill switch, blocks egress except through the tunnel. The
  only non-VPN exception is `HOST_IP/32`, used so Prowlarr can reach Sonarr and
  Radarr on the host's LAN address.
- Every networked sidecar mounts `torrent/resolv.conf`, which contains only
  `nameserver 127.0.0.1`. DNS is answered by gluetun's local DoT resolver.
- IPv6 is disabled in the shared namespace because the imported tunnel config
  is IPv4-only.
- `vpn-check` requires the public exit to be the tunnel exit: the address the
  internet sees from inside the namespace must equal the one Gluetun reports on
  its control API (`/v1/publicip/ip`), and neither may be private or CGNAT. That
  is provider-neutral, and stronger than "the exit belongs to provider X"
  because it also catches egress that avoided the tunnel. It also verifies that
  direct `eth0` egress is blocked and that the DNS configuration is right.
  qBittorrent, Prowlarr, and FlareSolverr wait for it to complete successfully.
- `vpn-status` runs the same checks on demand from the same network namespace
  and serves them as JSON on `127.0.0.1:8098`. The dashboard's Services → VPN
  tab uses it to show the provider, protocol, live exit IP, boundary checks, and
  which torrent apps are reachable inside the protected namespace.
- `churn verify-vpn` applies the same rules to a `docker compose config`
  document. The installer runs it before starting the stack, and
  `scripts/vpn-gate.sh` runs it for the release gate.

### When the VPN reconnects, qBittorrent is restarted

Gluetun can restart its own tunnel without recreating the namespace. The
sidecars keep the namespace, but qBittorrent keeps the libtorrent session it
built on the old exit: DHT drops to zero nodes, the status shows `firewalled`,
and every download sits at 0% with no data arriving. Nothing recovers until
qBittorrent is restarted.

`qbit-watch` runs in the same namespace and reads Gluetun's control API
(`/v1/vpn/status`, `/v1/publicip/ip`). It restarts qBittorrent, through
`POST /api/v2/app/shutdown`, when the tunnel comes back after being down, when
the exit IP changes, when DHT has reported zero nodes for 30s, or when
qBittorrent's own `last_external_address_v4` still disagrees with Gluetun's exit
IP after 10 minutes. The linuxserver image supervises qbittorrent-nox with s6,
so that shutdown restarts the process inside the same container: no Docker
socket, no namespace recreation, and the kill switch is never lifted.

Restarts are clamped by a 3-minute cooldown, and the DHT rule is suspended for
2 minutes after each restart so a bootstrapping session is not restarted again.
Tune it with `QBIT_WATCH_INTERVAL_SECONDS` and `QBIT_WATCH_DHT_STALL_SECONDS` in
`torrent/.env`. `QBIT_WATCH_DRY_RUN=1` logs what it would restart without
touching qBittorrent.

This covers Gluetun restarting its tunnel in place. It does not cover
`docker restart gluetun`, which recreates the namespace and takes `qbit-watch`
down with the other sidecars; recreate the whole stack in that case (see the
commands below).

### The release gate

The isolation rules are only worth as much as the proof that the file which
ships still satisfies them. Before any release is tagged or pushed,
`scripts/release.sh` runs `scripts/vpn-gate.sh` with `--force`, so a release is
always freshly proven (outside a release, the gate skips itself when nothing it
covers has changed). The full gate:

1. renders `torrent/docker-compose.yml` with committed fake environments — one
   WireGuard, one OpenVPN/Private Internet Access — and requires
   `churn verify-vpn` to accept both, so neither protocol can break unseen;
2. renders every known-unsafe variant in `tests/vpn-gate/unsafe/` (a sidecar on
   its own network or publishing its own port, a missing `resolv.conf` mount, a
   sidecar that starts before `vpn-check`, IPv6 enabled, the firewall off, a
   plaintext resolver, a public `HOST_IP`, a LAN-exposed status port, ...) and
   requires each one to be rejected for the expected reason;
3. starts the whole pinned stack in a throwaway Compose project, requires
   `vpn-check` to pass, `vpn-status` to report `secure: true` with every check,
   and a probe in a separate container inside the shared namespace to see the
   same address Gluetun reports (unreachable apps are reported as a warning,
   not a gate failure: an app crash is not a leak);
4. breaks each control on purpose (a leaking `resolv.conf`, a public `HOST_IP`,
   an `iptables` rule that re-opens `eth0`, a blackholed tunnel) and requires
   the checks to fail closed;
5. recreates the namespace, proves it is secure again, removes the sandbox and
   writes `.churn-state/vpn-gate.json`.

CI runs the deterministic part (stage 1 and the `tests/compose_gate.rs` tests,
including a rendered stack for all six providers) on every pull request and
again on the release tag, so a hand-pushed `v*` tag cannot publish either.
Formatting and clippy are not part of the VPN gate: they judge style, not the
boundary, and CI's Rust job runs them separately. See the README's "The VPN release gate" section for the
commands.

## Wiring and storage

`prowlarr-init` is idempotent. It creates the `prowlarr`, `tv`, and `movies`
qBittorrent categories, registers qBittorrent in Prowlarr, adds enabled public
indexers, connects FlareSolverr, and links Sonarr and Radarr. The default
indexers are EZTV, YTS, The Pirate Bay, 1337x, LimeTorrents, Torrent Downloads
and Uindex; override them with `PROWLARR_INDEXERS`. It reads
their API keys from `../server/config`, so the current setup expects both
stacks on the same host. The Sonarr/Radarr application sync categories only
include normal TV and movie categories, excluding the adult XXX (`6000`-series)
categories. Prowlarr's own Search page has no equivalent global filter.
Filtering is by category, so miscategorised adult releases can still appear.

Indexer results also depend on where the VPN exits. Some countries have
court-ordered blocks for sites such as EZTV, 1337x, YTS, The Pirate Bay and
LimeTorrents; Cloudflare serves those as HTTP 451, which FlareSolverr cannot
bypass. churn writes the exit location you chose to `VPN_LOCATION` and to the
provider's own filter key: `SERVER_COUNTRIES` for every provider except Private
Internet Access, which uses `SERVER_REGIONS` and its own region names (`US
Seattle`). A key that belongs to a different provider is rejected before the
stack starts. Set the key in `torrent/.env` to pin a different exit.

The stack shares `${DOWNLOAD_DIR}` with the server stack at `/data`, and
`${MEDIA_DIR}` at `/data/media`, so completed downloads are visible to Sonarr,
Radarr, and Jellyfin without path translation. An older `.env` that still holds
`DATA_DIR` is read as the download directory and rewritten on the next run.

## Useful commands

```bash
cd torrent
docker compose up -d                         # start the stack
docker compose logs vpn-check                # inspect the last VPN check
docker compose up --force-recreate vpn-check # rerun the VPN check
docker compose up -d --no-deps --force-recreate vpn-status  # restart the check agent
curl -s http://127.0.0.1:8098/status                         # run the live check directly
docker compose run --rm prowlarr-init                        # re-apply the wiring
docker compose logs -f qbit-watch                            # watch the VPN restarts
```

Do not recreate `gluetun` by itself: qBittorrent, Prowlarr, FlareSolverr and
`vpn-status` share its network namespace. If Gluetun is recreated, recreate the
whole stack:

```bash
docker compose down && docker compose up -d
```
