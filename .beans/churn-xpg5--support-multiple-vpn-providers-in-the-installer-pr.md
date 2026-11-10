---
# churn-xpg5
title: Support multiple VPN providers in the installer (WireGuard first, PIA over OpenVPN)
status: todo
type: feature
priority: normal
tags:
    - vpn
    - installer
    - torrent
created_at: 2026-11-06T07:26:02Z
updated_at: 2026-11-10T20:14:23Z
---

## Problem

churn hardcodes Mullvad WireGuard from the install prompt through to the dashboard:

- `src/mullvad.rs` parses a Mullvad config zip and maps Mullvad filename prefixes to `SERVER_COUNTRIES`.
- `Question::WireguardArchive` / `WireguardConfig` / `WireguardPrivateKey` / `WireguardAddresses` are the only VPN questions (`src/question.rs`).
- `src/stack.rs::apply` always writes `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_*` and `SERVER_COUNTRIES`.
- `torrent/docker-compose.yml` hardcodes `VPN_SERVICE_PROVIDER=mullvad` / `VPN_TYPE=wireguard` and requires `WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES` with `:?run churn first`.
- `src/security.rs` rejects any provider other than `mullvad` with `VPN_TYPE=wireguard`.
- `torrent/scripts/vpn-check.sh`, `vpn-lib.sh` and `vpn-status.sh` require `am.i.mullvad.net` to report a Mullvad exit, and the status payload names the fields `mullvadExit` / `mullvad`.
- `server/backend/src/upstream/vpn.ts`, `server/backend/src/types.ts`, `server/frontend/src/api/types.ts` and the Services → VPN view all hardcode `mullvad_exit` / Mullvad labels.
- README, `docs/src/torrent.md` and `torrent/.env.example` describe Mullvad only.

A user whose VPN is ProtonVPN, IVPN, NordVPN, Surfshark or Private Internet Access cannot use churn without hand-editing generated files that a rerun then overwrites. The zip-import flow is also hostile to headless hosts: it forces a download-and-transfer of a provider archive to the machine being set up.

## Decisions taken

- **Six providers, WireGuard by default.** Every provider that Gluetun supports natively over WireGuard gets WireGuard. OpenVPN is only used where it is the only supported option (PIA).
- **No zip import.** All WireGuard providers use a typed private-key prompt, then a country/region picker. Mullvad migrates off the zip flow for the same reason: users are on a headless box and cannot drag a `.zip` onto it.
- **Country/region prompt with an embedded curated list** per provider, validated offline. No free text, no `format-servers` call at install time.
- **Port forwarding is out of scope for this bean** (follow-up bean). No `VPN_PORT_FORWARDING`, no qBittorrent listen-port wiring here.
- Wizard stays a single linear pass; provider is asked first.

## Provider matrix (verified against `qmcgaw/gluetun:v3.41.3`)

| Display name | `VPN_SERVICE_PROVIDER` | `VPN_TYPE` | Credentials | Location key | Embedded list |
| --- | --- | --- | --- | --- | --- |
| Mullvad | `mullvad` | `wireguard` | `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` | `SERVER_COUNTRIES` | 49 countries |
| IVPN | `ivpn` | `wireguard` | `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` | `SERVER_COUNTRIES` | 38 countries |
| ProtonVPN | `protonvpn` | `wireguard` | `WIREGUARD_PRIVATE_KEY` | `SERVER_COUNTRIES` | 130 countries |
| NordVPN | `nordvpn` | `wireguard` | `WIREGUARD_PRIVATE_KEY` | `SERVER_COUNTRIES` | 100 countries |
| Surfshark | `surfshark` | `wireguard` | `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` | `SERVER_COUNTRIES` | 4 regions / 100 countries |
| Private Internet Access | `private internet access` | `openvpn` | `OPENVPN_USER`, `OPENVPN_PASSWORD` | `SERVER_REGIONS` | ~200 `US Seattle`-style regions |

