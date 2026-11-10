---
# churn-yjd6
title: churn update reconciles created, removed and changed containers
status: todo
type: feature
priority: normal
tags:
    - update
    - compose
    - installer
created_at: 2026-11-10T22:41:11Z
updated_at: 2026-11-10T22:41:11Z
---

## Problem

`churn update` re-materializes only the **server** assets and recreates only the
`dashboard` service (`src/main.rs:2038 update_dashboard`). The torrent stack is
never touched. So when a release adds a service to `torrent/docker-compose.yml`
— like `qbit-watch` in churn-axcr — an existing install keeps running the old
set of containers forever. `assets::materialize` is not even called for
`Stack::Torrent`, so the installed compose file never gains the new service.

Anything that is created, removed, or changed in a released compose file between
versions is therefore silently skipped. The only workaround today is
`sudo churn` (full installer, which prompts again) or hand-running
`docker compose up -d`.

## Verified Compose behaviour (docker compose 5.7.0)

Probed against a throwaway project:

| Case | Plain `up -d` |
| --- | --- |
| service added to the file | created |
| service removed from the file | **kept**; only warns `Found orphan containers (...) ... --remove-orphans` |
| service config changed (config-hash label) | recreated |
| service unchanged | left alone |
| image tag changed | pulled, container recreated |
| exited one-shot (`restart: "no"`) | restarted |
| netns owner (gluetun) recreated | `network_mode: service:` sidecars recreated too |
| `up -d --remove-orphans` | also removes the orphans |
| `up -d --dry-run --remove-orphans` | prints `Running`/`Starting`/`Recreating` per container, changes nothing |

So a single project-wide `docker compose up -d --remove-orphans` per installed
stack gives exact reconciliation, and `--dry-run` gives a free preview.

## Plan

### 1. `src/system.rs` — reconcile helper

```rust
pub fn compose_up_reconcile(dir: &Path, on_event: &mut dyn FnMut(&str)) -> io::Result<()>
    // docker compose --progress json up -d --remove-orphans
pub fn compose_up_dry_run(dir: &Path, on_event: &mut dyn FnMut(&str)) -> io::Result<()>
    // ... up -d --remove-orphans --dry-run
```

Both go through the existing `compose_run`, so `LiveLog` and the error tail keep
working. `compose_up` stays for the installer path (no orphan removal there).

### 2. `src/main.rs` — `reconcile_stacks(chosen, dry_run)`

New function next to `start_stacks`, reusing its safety gates:

- skip stacks with no `.env` or no `docker-compose.yml` (not installed);
- `assets::materialize(&envfile::root(), stack)` for **every** installed stack
  (this is the fix for the missing `qbit-watch` compose entry);
- for `Stack::Torrent`, re-run `system::verify_torrent_isolation` and
  `system::verify_compose_default_route` before `up`, exactly like
  `start_stacks` (`src/main.rs:1089`) — never reconcile the torrent stack
  without the VPN gate;
- `dry_run` → `compose_up_dry_run`, otherwise `compose_up_reconcile`, wrapped in
  `LiveLog` with a `reconciling <stack>` header;
- server stack is reconciled before torrent (`stack::start_order`), because
  `prowlarr-init` reads the Sonarr/Radarr keys.

Re-running the `restart: "no"` one-shots (`server-init`, `qbittorrent-init`,
`vpn-check`) on every update is intentional: they are idempotent by design
(`server/scripts/server-init.sh`, `torrent/scripts/qbittorrent-init.sh` both say
so). Call this out in the bean and the docs.

### 3. `update_dashboard` — keep the version pin, drop the double work

Leave `update_dashboard` as the authority for the dashboard image: manifest
check → pull → `assets::materialize(Server)` → upsert `CHURN_DASHBOARD_IMAGE` →
`compose_recreate_service(dashboard)` → health poll → rollback. Remove nothing
here; step 2 runs afterwards and will find the dashboard already correct (its
config-hash matches), so it is a no-op for that service.

### 4. `update_host` — wire it in

- `want_stacks = !args.binary_only`: reconcile runs in **both** halves, because
  the re-exec child owns the new assets.
