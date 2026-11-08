# VPN release gate — one local script that proves the shipping stack still confines torrent traffic

> **Status: implemented.** `scripts/vpn-gate.sh`, `tests/compose_gate.rs`,
> `tests/vpn-gate/` (fixture env, `isolated.yml`, `unsafe/`), the `churn
> verify-vpn` subcommand, `scripts/release.sh` wiring, `.github/workflows/ci.yml`
> and the `vpn-gate` job in `.github/workflows/release.yml` are all in the tree.
>
> Deviations from the plan as written below:
>
> - The negative-control list is data, not code: `tests/vpn-gate/unsafe/cases.tsv`
>   plus one override file per case, read by *both* `cargo test --test
>   compose_gate` and the gate's static stage, so the two can never disagree.
> - `churn verify-vpn` also takes `--config <path|->` to validate an already
>   rendered `docker compose config --format json`, which is how the gate checks
>   21 variants through one implementation of the rules.
> - Stage 4 recreates the whole project (`up -d --force-recreate`), not only
>   gluetun, because the negative controls also rerun sidecar checks.
> - Four pre-existing clippy warnings were fixed (`src/question.rs`,
>   `src/main.rs`, `src/security.rs`) because the gate runs clippy with
>   `-D warnings`.
> - `.shellcheckrc` sets `source-path=SCRIPTDIR` and `external-sources=true` so
>   the sourced check library resolves; both `vpn-check.sh` and `vpn-status.sh`
>   carry `# shellcheck source=vpn-lib.sh`.

## Context

`churn-earo` wants a release blocked unless the exact code being released still keeps
qBittorrent, Prowlarr and FlareSolverr inside Gluetun's tunnel. Today:

- `scripts/release.sh` bumps the version, tags and pushes. No security check at all.
- `.github/workflows/release.yml` only builds binaries and checks the dashboard image.
- `cargo test`, clippy and shell tests never run in CI.
- `src/security.rs::verify_torrent_isolation` is only ever run against synthetic
  fixtures, never the real `torrent/docker-compose.yml`.
- `torrent/scripts/vpn-lib.sh` fail-closed logic has no negative tests.
- Nothing proves the *live* stack that ships confines egress at the pinned images.

Goal: `scripts/vpn-gate.sh` is the single, local, deterministic proof. `scripts/release.sh`
runs it and refuses to tag/push if it does not pass. CI runs the same deterministic
part and gates `publish`.

## Decisions (this planning round)

1. **Live layer is local only.** No self-hosted runner, no Mullvad secret in GitHub.
   `release.sh` always requires the live run ("Always require" — no skip flag).
   Consequence: a release can only be cut from a host with Docker, `/dev/net/tun`,
   and an installed `torrent/.env` (WireGuard key). This is intentional.
2. **One validator implementation.** Add a thin `churn verify-vpn` subcommand that
   calls the existing `security::verify_torrent_isolation` against
   `docker compose config --format json`. No rules re-implemented in bash/jq.
3. **CI:** new `.github/workflows/ci.yml` (PR + main push) for fmt/clippy/test,
   shell syntax + shellcheck, and the real-compose validation; extend
   `release.yml` with a static `vpn-gate` job that `publish` needs.
4. **Simplicity:** no stub-injection harness for `vpn-lib.sh` (that would mean
   adding test seams to production scripts and a weaker second copy of the same
   assertions). Fail-closed behaviour is proven by *breaking a real stack* in an
   isolated Compose project instead. IPv6 and public-`HOST_IP` cases are proven at
   the config layer, where they are actually rejected.
5. **The live run never touches the installed stack.** It runs in its own Compose
   project (`-p churn-vpn-gate`), its own ports (`18080/19696/18098`) and its own
   temp `DATA_DIR`, using the same pinned images from `torrent/docker-compose.yml`.
   It only binds `torrent/resolv.conf` and the scripts, never `torrent/config/*`,
   so a gate run cannot clobber a live qBittorrent/Prowlarr config.

## Gate contract

