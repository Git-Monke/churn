---
# churn-xpg5
title: Support multiple VPN providers in the installer (Private Internet Access first)
status: todo
type: feature
priority: normal
tags:
    - vpn
    - installer
    - torrent
created_at: 2026-11-06T07:26:02Z
updated_at: 2026-11-06T07:26:02Z
---

## Problem

churn hardcodes Mullvad WireGuard from the install prompt through to the dashboard:

- `src/mullvad.rs` parses a Mullvad config zip and maps Mullvad filename prefixes to `SERVER_COUNTRIES`.
- `Question::WireguardArchive` / `WireguardConfig` / `WireguardPrivateKey` / `WireguardAddresses` are the only VPN questions (`src/question.rs`).
- `src/stack.rs::apply` always writes `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_*` and `SERVER_COUNTRIES`.
- `torrent/docker-compose.yml` hardcodes `VPN_SERVICE_PROVIDER=mullvad` / `VPN_TYPE=wireguard` and requires `WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES` with `:?run churn first`.
- `src/security.rs` rejects any provider other than `mullvad` with `VPN_TYPE=wireguard`.
- `torrent/scripts/vpn-check.sh` and `vpn-status.sh` require `am.i.mullvad.net` to report a Mullvad exit, and the status payload names the fields `mullvadExit` / `mullvad`.
- README, `docs/src/torrent.md` and `torrent/.env.example` all describe Mullvad only.

A user whose VPN is Private Internet Access (PIA), or any other provider gluetun supports, cannot use churn without hand-editing generated files that a rerun then overwrites.

Gluetun supports PIA out of the box, and OpenVPN is the simplest path: provider id `private internet access`, `VPN_TYPE=openvpn`, `OPENVPN_USER` + `OPENVPN_PASSWORD`. PIA also supports VPN port forwarding, which matters for seeding.

## Desired behaviour

The installer offers a VPN provider choice and generates provider-appropriate configuration. Mullvad (WireGuard) stays the default so existing installs are untouched; Private Internet Access (OpenVPN) is the first new provider.

1. **Provider question** before the credential questions: `Mullvad (WireGuard)` and `Private Internet Access (OpenVPN)`. Reruns infer the provider from the existing `torrent/.env` `VPN_SERVICE_PROVIDER` and prefill it.
2. **Mullvad flow** stays as it is today: zip path, parse one `.conf`, derive `SERVER_COUNTRIES` from the filename, write `WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES`.
3. **PIA flow**:
   - Ask for the PIA username and password with a masked password prompt; store only in `torrent/.env` as `OPENVPN_USER` / `OPENVPN_PASSWORD`, never show the password in the plan, summary or logs.
   - Ask for a Gluetun *region* (PIA uses `SERVER_REGIONS`, **not** `SERVER_COUNTRIES`; `SERVER_CITIES` / `SERVER_HOSTNAMES` are optional refinements). Gluetun's canonical region list comes from `docker run --rm qmcgaw/gluetun format-servers -private-internet-access`; offer a curated default region + free-text with validation rather than guessing.
   - Write `VPN_SERVICE_PROVIDER=private internet access`, `VPN_TYPE=openvpn`, `OPENVPN_USER`, `OPENVPN_PASSWORD`, `SERVER_REGIONS`.
   - Ask whether to enable `VPN_PORT_FORWARDING=on` (default on for the torrent stack). Warn that not every PIA region supports server-side port forwarding and point at the PIA server list / Gluetun docs. When enabled, wire the forwarded port into qBittorrent's listening port (`VPN_PORT_FORWARDING_UP_COMMAND` or a small init script that reads `/tmp/gluetun/forwarded_port`).
4. **Provider-aware output**: compose reads `VPN_SERVICE_PROVIDER` / `VPN_TYPE` from `.env` instead of literals and only requires the variables valid for that provider. Switching providers must remove the other provider's keys instead of leaving stale `WIREGUARD_*` / `OPENVPN_*` values behind.
5. **Provider-aware verification**: `vpn-check.sh` proves egress is the tunnel and not the host, for any provider. Compare the observed public IP against gluetun's control API (`/v1/publicip/ip` on localhost) and, where available, a provider-specific exit check. `vpn-status.sh` emits provider-neutral fields (provider, exit IP, country/region, port-forwarded port) while keeping the dashboard working; update `server/backend` types and the UI so no Mullvad-only label remains.
6. **`security.rs` invariants stay strict**: firewall on, DNS via gluetun, IPv6 disabled, only the default network, sidecars in the VPN namespace, no privileged container. The provider check becomes "known provider + matching required credentials" instead of "must be mullvad".
7. **Docs**: README, `docs/src/torrent.md`, `torrent/.env.example` document provider selection, PIA OpenVPN credentials/region, port forwarding and its region limits.