- Child command (`src/main.rs:1934`) keeps `--dashboard-only`; that flag means
  "skip the binary", not "only the dashboard" — update its help text.
- Order: binary self-update → (child) dashboard image → `reconcile_stacks` →
  `cleanup_update_backup`. The binary backup must survive until **both** the
  dashboard and the stack reconcile succeed, so `cleanup_update_backup()` moves
  after the reconcile and the error path keeps `backup_hint()`.
- Nothing-to-do check: reconcile is not version-gated (drift can exist at the
  same version), so `churn update` at the latest version must still reconcile.
  Adjust the early return at `src/main.rs:1833` — "up to date" only short-circuits
  when `--binary-only` is set or nothing is installed.
- `--dry-run` prints the compose dry-run plan instead of starting anything.
- `--stacks`: allow `server`/`torrent` on `update` to limit the reconcile;
  relax the check at `src/main.rs:261`. Keep `--dashboard-only` meaning the
  server dashboard image.
- Prompt text: `"Update churn, restart the dashboard and reconcile the stacks?"`
  and the matching `(true,false)`/`(false,true)` variants.

### 5. Tests

- `src/compose.rs`: reconcile output goes through the existing `Event` parser;
  add a case for `Recreate`/`Removed` statuses if any are unhandled.
- `tests/installer.rs` or a new `tests/reconcile.rs`: pure-function test for the
  stack selection ("which stacks count as installed") using a temp root —
  installed / missing `.env` / missing compose file / both.
- Extend `tests/compose_gate.rs` so the real `torrent/docker-compose.yml` is
  rendered and its service list is asserted to contain `qbit-watch`, `vpn-check`,
  `vpn-status`, `qbittorrent-init` and `prowlarr-init`. That is the regression
  test for "a new service exists but an old install never gets it".
- Manual/integration check (documented in the bean, not CI): an install from an
  older release, then `churn update --dry-run` must list `qbit-watch` as created,
  and `churn update` must bring it up.

### 6. Docs

- `README.md:56-69` and `docs/src/introduction.md:38-46`: replace "recreates
  only the dashboard container" with the reconcile behaviour (new/changed
  services applied, removed services pruned, pinned images untouched unless a
  release changes the pin).
- `docs/src/torrent.md` / `docs/src/server.md`: note that `churn update` may
  recreate gluetun's sidecars (the netns owner rule already documented at
  `docs/src/torrent.md:185`) and that one-shots re-run.
- `openwiki/installer/update-and-release.md`: update the "What gets updated"
  table, the handoff section and the "Dashboard update" steps.
- `plans/update-server.md`: its Non-goals list "Updating the torrent stack" and
  "Updating Jellyfin, Sonarr, Radarr..." — add a note that a later change
  (this bean) added reconcile-only stack updates that do not bump pinned tags.
- `--help` text for `update`, `--dashboard-only`, `--stacks`.

## Out of scope

- Bumping the pinned app image tags (Jellyfin, Sonarr, Radarr, qBittorrent,
  Prowlarr) — those still move deliberately.
- UI-facing changes; no dashboard/backend edits.
- `--check` reporting compose drift (could be a follow-up: it could reuse
  `up --dry-run` and exit 1 when anything would change).

## Follow-up (separate bean)

`compose::parse_ps` (`src/compose.rs:91`) does `serde_json::from_str` on the
whole output, but `docker compose ps --format json` emits **one JSON object per
line**. Any stack with more than one container makes it fail, which breaks
`existing_ports` (`src/main.rs:727`) and `compose_service_env`. One-line fix:
deserialize each non-empty line and collect the results.

## Acceptance criteria

- `sudo churn update` on an install created before `qbit-watch` existed results
  in a running `qbit-watch` container under the gluetun namespace.
- A service deleted from a released compose file is removed on update
  (`--remove-orphans`).
- A changed service is recreated; an unchanged one is not restarted.
- The torrent stack is never reconciled without the VPN isolation and default
  route gates passing first.
- `churn update --dry-run` lists the pending created/recreated/removed
  containers and starts nothing.
- `churn update --check` behaviour is unchanged.
- `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test` and
  `scripts/vpn-gate.sh` pass.