Notes that shape the implementation:

- PIA has no native Gluetun WireGuard (`gluetun-wiki/setup/providers/private-internet-access.md`: "For now, native support cannot be added"). OpenVPN is the only zero-extra-tooling path, which matches the user's call: ship OpenVPN now, add PIA WireGuard later via the `custom` provider.
- PIA's location filter key is `SERVER_REGIONS` with values like `AU Adelaide`, `NL Netherlands Streaming Optimized`, `US Seattle` — not bare countries. Its list is the only one that is not a country list.
- Mullvad's list from `format-servers` uses `UK` / `USA` (not "United Kingdom"/"United States"), ProtonVPN/IVPN use the long names. The embedded lists must be copied verbatim per provider; do not normalise them.
- NordVPN also has `SERVER_CATEGORIES`; not asked.
- The `am.i.mullvad.net` exit proof is Mullvad-only and is being dropped entirely: one generalised proof (observed exit IP == Gluetun's tunnel IP) covers every provider, and a per-provider check is exactly the special-casing this change removes.

## Desired behaviour

### 1. `src/vpn.rs` — one provider model

Replace `src/mullvand`-specific modelling with a table-driven module:

```rust
pub enum VpnProvider { Mullvad, Ivpn, ProtonVpn, NordVpn, Surfshark, PrivateInternetAccess }

pub enum VpnProtocol { Wireguard, Openvpn }

impl VpnProvider {
    pub const ALL: [VpnProvider; 6];
    pub fn label(self) -> &'static str;          // "Mullvad", "Private Internet Access"
    pub fn gluetun_id(self) -> &'static str;     // "mullvad", "private internet access"
    pub fn protocol(self) -> VpnProtocol;
    pub fn needs_address(self) -> bool;          // Mullvad, IVPN, Surfshark
    pub fn location_key(self) -> &'static str;   // SERVER_COUNTRIES | SERVER_REGIONS
    pub fn locations(self) -> &'static [&'static str];
    pub fn help(self) -> &'static str;           // per-provider "where to get this key"
    pub fn from_gluetun_id(id: &str) -> Option<Self>;  // rerun inference
    pub fn required_env(self) -> &'static [&'static str];
}
```

`locations()` returns a sorted, deduplicated slice generated from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -<provider>`. Add `scripts/vpn-servers.sh` that runs those six commands and prints the Rust literals, plus a module comment naming the image tag so a Gluetun bump is a visible diff.

Delete `src/mullvad.rs` entirely (zip parsing, `CONFIG_EXTENSION`, `country_for_entry`). `zip` leaves `Cargo.toml` unless `tests/installer.rs`'s zip fixtures are rewritten; rewrite them so the dependency can go.

Reuse the existing validators in `src/question.rs` (`validate_wireguard_key`, `validate_wireguard_address`) — they already reject a 32-character Mullvad account key mistaken for a WireGuard key, which is exactly the new failure mode of typed input.

### 2. `src/question.rs` — provider-aware questions

New variants:

- `Question::VpnProvider` — `label()` "Which VPN do you use?", answered by `cliclack::select` over the six labels with a hint per provider.
- `Question::WireguardPrivateKey` — now a **typed** prompt, `is_secret() == true`. Placeholder carries the provider's shape (`wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=`).
- `Question::WireguardAddresses` — typed, only asked when `needs_address()`; validated by `validate_wireguard_address`.
- `Question::OpenvpnUser` — typed.
- `Question::OpenvpnPassword` — `cliclack::password`, `is_secret() == true`, never echoed, never in the plan/summary/logs.
- `Question::VpnLocation` — answered by `cliclack::select(...).filter_mode()` over `provider.locations()`, prefilled with the stored value.

Remove `WireguardArchive` and `WireguardConfig`. Keep the `.env` keys for the removed questions in the drop list (§4) so reruns clean up after old installs.

`env_key()` for `VpnLocation` is the neutral `VPN_LOCATION`; `src/stack.rs` maps it to the provider's real key (`SERVER_COUNTRIES` / `SERVER_REGIONS`). This keeps one `.env` key the user can edit and one prefill source on rerun, while Compose still gets the name Gluetun expects.

`is_secret()` must cover `WireguardPrivateKey` and `OpenvpnPassword`, so `stack::summary` masks both. `Question::DETAILS` becomes empty and is removed, along with its use in `show_plan`.

Add `Question::applies_to(self, provider: VpnProvider) -> bool` so the answer loop can skip the variants that do not apply.

### 3. `src/main.rs` — provider-first wizard

- `ask_questions`: always ask `VpnProvider` before any other VPN question (it is first in `Stack::Torrent::questions()` and in `Question::ALL`), then filter the remaining list through `applies_to`. Confirm the provider choice with `explain` *after* the provider is known, so the "Where to get these" note is provider-specific (`provider.help()`): Mullvad → account → WireGuard config → `PrivateKey`/`Address`; PIA → account → OpenVPN username/password + a region like `US Seattle`.
- `-y` / non-interactive: provider is `from_gluetun_id` of the stored `VPN_SERVICE_PROVIDER`, else `Mullvad`; credentials must already be in `.env` (the questions come from `stored_answers`), otherwise fail with "run churn interactively once to enter your VPN credentials" instead of silently writing an empty key.
- Rerun with a stored provider keeps that provider but still re-prompts for the secret only when the stored value is empty; changing the provider drops the other provider's answers from `Answers` before `write_stacks`.
- Print a single line in the plan naming the provider and protocol (`vpn  Mullvad · WireGuard · Netherlands`) so a wrong choice is obvious before anything is written.

### 4. `src/stack.rs` — write exactly one provider's keys

`managed_env` for `Stack::Torrent`:

```rust
let provider = answers.get(&Question::VpnProvider) ... // or stored, else Mullvad
managed.push(("VPN_SERVICE_PROVIDER", provider.gluetun_id()));
managed.push(("VPN_TYPE", provider.protocol().as_env()));
// per provider, only the keys that provider needs:
//   WIREGUARD_PRIVATE_KEY [+ WIREGUARD_ADDRESSES] | OPENVPN_USER + OPENVPN_PASSWORD
// location: written twice so the file is self-describing and Compose-correct
managed.push(("VPN_LOCATION", location));
managed.push((provider.location_key(), location));  // SERVER_COUNTRIES | SERVER_REGIONS
```

`envfile::write_merged` gains an explicit `drop: &[&str]` argument (today it only hardcodes the `DATA_DIR` migration). Torrent writes pass `VPN_STALE_KEYS`: every VPN key the chosen provider does not manage, i.e. `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, `WIREGUARD_ARCHIVE`, `WIREGUARD_CONFIG`, `OPENVPN_USER`, `OPENVPN_PASSWORD`, `SERVER_COUNTRIES`, `SERVER_REGIONS` minus the ones just pushed. This is what makes a provider switch clean instead of leaving a stale `WIREGUARD_PRIVATE_KEY` next to `OPENVPN_USER`.

Also: `FALLBACK_SERVER_COUNTRIES` and `server_countries()` (the filename-derived country and the `LEGACY_SERVER_COUNTRIES` adoption rule) are deleted — the location now always comes from an explicit answer or the stored value.

`Stack::description()` becomes "qBittorrent + Prowlarr + FlareSolverr behind your VPN" (no provider name), since the description is printed before the provider is chosen.

### 5. `torrent/docker-compose.yml` — provider-neutral Gluetun

```yaml
- VPN_SERVICE_PROVIDER=${VPN_SERVICE_PROVIDER:-mullvad}
- VPN_TYPE=${VPN_TYPE:-wireguard}
- WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY:-}
- WIREGUARD_ADDRESSES=${WIREGUARD_ADDRESSES:-}
- OPENVPN_USER=${OPENVPN_USER:-}
- OPENVPN_PASSWORD=${OPENVPN_PASSWORD:-}
- SERVER_COUNTRIES=${SERVER_COUNTRIES:-}
- SERVER_REGIONS=${SERVER_REGIONS:-}
```

The `:?run churn first` guards must go, because a PIA install legitimately has no WireGuard key and vice versa. Fail-closed behaviour moves to `security.rs`, which already runs before `compose up` (`src/main.rs:973`), and must now reject an *empty* credential for the selected provider instead. Keep every existing firewall/DNS/IPv6 line untouched. Comment the IPv6 sysctl as "IPv4-only tunnel import" rather than "Mullvad's import".

### 6. `src/security.rs` — strict for every provider

`check_gluetun` currently demands `mullvad` + `wireguard`. Replace with:

- `VPN_SERVICE_PROVIDER` must parse via `VpnProvider::from_gluetun_id` — unknown providers rejected with the accepted list in the message.
- `VPN_TYPE` must equal the protocol that provider supports (`openvpn` for PIA, `wireguard` for the rest) — reject mismatches, e.g. `mullvad` + `openvpn` (Mullvad drops OpenVPN in 2026).
- Every key in `provider.required_env()` must be present and non-empty; reject a missing/blank `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` (where required), `OPENVPN_USER` or `OPENVPN_PASSWORD`.
- A location key, when set, must be one of `provider.locations()`; reject `SERVER_REGIONS` on a WireGuard provider and `SERVER_COUNTRIES` on PIA (a stale key from a switched install).
- All existing invariants unchanged: firewall on, local-only `FIREWALL_OUTBOUND_SUBNETS`, `DNS_SERVER=on`, `DNS_ADDRESS=127.0.0.1`, `DNS_KEEP_NAMESERVER` off, no plaintext DNS, IPv6 disabled, default network only, no privileged, sidecars in the Gluetun namespace, `vpn-check`/`vpn-status` wiring.

Tests: extend `safe_config()` with a provider parameter, add one accepted fixture per provider, and add rejections for unknown provider, protocol mismatch, missing credential, and wrong location key. `tests/vpn-gate/unsafe/other-provider.yml` currently uses `protonvpn` (which becomes valid) — rename it to `unknown-provider.yml` with `VPN_SERVICE_PROVIDER: foo` and update the `cases.tsv` expected substring to the new message. Add accepted rows to `tests/compose_gate.rs` for the PIA render.

### 7. `torrent/scripts/` — provider-neutral verification

`vpn-lib.sh`:

- Keep `vpn_is_local_ipv4`, `vpn_firewall_exception_ok`, `vpn_dns_ok`, `vpn_nameservers_json`, `vpn_direct_egress_blocked`, `vpn_ipv6_disabled`, `vpn_service_reachable`, timing/JSON helpers unchanged.
- Replace `vpn_fetch_mullvad` / `vpn_is_mullvad_exit` with:

```sh
vpn_fetch_gluetun_exit   # GET http://127.0.0.1:8000/v1/publicip/ip -> VPN_GLUETUN_EXIT_IP
vpn_fetch_observed_exit  # GET https://ipinfo.io/json through the tunnel -> VPN_OBSERVED_BODY/IP
vpn_exit_matches_gluetun # non-empty and equal
```

  Equality of "what Gluetun says its tunnel IP is" and "what the internet sees from inside this namespace" proves egress is the tunnel for *any* provider, without a provider-specific endpoint. Verified working: Gluetun v3.41.3 answers `/v1/vpn/status` and `/v1/publicip/ip` on loopback with no credentials (also relied on by `qbit-watch.sh`).
- Delete `vpn_fetch_mullvad`, `vpn_is_mullvad_exit` and `VPN_MULLVAD_*`. No provider gets a bespoke check.
- Provider is read from the `VPN_SERVICE_PROVIDER` env var the composition passes to the sidecars.

`vpn-check.sh`: log the provider (`VPN_SERVICE_PROVIDER`) in every line, fail on `vpn_exit_matches_gluetun` false, keep the `HOST_IP`/DNS/direct-egress failures verbatim.

`vpn-status.sh` payload becomes provider-neutral:

```json
{
  "provider": "mullvad", "protocol": "wireguard",
  "exit": { "ip": "…", "country": "…", "organization": "…", "matchesGluetun": true },
  "checks": { "tunnelExit": true, "killSwitch": true, "dns": true, "ipv6": true, "firewallException": true },
  "dns": { "nameservers": ["127.0.0.1"] },
  "firewall": { "directEgressBlocked": true, "exception": "192.168.1.10/32" },
  "ipv6": { "disabled": true },
  "coverage": [ … ]
}
```

`secure` requires `tunnelExit && killSwitch && dns && ipv6 && firewallException`. There is no provider-specific field, so the payload is identical in shape for all six providers.

### 8. Dashboard — no Mullvad-only labels

- `server/backend/src/upstream/vpn.ts`: parse `provider`, `protocol`, `exit.{ip,country,organization,matchesGluetun}`, `checks.tunnelExit`; drop `mullvad` / `mullvadExit` parsing. Reject a payload missing `provider` or `checks.tunnelExit`.
- `server/backend/src/types.ts` and `server/frontend/src/api/types.ts`: rename the check id `mullvad_exit` → `tunnel_exit`, add `provider` / `exitIp` / `country` / `organization`. No `mullvad` field survives in either type.
- `server/frontend` Services → VPN view: header becomes "{Provider} · {protocol}", show exit IP/country/org, keep the per-check list. No "Mullvad" string may remain anywhere in the view.
- Update `server/backend/test/routes.test.ts` fixtures (it currently asserts `mullvadExit: true` and `{ id: "mullvad_exit", passed: false }`).

### 9. Release gate (`scripts/vpn-gate.sh`, `scripts/release.sh`, `tests/vpn-gate/`)

The live stage currently asserts "a probe in the shared namespace sees a Mullvad exit". Change it to assert `tunnelExit` (observed exit IP == Gluetun's `/v1/publicip/ip`) and that `checks.tunnelExit` is true, which works for every provider. Any assertion that greps for `am.i.mullvad.net` or `mullvad_exit_ip` must go with the check. `tests/vpn-gate/fixture.env` stays Mullvad WireGuard; add a second fixture for PIA OpenVPN so both protocols render through `docker compose config` and `churn verify-vpn`.

### 10. Docs

- `README.md`: replace the Mullvad-only "VPN" bullets with a provider table (the six rows from the matrix), and state the default of WireGuard and the PIA OpenVPN exception.
- `docs/src/torrent.md`: rewrite "VPN and leak protection" for provider-neutral Gluetun config, the tunnel-IP verification proof, and the `--env-file` fixtures.
- `torrent/.env.example`: document both credential sets, `VPN_LOCATION` + the provider-specific location key, and remove `WIREGUARD_ARCHIVE` / `WIREGUARD_CONFIG` / the mullvad-only comments.

## Implementation order

1. `src/vpn.rs` + `scripts/vpn-servers.sh` (pure data, unit-testable, no UI).
2. `src/question.rs` variants + `applies_to` + secret masking.
3. `src/stack.rs` env generation + `write_merged(drop)` + delete `server_countries`.
4. `src/main.rs` ask loop, provider-first explain, `-y` behaviour.
5. `src/security.rs` provider validation + fixtures/`cases.tsv`.
6. `torrent/docker-compose.yml` + `vpn-lib.sh` / `vpn-check.sh` / `vpn-status.sh` (delete the Mullvad exit check, add the generalised tunnel-IP proof).
7. Backend + frontend types and VPN tab.
8. Docs, then `cargo test`, `cargo clippy`, `shellcheck`, `cargo fmt`, dashboard build/test, and `churn verify-vpn` against both fixtures.

## Acceptance criteria

- [ ] A fresh Mullvad install asks for the WireGuard key and a country, writes `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, `SERVER_COUNTRIES`, `VPN_LOCATION`, starts Gluetun, and passes `vpn-check`.
- [ ] No install path downloads, parses or requires a provider `.zip`; `src/mullvad.rs`, `WIREGUARD_ARCHIVE` and `WIREGUARD_CONFIG` are gone.
- [ ] Each of IVPN, ProtonVPN, NordVPN and Surfshark installs with a typed WireGuard key (plus address where the provider needs one) and its country picker, and writes only that provider's keys.
- [ ] PIA installs with OpenVPN username/password and a `SERVER_REGIONS` value from the embedded list, and writes no `WIREGUARD_*` key.
- [ ] The provider picker is the first VPN question and the follow-up prompts only include questions valid for that provider.
- [ ] Country/region selection rejects anything outside the embedded per-provider list and never needs the network.
- [ ] Rerun preserves provider, credentials and location; changing provider removes the previous provider's keys from `torrent/.env` with no stale `WIREGUARD_*` or `OPENVPN_*` left behind.
- [ ] `churn verify-vpn` accepts all six providers and still fails an unknown provider, a protocol/provider mismatch, an empty credential, a stale location key, and every existing leak case.
- [ ] `vpn-check` and the dashboard VPN tab work for a non-Mullvad provider, and no `am.i.mullvad.net` call, `mullvad_exit` check id, `mullvadExit` field or Mullvad-only label remains in `torrent/scripts/`, `server/backend/` or `server/frontend/`.
- [ ] `wiring`: no VPN password or private key appears in the plan, summary, logs or dashboard payload; `OPENVPN_PASSWORD` is masked like the WireGuard key.
- [ ] `cargo test`, `cargo clippy`, `cargo fmt --check`, `shellcheck` on `torrent/scripts/*.sh`, the dashboard build/tests, and the `tests/vpn-gate` matrix all pass.

## Out of scope (follow-ups)

- Port forwarding (`VPN_PORT_FORWARDING`) and wiring the forwarded port into qBittorrent's listen port — separate bean; PIA/Proton benefit most.
- PIA WireGuard via Gluetun's `custom` provider (needs a `pia-wg-config`-generated `.conf`).
- `SERVER_CITIES` / `SERVER_HOSTNAMES` refinement prompts, `PORT_FORWARD_ONLY`, `FREE_ONLY`.
- Refreshing the embedded lists at runtime; `scripts/vpn-servers.sh` keeps it a manual, reviewable step.

## Open questions

- Should the country picker offer an "Any (provider default)" entry so users who do not care skip the prompt? Lean no: exit country is a legal/selection-relevant choice for torrenting, and the picker is filterable.
- IVPN and Surfshark technically accept `SERVER_CITIES` too. Only countries are asked here; city filtering stays an `.env` edit.
- Removing the Mullvad exit check means a Mullvad user loses the "am I really on Mullvad" assertion and keeps only "my egress is the tunnel". Accepted: the kill switch plus tunnel-IP equality is what the check is actually for, and the account/provider identity is already proven by a successful WireGuard handshake.
- `churn verify-vpn` gains a provider-aware check that reads `torrent/.env`; today it only renders Compose. Confirm it is acceptable for that command to fail when the `.env` credential is empty even though Compose would start.

## Related

- `Gate releases on full-stack torrent VPN leak verification` (churn-earo) — the release gate must exercise both protocols, not just Mullvad WireGuard.
- `Restart qBittorrent when the VPN reconnects` (churn-axcr) — `qbit-watch.sh` already uses provider-neutral Gluetun control endpoints; no change expected, but re-verify against an OpenVPN provider.
- `Separate media and download locations` — unaffected, but touches the same `torrent/.env` writer.