## Implementation sketch

- New `src/vpn.rs` provider model: `enum VpnProvider { Mullvad, PrivateInternetAccess }` plus `gluetun_id()`, `vpn_type()`, required env keys, location env key, and a verification strategy. Keep `src/mullvad.rs` as the Mullvad archive parser and call it from the provider flow.
- `src/question.rs`: `Question::VpnProvider` (select), `Question::OpenvpnUser`, `Question::OpenvpnPassword`, `Question::ServerRegion`, `Question::PortForwarding`; make `Question::section()`/`Stack::questions()` provider-dependent or filter the question list in `main.rs` after the provider answer. Mask `OPENVPN_PASSWORD` in `summary()` and `plan`.
- `src/main.rs`: provider-aware `explain(Section::Vpn)` note, skip the archive loop for PIA, validate username/password non-empty, and make non-interactive/`-y` runs deterministic (provider defaults to stored, then Mullvad).
- `src/stack.rs::apply`: write provider keys from the answer, drop irrelevant keys for the chosen provider, and keep hand-edited `SERVER_REGIONS`/`SERVER_CITIES` overrides the same way `SERVER_COUNTRIES` is preserved for Mullvad.
- `torrent/docker-compose.yml`: `${VPN_SERVICE_PROVIDER:-mullvad}`, `${VPN_TYPE:-wireguard}`, conditional required vars per type (avoid Compose failing on an unset `WIREGUARD_PRIVATE_KEY` for an OpenVPN install).
- `torrent/scripts/vpn-lib.sh` / `vpn-check.sh` / `vpn-status.sh`: provider-neutral helpers; keep a compatibility path for the dashboard payload.
- `server/backend` + dashboard VPN status view: consume the new fields, show provider and forwarded port.
- `src/security.rs` + its fixtures/tests: accept both providers, assert the required env per provider, keep all leak invariants.
- Tests: pure unit tests for env generation per provider, archive parsing, question ordering, provider inference on rerun, security validation for both providers; installer integration test that a PIA `.env`/compose pair validates.

## Acceptance criteria

- [ ] Fresh Mullvad install behaves exactly as today (same questions, files, verification).
- [ ] Fresh PIA install asks for username/password/region, writes PIA OpenVPN env, starts gluetun, and qBittorrent traffic exits PIA.
- [ ] A PIA install passes `vpn-check` and the dashboard VPN status without any Mullvad-specific labels or endpoints.
- [ ] `security.rs` accepts PIA and Mullvad and still fails a misconfigured/leaking stack.
- [ ] Rerun preserves the chosen provider, region and port-forwarding choice; secrets are not re-asked when already stored.
- [ ] Switching provider rewrites `torrent/.env` and compose cleanly, with no stale `WIREGUARD_*` / `OPENVPN_*` keys.
- [ ] No VPN password or key appears in the plan, summary, logs or dashboard payloads.
- [ ] Port forwarding (when enabled) results in qBittorrent using the forwarded port, and a region without PIA port-forward support fails with a clear message.
- [ ] Docs and `.env.example` cover both providers.

## Open questions

- Add PIA WireGuard now or later? PIA WireGuard in Gluetun needs a private key *and* address; OpenVPN username/password is the easier first cut, so this bean scopes PIA to OpenVPN.
- Default for `VPN_PORT_FORWARDING`: on whenever the torrent stack is installed, or opt-in? Not all PIA regions support it.
- Region UX: curated list in the binary (needs periodic refresh), or free text validated against a `format-servers` run? A wrong region currently surfaces only as a gluetun crash-loop.
- Should the provider list become data-driven so ProtonVPN/NordVPN/etc. are cheap to add, or stay a small enum with explicit env mappings?
- qBittorrent port sync: use Gluetun's `VPN_PORT_FORWARDING_UP_COMMAND` (runs a shell command with `{{PORT}}`) or a churn-managed script? Either way it must survive container restarts and not fight the dashboard.
- Is a provider switch a rerun of `churn` (current flow) or a separate `churn reconfigure` command? Rerun rewrites `.env` but also recreates stacks.
- Exit verification for providers without an "am I behind X" endpoint: public-IP-vs-gluetun comparison is generic, but does it prove the provider rather than a random VPN?

## Related

- `Gate releases on full-stack torrent VPN leak verification` — the release gate must exercise every supported provider, not just Mullvad.
- `Separate media and download locations` and `Relocate data with a churn migrate command` — unaffected by provider choice, but both touch `torrent/.env` and the torrent stack restart path.
