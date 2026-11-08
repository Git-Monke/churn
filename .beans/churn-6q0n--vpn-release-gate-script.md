---
# churn-6q0n
title: VPN release gate script
status: completed
type: task
priority: normal
tags:
    - security
    - release
    - vpn
created_at: 2026-11-07T18:29:53Z
updated_at: 2026-11-07T21:41:48Z
parent: churn-earo
---

Implement `plans/vpn-release-gate.md`: `scripts/vpn-gate.sh` as the single local
proof (static checks + live pinned stack + real negative controls), wired into
`scripts/release.sh` with no bypass flag.

See `plans/vpn-release-gate.md` for the full design.

## Todo

- [ ] Add `tests/vpn-gate/fixture.env` and `tests/compose_gate.rs` (validate the real `torrent/docker-compose.yml` plus override-based rejections)
- [ ] Add `system::verify_torrent_isolation_env` and the `churn verify-vpn` subcommand
- [ ] Write `scripts/vpn-gate.sh` stage 1 (static) and wire the `release.sh --dry-run` path
- [ ] Stage 2: live boundary checks in isolated project `churn-vpn-gate`, write `.churn-state/vpn-gate.json`
- [ ] Stage 3: negative controls (DNS leak, public `HOST_IP`, iptables kill switch, tunnel drop) + restore stage
- [ ] Stage 4: `--full` isolated stack run with coverage assertions
- [ ] CI: new `.github/workflows/ci.yml` and `release.yml` `vpn-gate` job with `publish` needs
- [ ] Docs (`docs/src/torrent.md` release gate section, README) and run the gate against the current tree


## Environment notes

- `cargo fmt --check` passes.
- `cargo clippy --locked --all-targets -- -D warnings` currently cannot run here:
  `error[E0514]: found crate 'libc' compiled by an incompatible version of rustc`
  (target/ was built with rustc 1.96.0, active toolchain is 1.94.1). `cargo clean`
  or a matching toolchain is needed before stage 1 is meaningful locally.
- `shellcheck` is not installed on this machine; CI must install it.
