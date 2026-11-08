---
# churn-earo
title: Gate releases on full-stack torrent VPN leak verification
status: completed
type: feature
priority: critical
tags:
    - security
    - release
    - testing
    - vpn
created_at: 2026-11-06T06:07:52Z
updated_at: 2026-11-08T00:06:08Z
---

# Why

If a release regresses the torrent stack's VPN boundary, every user's qBittorrent, Prowlarr and FlareSolverr traffic can exit directly and expose their IP to their ISP and to trackers. The current release pipeline verifies version consistency, binary builds, and that the dashboard image is pullable, but nothing proves the actual torrent stack that ships still confines traffic to the VPN.

This bean adds a release gate for the **full stack**, with negative tests that prove it fails closed, not just a happy-path smoke test.

# Current coverage

- `torrent/scripts/vpn-check.sh` + `vpn-lib.sh`: fail-closed runtime gate inside Gluetun's netns (Mullvad exit, direct `eth0` egress blocked, DNS only `127.0.0.1`, IPv6 disabled, local-only firewall exception).
- `torrent/scripts/vpn-status.sh`: live JSON leak check from the same netns.
- `src/security.rs` + `src/system.rs`: static validation of `docker compose config --format json` before `compose up`.
- `torrent/docker-compose.yml`: sidecars share `service:gluetun`; Gluetun owns published ports and the kill switch.
- `.github/workflows/release.yml`: builds binaries, checks the dashboard image, publishes. No Rust/shell tests and no torrent stack e2e.
- `src/security.rs` tests use synthetic compose fixtures, not the real `torrent/docker-compose.yml`.

# Gaps

1. `cargo test`, clippy and shell tests never run in CI. A change to `security.rs`, `vpn-lib.sh` or the compose file can merge and ship untested.
2. The security validator is never run against the real compose file and real `.env` interpolation in CI.
3. No negative-path tests prove `vpn-check` fails closed (direct egress succeeds, second nameserver present, missing `eth0`, IPv6 enabled, public `HOST_IP`).
4. No release job brings up the actual pinned images and proves `secure:true` end to end.
5. No test proves traffic stops when the tunnel drops (kill-switch behaviour under failure), only that the pre-flight gate refuses to start.
6. No enforcement: a `v*` tag can publish without any VPN gate.

# Goal

A release cannot be published unless the exact commit/tag being released has passed a deterministic config/script gate and a live full-stack leak test (or an explicit, documented manual sign-off when the credentialed environment is unavailable). "Pass" means no torrent-stack container can reach the internet outside the Mullvad tunnel, DNS cannot resolve outside Gluetun's resolver, IPv6 cannot leak, and the stack fails closed when any control breaks.

# Proposed implementation

## Layer 1 - deterministic gate on every PR/push (no secrets)