`scripts/vpn-gate.sh [--static-only] [--keep] [--verbose]`

The live stages run the **whole stack** in one isolated Compose project — that is
what ships, so that is what gets tested. There is no separate "boundary-only"
mode to keep in sync.

| Stage | Needs | What it proves |
| --- | --- | --- |
| 1. static | docker, cargo | `fmt`, `clippy -D warnings`, `cargo test`, real-compose validation, shell syntax |
| 2. live | docker + tun + WireGuard key | the pinned stack starts, `vpn-check` exits 0 with `PASS: torrent egress is confined to the VPN`, `vpn-status` reports `secure:true` with every check and full `coverage` |
| 3. negative controls | same | each control, when broken, makes the stack fail closed |
| 4. restore | same | after the sabotage, the clean stack is `secure:true` again |

Exit 0 only if all stages pass. `--static-only` skips 2–4 (CI, no credentials, no
root). The gate reads the WireGuard credentials from `torrent/.env` by default;
`VPN_GATE_ENV=<path>` points it at another env file, and a missing key is a hard
error (never a silent skip). The gate only ever runs `docker compose` with
`-p churn-vpn-gate` and never touches another project. Failure prints the failing check, the command, and the container logs it
came from. On success the gate writes `.churn-state/vpn-gate.json` (gitignored):
fingerprint, git sha, timestamps, per-check booleans, image refs. Exit IPs are
never written. The WireGuard key is never printed (`sed` scrub on every log tail).

### Fingerprint (why the proof survives the release commit)

`release.sh` creates a `Release vX.Y.Z` commit that only touches `Cargo.toml` and
`Cargo.lock`, so a HEAD-sha-keyed proof would be invalidated by the release
itself. The gate therefore records a sha256 over the files that define the VPN
boundary:

```
torrent/docker-compose.yml  torrent/resolv.conf  torrent/scripts/*.sh
src/security.rs  src/system.rs  scripts/vpn-gate.sh
```

The proof is valid for a HEAD whose fingerprint matches; the version bump does
not change it, a change to any boundary file does.

