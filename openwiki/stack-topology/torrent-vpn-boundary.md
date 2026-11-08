---
type: Stack Topology
title: Torrent stack and VPN boundary
description: The torrent stack's fail-closed VPN design — Gluetun as the only networked service, the firewall/DNS/IPv6 invariants, the vpn-check startup gate, the on-demand vpn-status dashboard agent, and the two preflight verifications churn runs against the effective Compose config and Docker's default route.
tags: [vpn, gluetun, mullvad, wireguard, kill-switch, security, dns, ipv6, preflight]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-07T17:42:22.982Z
sources:
  - id: openwiki-source-9279f527d0654cab96ef56b5
    resource: repo://src/mullvad.rs
  - id: openwiki-source-2a2a673a83d054852841cab6
    resource: repo://src/security.rs
  - id: openwiki-source-e9d736bdb3525542d9d0dbf5
    resource: repo://src/stack.rs
  - id: openwiki-source-1b1c899ac6b7dde30be62ad2
    resource: repo://src/system.rs
  - id: openwiki-source-6f79f41844a77e3b22742109
    resource: repo://torrent/docker-compose.yml
  - id: openwiki-source-d928442ffedd792b1ee0583f
    resource: repo://torrent/scripts/vpn-check.sh
  - id: openwiki-source-382b4f0acf227748c1d7de15
    resource: repo://torrent/scripts/vpn-lib.sh
  - id: openwiki-source-25ebcd9ff4cdf93b2e4249cb
    resource: repo://torrent/scripts/vpn-status.sh
generated: { by: "pi", at: "2026-11-07T17:42:22.982Z" }
---

# Torrent stack and VPN boundary

The torrent stack is built so that a misconfiguration stops the stack instead of leaking. Only Gluetun has its own network namespace and internet route; every other container either joins that namespace or runs with `network_mode: none`. Three independent layers enforce this: the Compose topology, the in-namespace `vpn-check` startup gate, and `churn`'s pre-start verification of the *effective* Compose configuration.

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Individual service behaviour (qBittorrent, Prowlarr, FlareSolverr and the initializers) is covered in [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md).

## Layer 1: topology

```yaml
gluetun:            # owns the namespace, the only service with an interface
  cap_add: [NET_ADMIN]
  devices: [/dev/net/tun:/dev/net/tun]
  sysctls:
    net.ipv6.conf.all.disable_ipv6: 1
    net.ipv6.conf.default.disable_ipv6: 1
```

| Container | Network |
| --- | --- |
| `gluetun` | own namespace, publishes 8080 / 9696 / 127.0.0.1:8098 |
| `vpn-check`, `vpn-status`, `flaresolverr`, `qbittorrent`, `prowlarr`, `prowlarr-init` | `network_mode: "service:gluetun"` |
| `qbittorrent-init` | `network_mode: none` |

The sidecars therefore never get their own interface, and any port a sidecar would publish has to be published on `gluetun` instead. Docker rejects `dns:` together with `network_mode: service:…`, so the resolver arrives as a read-only bind mount of `torrent/resolv.conf` (`nameserver 127.0.0.1`, `options edns0`).

## Layer 2: gluetun invariants

These are the values the firewall depends on:

| Setting | Value | Why |
| --- | --- | --- |
| `VPN_SERVICE_PROVIDER` | `mullvad` | the only provider whose exit checker the scripts verify |
| `VPN_TYPE` | `wireguard` | config parsed from a Mullvad `.conf` |
| `FIREWALL_ENABLED_DISABLING_IT_SHOOTS_YOU_IN_YOUR_FOOT` | `on` | the actual kill switch |
| `FIREWALL_OUTBOUND_SUBNETS` | `${HOST_IP:-127.0.0.1}/32` | the single non-VPN exception, needed for Sonarr/Radarr |
| `DNS_SERVER` / `DNS_ADDRESS` | `on` / `127.0.0.1` | queries answered by Gluetun's local resolver |
| `DNS_KEEP_NAMESERVER` | `off` | no host or Docker nameserver fallback |
| `DNS_UPSTREAM_RESOLVER_TYPE` | `dot` | encrypted upstream, never `plain` |
| `HEALTH_RESTART_VPN` | `on` | a dead tunnel restarts gluetun, not the sidecars |
| `net.ipv6.conf.*.disable_ipv6` | `1` | the config parser accepts only an IPv4 tunnel address, so no untunnelled IPv6 route may exist |

