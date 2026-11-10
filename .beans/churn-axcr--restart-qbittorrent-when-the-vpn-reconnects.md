---
# churn-axcr
title: Restart qBittorrent when the VPN reconnects
status: completed
type: bug
created_at: 2026-11-10T03:42:38Z
updated_at: 2026-11-10T05:43:43Z
---

qBittorrent stops downloading (dht_nodes=0, connection_status=firewalled) after gluetun restarts its VPN tunnel to a new Mullvad exit, even though the tunnel itself is healthy. A manual restart of the qBittorrent container restores DHT and downloads.

Root cause: gluetun restarts its tunnel in place, so the sidecars keep the
namespace but qBittorrent keeps the libtorrent session it built on the old exit
(stale `last_external_address_v4`), and DHT never re-bootstraps.

Fix: a `qbit-watch` sidecar in gluetun's namespace restarts qBittorrent through
`POST /api/v2/app/shutdown`; the linuxserver image runs qbittorrent-nox under
s6, so the process comes back inside the same container. No Docker socket.

Done:
- [x] Add a `qbit-watch` sidecar in torrent/docker-compose.yml sharing gluetun's netns
- [x] Poll gluetun's control server (/v1/vpn/status, /v1/publicip/ip) and qBittorrent's /api/v2/transfer/info
- [x] Restart qBittorrent via POST /api/v2/app/shutdown on reconnect/IP change, or dht_nodes==0 for 30s
- [x] Embed the script in src/assets.rs and document it in docs/src/torrent.md and README.md
- [x] Validate compose + run tests

Verified with a stubbed curl: healthy session never restarts; a DHT stall, a
running->stopped->running reconnect, an exit-IP change, and a stale
qBittorrent external IP each trigger exactly one restart.

Known limit: `docker restart gluetun` recreates the namespace and takes
`qbit-watch` with it; the whole stack must be recreated in that case.