## Stage 1 — static (deterministic, no secrets)

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo test --locked --test compose_gate          # real compose file -> validator
sh -n torrent/scripts/*.sh torrent/scripts/tests/*.sh
bash -n scripts/*.sh
scripts/check-version.sh                          # existing; cheap, catches drift
```

New `tests/compose_gate.rs`:

- generates the fixture env once (`tests/vpn-gate/fixture.env`, committed):
  dummy `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES=10.64.0.2/32`,
  `DATA_DIR=/tmp/churn-vpn-gate-data`, `HOST_IP=127.0.0.1`, `TZ=UTC`;
- runs `docker compose --env-file <fixture> -f torrent/docker-compose.yml config --format json`
  and asserts `verify_torrent_isolation` returns `Ok`;
- asserts the *rejections* that today have no test: a public
  `FIREWALL_OUTBOUND_SUBNETS` (`8.8.8.8/32`, `0.0.0.0/0`), a second nameserver /
  plaintext resolver knobs, `net.ipv6.conf.all.disable_ipv6=0`, a sidecar that
  publishes a port, a sidecar with `network_mode: bridge`, a sidecar missing the
  `resolv.conf` mount — each via a small generated compose override, so the real
  file plus one delta is what gets rejected;
- fails loudly if `docker compose` is unavailable (never skips a security gate).

New CLI surface (`src/main.rs`, documented in README "Development"):

```
churn verify-vpn [--dir <path>] [--env-file <path>]
```

Calls `system::verify_torrent_isolation_env(dir, env_file)`; prints every problem
on stderr, exits 1 on any. `system::verify_torrent_isolation` keeps its signature
and delegates (installer path unchanged).

## Stage 2 — live (the real pinned stack, whole)

```bash
cd torrent
export QBITTORRENT_PORT=18080 PROWLARR_PORT=19696 VPN_STATUS_PORT=18098
export DATA_DIR=/tmp/churn-vpn-gate/data         # throwaway
export $(load non-secret keys from torrent/.env: WIREGUARD_PRIVATE_KEY,
        WIREGUARD_ADDRESSES, SERVER_COUNTRIES, HOST_IP, TZ, PUID, PGID)
docker compose -p churn-vpn-gate -f docker-compose.yml -f tests/vpn-gate/isolated.yml \
  up -d --wait --wait-timeout 240
```

Assertions:

1. `docker inspect -f '{{.State.ExitCode}}' churn-vpn-gate-vpn-check-1` is `0` and
   its log contains `PASS: torrent egress is confined to the VPN`.
2. `curl -fsS http://127.0.0.1:18098/status` → `secure:true` and all of
   `mullvadExit, killSwitch, dns, ipv6, firewallException` true
  (parsed with `jq -e`, no grep-on-JSON).
2b. The `vpn-status` body's `mullvad.mullvad_exit_ip == true` — proves the exit is
   Mullvad, not merely "some network".
3. A throwaway probe container joins the *same* netns and proves the shared
   namespace belongs to the tunnel provider's container:

   ```bash
   docker run --rm --network container:churn-vpn-gate-gluetun-1 curlimages/curl:8.23.0 \
     -4 -fsS -m 10 https://am.i.mullvad.net/json
   ```

   must report a Mullvad exit, and `docker inspect` of the gate project's
   `vpn-status`/`vpn-check` shows `NetworkMode=container:<gluetun id>`.

`tests/vpn-gate/isolated.yml` is a Compose override applied to every live stage.
It redirects every `./config/*` and `../server/config/*` bind under `${VPN_GATE_TMP}`.
`DATA_DIR` and the published ports stay in the environment (Compose override
files cannot interpolate into `DATA_DIR`, which `docker-compose.yml` requires):

```bash
export DATA_DIR=$tmp/data                       # throwaway, never the real library
mkdir -p "$tmp/data"
# relative bind sources inside torrent/config become absolute; the override sets:
#   qbittorrent:      ./config/qbittorrent            -> $tmp/config/qbittorrent
#   prowlarr:         ./config/prowlarr               -> $tmp/config/prowlarr
#   qbittorrent-init: ./config/qbittorrent            -> $tmp/config/qbittorrent
#   prowlarr-init:    ./config/{prowlarr,qbittorrent} -> $tmp/config/...
#                     ../server/config/{sonarr,radarr} -> $tmp/server-config/...
```

`prowlarr-init` then logs `no Sonarr/Radarr config found ... skipping` and exits
cleanly, which is expected. The resource names come from an explicit
`-p churn-vpn-gate`, so container names are `churn-vpn-gate-gluetun-1` etc.
regardless of the directory name the gate runs from.

Because the whole stack runs, stage 2 also asserts `vpn-status` `coverage` is
all-true (qBittorrent, Prowlarr, FlareSolverr reachable *inside* the tunnel) and
that an egress probe in qBittorrent's namespace reports a Mullvad exit.

## Stage 3 — negative controls (fail closed, not happy path)

Each case starts from the known-good stack stage 2 just proved and must produce a
non-zero exit or `secure:false`. No `continue-on-error`; retries are allowed only
for startup timing, never for a security assertion.

1. **DNS leak (live).** Into the running project, `docker compose ... run --rm
   --no-deps --entrypoint /bin/sh vpn-status /scripts/vpn-status.sh`, with a
   generated override that binds a `resolv.conf` containing both
   `nameserver 127.0.0.1` and `nameserver 1.1.1.1`. Assert the JSON has
   `checks.dns:false` and `secure:false`. Run `vpn-check.sh` the same way: it must
   exit non-zero with `resolv.conf contains a non-Gluetun nameserver`.
2. **Public firewall exception (static).** `FIREWALL_OUTBOUND_SUBNETS=8.8.8.8/32`
   and `0.0.0.0/0` via `--env-file` overrides → `churn verify-vpn` exits non-zero.
3. **IPv6 enabled (static).** Override `sysctls: net.ipv6.conf.all.disable_ipv6: 0`
   → `churn verify-vpn` rejects. Never started: an IPv6-enabled namespace is
   exactly the unsafe state we refuse to create.
4. **Kill switch broken (live, the important one).**
   `docker exec -u 0 churn-vpn-gate-gluetun-1 iptables -I OUTPUT -o eth0 -j ACCEPT`,
   then re-run the `vpn-check` and `vpn-status` logic in the same namespace. Both
   must fail: `vpn-check` exits non-zero with
   `traffic through eth0 reached the internet`, `vpn-status` reports
   `checks.killSwitch:false`. Scoped to the throwaway container's namespace; the
   project is recreated from scratch for stage 4, which re-proves the clean state.
5. **Tunnel drop (live).** `docker compose -p churn-vpn-gate stop gluetun`, then
   prove the app namespaces have no path out at all:

   ```bash
   docker run --rm --network container:churn-vpn-gate-vpn-status-1 \
     curlimages/curl:8.23.0 -4 -fsS -m 5 http://1.1.1.1/
   ```

   must fail; the qBittorrent namespace probe must fail the same way. Then
   `docker compose -p churn-vpn-gate start gluetun` and wait for healthy.
6. **Sidecar escapes the namespace (static).** Override `network_mode: bridge` on
   `prowlarr` → rejected; also `ports: ["9696:9696"]` on `prowlarr` → rejected;
   also drop the `resolv.conf` mount from `qbittorrent` → rejected.

Cases 2, 3, 6 are config-layer and are implemented once, in
`security::verify_torrent_isolation`; the script invokes them through
`churn verify-vpn`, so there is exactly one implementation. Cases 1, 4, 5 are
live and use real containers.

## Stage 4 — restore and record

1. Undo the sabotage from the inside: `docker compose -p churn-vpn-gate up -d
   --force-recreate gluetun` (a fresh netns drops the injected iptables rule) and
   wait for healthy; `start` gluetun if stage 3 case 5 stopped it.
2. Re-run the stage-2 assertions on the restored project. The artifact therefore
   records `clean` *after* the sabotage, which is the point: the gate does not
   just prove a fresh stack works, it proves the stack recovers to a safe state.
3. `docker compose -p churn-vpn-gate down --remove-orphans` (skipped with
   `--keep`, which prints the temp dir and leaves the project up for debugging).
   `rm -rf "$tmp"`, which includes the throwaway `DATA_DIR`.
4. Write `.churn-state/vpn-gate.json`:

   ```json
   {
     "version": "0.2.2",
     "gitSha": "…",
     "fingerprint": "sha256:…",
     "startedAt": "…", "finishedAt": "…",
     "static": {"ok": true, "commands": [...]},
     "live": {"ok": true, "checks": {"mullvadExit": true, "killSwitch": true,
              "dns": true, "ipv6": true, "firewallException": true},
              "coverage": {"qbittorrent": true, "prowlarr": true,
                           "flaresolverr": true},
              "images": ["qmcgaw/gluetun:v3.41.3", "curlimages/curl:8.23.0", …]},
     "negative": {"dnsLeak": true, "publicHostIp": true, "ipv6": true,
                  "killSwitchBroken": true, "tunnelDropped": true,
                  "sidecarEscaped": true},
     "restored": true
   }
   ```

   No exit IP, no WireGuard key, no hostnames beyond the pinned image refs.
5. Print a one-screen summary and the artifact path for attaching to the release.

## Script shape (`scripts/vpn-gate.sh`)

- `#!/usr/bin/env bash`, `set -euo pipefail` (same dialect as the other
  `scripts/*.sh`; `torrent/scripts/*.sh` stay POSIX `sh` and are only executed,
  never sourced by the gate).
- Top-level: `cd "$(dirname "$0")/.."`, parse `--static-only|--keep|--verbose|-h`,
  require `docker`, `cargo`, `jq`; require `/dev/net/tun` and a WireGuard key in
  the live path only.
- One function per stage: `stage_static`, `stage_live`, `stage_negative`,
  `stage_restore`, each returning non-zero on the first failed assertion;
  `trap cleanup EXIT` always runs `compose down` + `rm -rf "$tmp"` unless `--keep`
  or the failing stage is being debugged (`VPN_GATE_KEEP_FAILURE=1`).
- Machine-readable assertions use `jq -e` against `vpn-status` JSON;
  `vpn-check` is asserted on its exit code plus its `PASS:`/`FAILED:` log line.
- Every failure prints `FAIL <case>: <expected> / <actual>` plus the last 25 log
  lines of the containers involved, filtered through
  `sed -E 's/(PrivateKey|WIREGUARD_PRIVATE_KEY)[^ ]*/\1=<redacted>/g'`.