`WIREGUARD_PRIVATE_KEY` and `WIREGUARD_ADDRESSES` use the Compose `:?` form with the message `run churn first`, so the stack refuses to start without credentials.

## Layer 3: `vpn-check`, the fail-closed gate

`torrent/scripts/vpn-check.sh` runs in Gluetun's namespace after Gluetun reports healthy, and every networked service declares:

```yaml
depends_on:
  vpn-check:
    condition: service_completed_successfully
```

A non-zero exit therefore stops the stack before qBittorrent, Prowlarr or FlareSolverr start. It verifies, in order:

1. **Firewall exception is local.** If `HOST_IP` is non-empty it must pass `vpn_is_local_ipv4`; otherwise `FAILED: HOST_IP=… is not a loopback/LAN address`. Unset `HOST_IP` means the exception is loopback only.
2. **DNS is Gluetun-only.** Every `nameserver` line must be `127.0.0.1`. It dumps `resolv.conf` to stderr on failure and distinguishes "missing file", "not using 127.0.0.1" and "contains a non-Gluetun nameserver".
3. **Egress is a Mullvad exit.** `curl -4` against `https://am.i.mullvad.net/json` (override with `VPN_CHECK_URL`), retried `VPN_CHECK_ATTEMPTS` (default 20) times with `VPN_CHECK_DELAY_SECONDS` (default 2) apart, then the body must contain `"mullvad_exit_ip": true`. On failure the raw body is printed so a captive portal or wrong provider is diagnosable.
4. **`eth0` exists.** Missing `eth0` is itself a failure — the script refuses to assume a non-existent interface is blocked.
5. **Direct egress through `eth0` is blocked.** A `curl --interface eth0` request to `http://1.1.1.1/` must fail (`VPN_CHECK_DIRECT_URL`). Success means the app containers could bypass the tunnel too: `FAILED: traffic through eth0 reached the internet; the VPN kill switch is not effective`.

Success prints `PASS: torrent egress is confined to the VPN`.

## Shared check library

All individual predicates live in `torrent/scripts/vpn-lib.sh`, so the startup gate and the live dashboard agent cannot drift apart:

| Helper | Check |
| --- | --- |
| `vpn_is_local_ipv4` | loopback, RFC1918, link-local, CGNAT (`100.64.0.0/10`) |
| `vpn_firewall_exception_ok` | empty or local |
| `vpn_dns_ok` | every `nameserver` is `127.0.0.1`, and the file is non-empty |
| `vpn_fetch_mullvad` | one `curl -4 -fsS` attempt, body cached in `VPN_MULLVAD_BODY` |
| `vpn_is_mullvad_exit` | body contains `"mullvad_exit_ip": true` |
| `vpn_direct_egress_blocked` | `curl --interface eth0 http://1.1.1.1/` must fail |
| `vpn_ipv6_disabled` | `/proc/sys/net/ipv6/conf/all/disable_ipv6` is `1` |
| `vpn_service_reachable` | any HTTP response counts; 401/404 still prove the TCP path |
| `vpn_now_seconds`, `vpn_duration_ms` | monotonic timing for the status payload |
| `vpn_json_token` | strips anything that could break the JSON string |

## Layer 4: `vpn-status`, the on-demand dashboard agent

`torrent/scripts/vpn-status.sh` runs the same predicates from inside the namespace and answers a single HTTP request. Two modes:

