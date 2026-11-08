# Files

- [Server stack topology](server-stack.md) - The server Compose stack — Jellyfin, Sonarr, Radarr, the one-shot server-init bootstrap, and the hardened host-networked dashboard container — including images, mounts, root folders and how configuration reaches each service.
- [Torrent stack services and bootstrapping](torrent-services.md) - qBittorrent, Prowlarr and FlareSolverr behind the VPN namespace, plus the two one-shot initializers that seed the qBittorrent API key and wire indexers, applications and download clients for Sonarr and Radarr.
- [Torrent stack and VPN boundary](torrent-vpn-boundary.md) - The torrent stack's fail-closed VPN design — Gluetun as the only networked service, the firewall/DNS/IPv6 invariants, the vpn-check startup gate, the on-demand vpn-status dashboard agent, and the two preflight verifications churn runs against the effective Compose config and Docker's default route.