- Stages are independently runnable for debugging: `--static-only`,
  `VPN_GATE_ONLY=live|negative|restore`.
- The gate never edits repository files; everything mutable lives in
  `$(mktemp -d)` and `.churn-state/vpn-gate.json`.

## `scripts/release.sh` integration

Insert, **before** any version math and before `Cargo.toml` is touched (right
after the branch / clean-tree checks):

```bash
if [ "$dry_run" -eq 1 ]; then
  scripts/vpn-gate.sh --static-only
else
  scripts/vpn-gate.sh          # static + live + negative + restore
fi
```

- Any failure aborts with `"error: the VPN release gate failed; nothing was tagged or pushed"`.
- No bypass flag ("Always require"). `--no-push` still runs the full gate — it is
  release preparation, not a scratch run. `--dry-run` stays cheap (static only)
  so `--help`/dry-run remain usable on any machine.
- After a successful tag, print the artifact path next to the existing
  "CI will build the binaries..." line, and (optionally) attach
  `.churn-state/vpn-gate.json` as a release asset — deferred; the local proof plus
  CI's static run is the gate.
- Header usage block updated with a "Requirements" note: Docker, `/dev/net/tun`,
  `torrent/.env`.

## CI

New `.github/workflows/ci.yml` (`push` to main, `pull_request`, `workflow_dispatch`):