- `vpn-status.sh serve` — `exec busybox nc -l -l -p "$port" -e /scripts/vpn-status.sh`, one response per connection (the curl image's BusyBox has `nc` but no `httpd`);
- no argument — the handler: drain request headers, run the checks, print the response.

Its port is published on host loopback only — `127.0.0.1:${VPN_STATUS_PORT:-8098}` — because the payload exposes network detail and the dashboard backend is the only client.

`secure` is true only when **all five** invariants hold: `mullvadExit`, `killSwitch`, `dns`, `ipv6`, `firewallException`. The response is:

```json
{
  "checkedAt": "…Z",
  "durationMs": 812,
  "secure": true,
  "checks": { "mullvadExit": true, "killSwitch": true, "dns": true,
              "ipv6": true, "firewallException": true },
  "mullvad": { … raw am.i.mullvad.net body … },
  "dns": { "nameservers": ["127.0.0.1"] },
  "firewall": { "directEgressBlocked": true, "exception": "192.168.1.10" },
  "ipv6": { "disabled": true },
  "coverage": [
    { "id": "qbittorrent",  "reachable": true },
    { "id": "prowlarr",     "reachable": true },
    { "id": "flaresolverr", "reachable": true }
  ]
}
```

Timeouts are tightened relative to the startup gate so the whole response stays inside the backend's request timeout even while the tunnel reconnects: connect 3 s / max 6 s for Mullvad, 2 s / 4 s for the direct probe, 1 s / 2 s per coverage probe. The Mullvad body is embedded only if it looks like `{…}` — a captive portal page is replaced with `{}` rather than breaking the whole document. Headers include `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Pre-start verification in churn

`churn` does not trust the static Compose file. Before starting the torrent stack it renders the effective configuration and audits it.

### `system::verify_torrent_isolation`

`src/system.rs:241` runs `docker compose config --format json` in the stack directory, parses the JSON, and hands it to `security::verify_torrent_isolation` (`src/security.rs:19`). A non-zero exit or invalid JSON is reported with the command's stderr. Problems are returned as a list and surfaced as:

```
refusing to start the torrent stack because its VPN isolation is unsafe:
  - <problem>
  - <problem>
```

`verify_torrent_isolation` collects *every* problem rather than stopping at the first (`src/security.rs:19-51`):

| Check | Function | Rejections |
| --- | --- | --- |
| Gluetun owns its namespace | `check_gluetun` `src/security.rs:53` | `network_mode` set, `privileged`, joining a non-default network, wrong provider/type, missing firewall flag, `DNS_SERVER` off, `DNS_ADDRESS` not `127.0.0.1`, `DNS_KEEP_NAMESERVER` truthy, `DNS_UPSTREAM_RESOLVER_TYPE=plain`, IPv6 not disabled |
| Firewall exceptions | `check_firewall_exceptions` `src/security.rs:266` | missing value, empty list, non-CIDR entry, `0.0.0.0` or `::`, prefix other than `/32` or `/128`, non-local address |
| Sidecars | `check_sidecar` `src/security.rs:116` | `network_mode` that is neither `service:gluetun` nor `none`, `privileged`, a `dns` key, own published ports, own Docker network, missing read-only `torrent/resolv.conf` mount |
| Gate exists and is honoured | `check_vpn_gate` `src/security.rs:179` | no `vpn-check` service, its scripts not mounted read-only, any namespace-sharing sidecar (except `gluetun`, `vpn-check`, `qbittorrent-init`) that does not wait with `service_completed_successfully` |
| Status agent | `check_vpn_status` `src/security.rs:215` | missing `vpn-status`, not sharing the namespace, scripts not mounted read-only |
| Status port exposure | `check_status_port` `src/security.rs:241` | a published port matching `VPN_STATUS_PORT` whose `host_ip` is not `127.0.0.1` |

Local-address classification lives in `security::is_local_ipv4` (`src/security.rs:310`): `10/8`, `127/8`, `169.254/16`, `172.16–31`, `192.168/16`, `100.64–127` — deliberately excluding 0.0.0.0 and any public range.

Mount verification (`has_read_only_mount`, `src/security.rs:163`) compares the resolved Compose JSON: exact `target`, `read_only: true`, and a `source` ending in the expected repo-relative suffix (e.g. `/torrent/scripts/vpn-check.sh`). This is why renaming or moving a script breaks the preflight instead of silently dropping a guard.

### `system::verify_compose_default_route`

`src/system.rs:275` guards a failure mode the isolation check cannot see: Gluetun starts and then reports `default route not found` when Docker gives the project network no IPv4 default route. It runs a throwaway `docker compose run` probe with no ports and no dependencies, which also creates the project network, and removes the container afterwards.

### Credentials

`src/mullvad.rs` parses the Mullvad WireGuard archive:

- `entries(path)` lists sorted `.conf` entries (zip read via `ZipArchive`, `src/mullvad.rs:191`);
- `select_config` → `load` → `parse` extract `PrivateKey` and `Address`, validated by `question::validate_wireguard_key` / `validate_wireguard_address` (`src/mullvad.rs:170`, `src/mullvad.rs:183`);
- `country_for_entry` (`src/mullvad.rs:79`) maps the filename prefix (`us-atl-wg-001.conf` → `USA`) through a 50-entry ISO-code table, ignoring directory prefixes and returning `None` for anything that is not a two-letter code.

`Stack::Torrent::apply` writes `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, the four `WIREGUARD_*` answers and the derived `SERVER_COUNTRIES` into `torrent/.env` (`src/stack.rs:232`). `server_countries` (`src/stack.rs:302`) keeps a hand-edited value, migrates the hardcoded `Netherlands` written by older releases, and otherwise derives the country from the selected config filename, falling back to a default when the entry is unparseable.

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`SERVER_COUNTRIES` is security-relevant beyond routing: a Dutch exit makes several indexers answer HTTP 451, which FlareSolverr cannot solve. See [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md).

## Failure modes and what they look like

| Symptom | Layer | Meaning |
| --- | --- | --- |
| `FAILED: not using Gluetun's DNS resolver at 127.0.0.1` | `vpn-check` | a `dns:` key or a wrong resolv.conf mount |
| `FAILED: could not reach … after 20 attempts (is the VPN connected?)` | `vpn-check` | credentials wrong, endpoint unreachable, or tunnel down |
| `FAILED: public egress is not a Mullvad exit` | `vpn-check` | wrong provider or a broken firewall, falling out unprotected |
| `FAILED: traffic through eth0 reached the internet` | `vpn-check` | kill switch not effective — the stack stays down |
| `refusing to start the torrent stack because its VPN isolation is unsafe` | churn preflight | the effective Compose config deviates from the invariants above |
| `default route not found` from Gluetun | Docker | caught earlier by `verify_compose_default_route` |
| dashboard VPN card shows `secure: false` | `vpn-status` | a live invariant regressed after startup |

## Related pages

<!-- openwiki: broken internal link [/openwiki/stack-topology/torrent-services.md] link "/openwiki/stack-topology/torrent-services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Torrent stack services and bootstrapping](/openwiki/stack-topology/torrent-services.md)
<!-- openwiki: broken internal link [/openwiki/stack-topology/server-stack.md] link "/openwiki/stack-topology/server-stack.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Server stack topology](/openwiki/stack-topology/server-stack.md)
<!-- openwiki: broken internal link [/openwiki/installer/provisioning.md] link "/openwiki/installer/provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Provisioning and first-run flow](/openwiki/installer/provisioning.md)
<!-- openwiki: broken internal link [/openwiki/operations/configuration.md] link "/openwiki/operations/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [Configuration and operations reference](/openwiki/operations/configuration.md)