- Add a `torrent-security` CI job that runs:
  - `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
  - `shellcheck` on `torrent/scripts/*.sh` and `scripts/*.sh`.
  - A fixture `.env` (dummy WireGuard key/address, loopback `HOST_IP`) plus `docker compose -f torrent/docker-compose.yml config --format json`, fed into `security::verify_torrent_isolation`. Expose this as a read-only test or a small `churn verify-torrent-config` command so CI and `release.sh` share one implementation.
  - A test asserting every service with `network_mode` other than `none` is `service:gluetun`, only `gluetun` has `ports`, and every networked service mounts `resolv.conf`.
- Run the same steps in `scripts/release.sh` before tagging (fast, no credentials).

## Layer 2 - fail-closed script tests (no real VPN)

- Add a harness under `tests/` or `torrent/scripts/tests/` that sources `vpn-lib.sh` and stubs `curl`, `/etc/resolv.conf`, `/sys/class/net` and `/proc/sys/...` via `PATH`/temp dirs or a `VPN_*` override seam.
- Required cases, each asserting non-zero exit / `secure:false`:
  - Mullvad response has `mullvad_exit_ip:false`; request fails or times out.
  - `curl --interface eth0` succeeds (kill switch broken).
  - `/etc/resolv.conf` has only `127.0.0.1` (pass) vs a second nameserver, missing file, or no `127.0.0.1` (fail).
  - `/sys/class/net/eth0` missing (fail, never "assume blocked").
  - IPv6 not disabled (fail).
  - `HOST_IP` public or broad exception (fail); empty, loopback or RFC1918 (pass).
  - `vpn-status.sh` emits valid JSON with `secure:true` only when all checks pass; `secure:false` if any single check fails.
- Run on Linux in CI.

## Layer 3 - live full-stack e2e (trusted runner or manual release gate)

- Preferred: a self-hosted/trusted runner with Docker, `/dev/net/tun`, `NET_ADMIN`, outbound WireGuard, and repository secrets for an **ephemeral, release-only** Mullvad WireGuard key. Never a maintainer's personal key; rotate after use.
- Steps:
  1. Check out the tag under test; set `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, `HOST_IP`.
  2. `docker compose up -d --wait`, then assert `vpn-check` logs `PASS: torrent egress is confined to the VPN` and exited 0.
  3. `curl -fsS http://127.0.0.1:8098/status`; assert `secure:true`, every `checks.*` true, and `coverage` reachable for qbittorrent, prowlarr and flaresolverr.
  4. From a container in Gluetun's netns: assert the public IP is a Mullvad exit, DNS resolves only via `127.0.0.1`, no IPv6 route exists, and direct `eth0` to a public canary fails.
  5. Negative controls (the important part):
     - Break DNS (second nameserver or public resolver) -> `vpn-status` returns `secure:false`; startup gate refuses.
     - Enable IPv6 or add a public `FIREWALL_OUTBOUND_SUBNETS` -> config gate rejects before `up`.
     - Stop/block the WireGuard endpoint (drop UDP to the peer) -> app containers lose egress, no direct leak, qBittorrent stops/pauses instead of downloading.
     - Remove `network_mode: service:gluetun` or publish a sidecar port in a temporary override -> config gate rejects.
  6. Tear down, scrub credential-bearing logs, and publish a gate artifact (JSON summary plus `vpn-check`/`vpn-status` output with IPs redacted).
- Fallback if no credentialed runner exists: a documented `docs/release-checklist.md` manual gate with the exact commands and required evidence attached to the release. `release.sh` refuses to push unless `VPN_GATE=verified` (or similar) is set, so a manual gate is explicit rather than forgotten.

## Layer 4 - release enforcement

- `release.yml`: add the layer-1/2 gate and a `vpn-e2e` job; make `publish` `needs: [binaries, vpn-e2e]`. No `continue-on-error` for security assertions.
- Run the gate on the tag commit, not `main`. Ensure the e2e uses the exact tag and pinned image digests from `torrent/docker-compose.yml` (no floating tags).
- Add the gate result/artifact link to the release notes.
- `scripts/release.sh` runs the layer-1/2 preflight locally and refuses to push when the gate is absent; it prints the layer-3 automated result or the manual checklist.
- Keep runtime behaviour unchanged; this is a release gate, not a new runtime dependency.

# Acceptance criteria

- [ ] PR CI fails if `torrent/docker-compose.yml` stops confining any networked service to `service:gluetun`, loses Gluetun's firewall/DNS/IPv6 settings, or a sidecar publishes ports.
- [ ] CI runs `cargo test`, clippy and shellcheck on every push and tag.
- [ ] Negative tests prove each `vpn-lib.sh` check fails closed, not just the happy path.
- [ ] A live e2e (automated or documented manual) proves `secure:true` for the exact release commit and that dropping the tunnel produces no direct leak.
- [ ] A `v*` tag cannot publish unless the layer-1/2 gate passes and the layer-3 result is recorded.
- [ ] Secrets are ephemeral/rotated, never logged, and unavailable to fork PRs.
- [ ] README/docs explain how to run the gate locally and what to do when it fails.

# Out of scope / risks

- Replacing Gluetun or the runtime checks; this bean only adds release-time verification.
- Guaranteeing tracker or indexer behaviour; the contract is network egress confinement.
- GitHub-hosted runners may not allow TUN/WireGuard; use a trusted self-hosted runner or the documented manual fallback.
- Upstream image tags can drift; pin digests and test the pinned set.
- E2E flakiness: retry only startup timing, never security assertions.
- Credential leak risk: use a dedicated Mullvad key with minimal TTL and rotate it.

# References

- `torrent/scripts/vpn-check.sh`, `torrent/scripts/vpn-lib.sh`, `torrent/scripts/vpn-status.sh`
- `torrent/docker-compose.yml`
- `src/security.rs`, `src/system.rs`
- `.github/workflows/release.yml`
- `scripts/release.sh`, `scripts/check-version.sh`
- `docs/src/torrent.md`, README "VPN leak protection"

# Open decisions

- Automated live e2e on a self-hosted runner vs manual release sign-off for now?
- Which negative-test method proves "no leak" without generating real torrent traffic (HTTP canary endpoint plus qBittorrent paused)?
- Should the gate block every release or only torrent-affecting changes? Recommendation: every release, because the stack always ships.
- Where should gate artifacts live: Actions artifact, release asset, or both?

# Todo

- [ ] Decide automated vs manual live gate and provision the runner/secret.
- [ ] Add the layer-1 CI job and local `release.sh` preflight.
- [ ] Add the real-compose validation test.
- [ ] Add layer-2 fail-closed script tests.
- [ ] Implement the layer-3 e2e script or manual checklist.
- [ ] Wire `release.yml` / `release.sh` to require the gate.
- [ ] Document the release checklist and failure handling.
- [ ] Run the gate against the current release and record the result.