- `rust`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  `cargo test --locked` (ubuntu-latest ships Docker, so `tests/compose_gate.rs` runs).
- `vpn-config`: `docker compose --env-file tests/vpn-gate/fixture.env -f torrent/docker-compose.yml config --format json`
  piped through `cargo run --quiet -- verify-vpn`, plus `cargo test --test compose_gate`.
- `shell`: `shellcheck` on `scripts/*.sh` and `torrent/scripts/*.sh` with a
  committed `.shellcheckrc` (disable the noisy `SC1091`/`SC3043` families after a
  first pass), plus `sh -n`/`bash -n`.

`.github/workflows/release.yml`: add job

```yaml
vpn-gate:
  name: VPN config gate
  runs-on: ubuntu-latest
  steps: [checkout, cargo test --test compose_gate, verify-vpn with fixture env]
```

and `publish: needs: [binaries, vpn-gate]`. The live layer is not in CI by
decision 1; the local gate in `release.sh` is the enforcement point, so a `v*` tag
pushed by hand still gets the static job.

## Docs

- `docs/src/torrent.md` → "VPN and leak protection": add a "Release gate" section
  (what `scripts/vpn-gate.sh` does, how to run it, what each failure means, that
  it uses an isolated project and does not touch the installed stack).
- README: under "Development"/releases, document `churn verify-vpn` and the gate
  requirement; mention `--static-only` for machines without tun/credentials.
- `.gitignore` already ignores `.churn-state/` and `.env`; add
  `/tests/vpn-gate/tmp/` if the script writes there (prefer `mktemp -d` instead).

## Risks / tradeoffs

- **Two gluetun instances on one host** (gate project + installed stack) using the
  same WireGuard key. Mullvad permits multiple simultaneous connections per key;
  the gate uses only its own published ports, so no collision. If a provider
  refuses the second session, stop the installed torrent stack for the gate run
  (and say so in the failure message).
- **Gate runtime**: stage 1 ~1–3 min cold; stages 2–4 ~5–8 min (image pull once,
  gluetun connect, whole stack up, three restarts). Acceptable for a release, not
  for a commit hook.
- **Requires root/docker group on the release host** and a working Mullvad config;
  releases from CI or a bare laptop become impossible by design.
- **`iptables` availability inside the pinned gluetun image** — assert once in the
  script with `docker exec ... command -v iptables`, fail with a clear message if a
  future image drops it (then the kill-switch negative test must move to a
  `--config`-only assertion).
- Static layer trust: `docker compose config` requires a *fillable* env, so the
  fixture is committed; it must never contain a real key (dummy base64 only).
- The gate can pass while a *host-level* leak exists (e.g. Docker `--network host`
  added elsewhere). Out of scope: the contract is the shipped compose file.

## Implementation order

1. `tests/vpn-gate/fixture.env` + `tests/compose_gate.rs` (+ fixture-based
   rejections). Start here: it is the fastest feedback and fixes today's biggest
   gap (real file never validated).
2. `system::verify_torrent_isolation_env` + `churn verify-vpn` CLI + help text.
3. `scripts/vpn-gate.sh` stage 1 only; wire `release.sh` dry-run path + docs.
4. `tests/vpn-gate/isolated.yml` + stage 2 (whole stack up, assertions,
   `.churn-state/vpn-gate.json`).
5. Stage 3 negatives (DNS, public `HOST_IP`, iptables kill switch, tunnel drop)
   + restore stage; scrub logs.
6. `.github/workflows/ci.yml`, `release.yml` `vpn-gate` job + `needs`.
7. Docs, then run the whole gate against the current tree (0.2.2 / next tag) and
   record the artifact.

### What is verified, and what is not

Verified by running the gate on this host (Docker 29.9.2, kernel
7.0.13-100.fc43, gluetun v3.41.3):

- Full run (`scripts/vpn-gate.sh`) exits 0 with all four stages: static
  (22 known-unsafe layouts rejected, shipped file accepted), live
  (`vpn-check` PASS, `vpn-status` `secure:true` with all five checks and a
  Mullvad exit), negative (DNS leak, public `HOST_IP`, broken kill switch and
  blackholed tunnel each refused), restore (fresh namespace secure again,
  sandbox removed, artifact written).
- The gate cannot be satisfied by a broken check. Two sabotages of
  `vpn_direct_egress_blocked` in `torrent/scripts/vpn-lib.sh`:
  - always `return 0` (claims egress blocked, lint-clean): stage 2 passed and
    no static check noticed, but stage 3's positive+negative control failed with
    `vpn-check accepted direct eth0 egress`. The negative control is what
    catches a lying check; the static layer alone cannot.
  - always `return 1` (claims egress reachable): stage 2 failed closed with
    `FAILED: traffic through eth0 reached the internet`, the sandbox never came
    up, and the gate exited 1.
- `release.sh --dry-run` aborts with
  `error: the VPN release gate failed; nothing was tagged or pushed` when a case
  the validator accepts is added, and when the kill switch is disabled.
- Cleanup no longer leaks: root-owned sandbox trees are removed from inside a
  container (`--user 0`), verified by checking `/tmp` for leftovers afterwards.

Two things found by running it for real, both now handled:

- **Gluetun's firewall layout**: `OUTPUT` ends in a DROP policy with its own
  ACCEPT rules, so the saboteur rule must be `iptables -I OUTPUT 1 -o eth0 -j
  ACCEPT`. A `RETURN` there falls through to the DROP policy and never re-opens
  the interface — the first version of this control silently proved nothing
  until the positive control caught it.
- **Coverage is not a security property**: FlareSolverr's Chromium dies with
  SIGBUS (exit 135) on this host under Docker's default seccomp profile, even on
  a plain bridge network with no VPN involved. `vpn-status` was reporting
  `secure: true` while FlareSolverr had restarted 1978 times. The gate now
  gates on the five network checks only, reports unreachable apps as a loud
  warning, and records them in `coverageWarnings` in the artifact. The SIGBUS is
  a host/application problem, tracked separately.
